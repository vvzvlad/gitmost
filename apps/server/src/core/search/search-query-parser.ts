// #529 Phase A — server-side query parser (the SINGLE source of query semantics).
//
// Clients (web-UI, MCP agent, public share) send a RAW query string plus flags
// (`match`, `mode`); ALL query interpretation happens HERE, so every consumer
// gets identical operator/phrase/morphology behaviour. The parser is PURE (no
// SQL, no DB) so it is exhaustively unit-testable; SearchService turns the parsed
// AST into a parameterized tsquery/predicate tree (never string-concatenated SQL).
//
// Grammar (A2):
//   - Whitespace splits tokens, but a double-quoted run is ONE token ("a b" is a
//     phrase). An unbalanced quote is dropped.
//   - A token is an OPERATOR token only when it STARTS with `+` or `-`, the
//     remainder is non-empty, and the remainder is not itself only operators.
//     `+`/`-` inside a token (`WB-MGE-30D86B`, `10.0.12.5`, `a:b`) is a LITERAL —
//     the token is a single term. A bare `-`/`+` is dropped.
//   - `"phrase"` → phrase term; `+"phrase"`/`-"phrase"` apply the operator to it.
//   - Positive terms (bare + phrase, no operator) form the OR recall set.
//     `+term` is a REQUIRED predicate, `-term` an EXCLUDED predicate (A2): both
//     are applied in SQL WHERE against the whole candidate set, not folded into
//     the positive tsquery.
//   - Only-negation (no positive term) short-circuits to an empty result with
//     reason `only-negation` (never runs a costly NOT-scan).

export type SearchMatchMode = 'auto' | 'word' | 'prefix' | 'substring';
export type SearchBooleanMode = 'or' | 'and';

// Hard cap on the total number of parsed terms (positive + required + excluded).
// SearchService folds each FTS term into a LEFT-NESTED SQL tsquery expression
// `(((t1)||(t2))||(t3))…`, embedded several times per query — so nesting depth
// grows with the term count. A pasted text block (thousands of words) would nest
// deep enough to blow Postgres' `stack depth limit` → an ERROR → HTTP 500 for the
// caller. Capping in the parser bounds that depth for EVERY consumer (web / MCP /
// share), since they all route through here. 64 comfortably covers any real query
// while keeping the SQL nesting shallow. Overflow terms (beyond the first 64, in
// stable order) are dropped rather than throwing.
export const MAX_PARSED_TERMS = 64;

// How a single term is matched against the index.
//   - 'fts'       : full-text lexeme, exact (no trailing prefix).
//   - 'ftsPrefix' : full-text lexeme with a `:*` prefix match.
//   - 'phrase'    : an adjacency phrase (phraseto_tsquery).
//   - 'substring' : a literal LOWER(f_unaccent(col)) LIKE '%needle%' branch
//                   (identifiers the tokenizer mangles: IPs, hostnames, IDs).
export type SearchTermBranch = 'fts' | 'ftsPrefix' | 'phrase' | 'substring';

export interface ParsedTerm {
  // The user-visible term text, operator stripped, quotes removed. This is what
  // `matchedTerms` echoes back per hit.
  text: string;
  branch: SearchTermBranch;
}

export interface ParsedQuery {
  raw: string;
  // OR-recall set (bare + phrase terms with no operator).
  positive: ParsedTerm[];
  // AND predicates (`+term`) — the candidate MUST match each of these.
  required: ParsedTerm[];
  // NOT predicates (`-term`) — the candidate must match NONE of these.
  excluded: ParsedTerm[];
  mode: SearchBooleanMode;
  // Set only when the query yields no positive recall: 'empty' (nothing usable)
  // or 'only-negation' (there were exclusions but no positive term).
  reason?: 'empty' | 'only-negation';
}

interface RawToken {
  op: '' | '+' | '-';
  kind: 'word' | 'phrase';
  text: string;
}

// tsquery metacharacters that must never reach to_tsquery from a bare term — they
// are what turned adversarial input into a 500 before (#139). Stripped for the FTS
// branch; the substring branch keeps them (they are literal there).
const TSQUERY_META = /[:&|!()*<>\\]+/g;

// A term is "identifier-like" when it carries a digit or one of . _ : / - AND is
// not purely alphabetic (letters only). Such tokens (192.0.2, esp32,
// WB-MGE-30D86B) are mangled by the FTS tokenizer, so `match: auto` routes them
// to the substring branch. A purely-alphabetic word (печат, ресторан) stays FTS.
const IDENTIFIER_SIGNAL = /[0-9._:/\\-]/;
const PURELY_ALPHA = /^\p{L}+$/u;

function isIdentifierLike(text: string): boolean {
  return IDENTIFIER_SIGNAL.test(text) && !PURELY_ALPHA.test(text);
}

// Clean a bare term for the FTS branch: NFC-normalize, drop tsquery metacharacters
// and collapse whitespace. Returns '' when nothing usable remains.
export function cleanFtsLexeme(raw: string): string {
  return (raw ?? '')
    .normalize('NFC')
    .replace(TSQUERY_META, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split a raw query into tokens, honouring double quotes and a single leading
// +/- operator. Unbalanced quotes and bare operators are dropped.
function tokenize(raw: string): RawToken[] {
  const tokens: RawToken[] = [];
  const s = raw ?? '';
  let i = 0;
  const n = s.length;

  const isSpace = (c: string) => /\s/.test(c);

  while (i < n) {
    // Skip leading whitespace.
    while (i < n && isSpace(s[i])) i++;
    if (i >= n) break;

    let op: '' | '+' | '-' = '';
    // A single leading +/- is a tentative operator. Only ONE leading operator is
    // consumed; a second (`--x`) leaves `-x` as the remainder (a literal dash).
    if (s[i] === '+' || s[i] === '-') {
      op = s[i] as '+' | '-';
      i++;
    }

    if (i < n && s[i] === '"') {
      // Quoted phrase: read until the closing quote.
      const close = s.indexOf('"', i + 1);
      if (close === -1) {
        // Unbalanced quote → drop this token and everything the open quote would
        // have consumed (the rest of the string).
        break;
      }
      const phrase = s.slice(i + 1, close);
      i = close + 1;
      if (phrase.trim().length > 0) {
        tokens.push({ op, kind: 'phrase', text: phrase.trim() });
      }
      continue;
    }

    // Bare word: read until the next whitespace.
    let j = i;
    while (j < n && !isSpace(s[j])) j++;
    const word = s.slice(i, j);
    i = j;

    // A bare operator (`-`/`+` with no remainder) or an all-operator remainder is
    // dropped.
    if (word.length === 0) continue;
    if (op && /^[+-]+$/.test(word)) continue;

    tokens.push({ op, kind: 'word', text: word });
  }

  return tokens;
}

// Resolve the match branch for a single term given the global match mode.
function branchForTerm(
  text: string,
  kind: 'word' | 'phrase',
  mode: SearchMatchMode,
): SearchTermBranch {
  if (kind === 'phrase') return 'phrase';
  switch (mode) {
    case 'word':
      return 'fts';
    case 'prefix':
      return 'ftsPrefix';
    case 'substring':
      return 'substring';
    case 'auto':
    default:
      // Identifiers the tokenizer mangles go to substring; words get a prefix
      // FTS match (so `печат` still finds `печатать`, but `печат` no longer drags
      // in `впечатления` because the russian stemmer anchors the stem).
      return isIdentifierLike(text) ? 'substring' : 'ftsPrefix';
  }
}

/**
 * Parse a raw user query + flags into a structured, SQL-agnostic AST.
 * Pure and total: never throws, always returns a ParsedQuery.
 */
export function parseSearchQuery(
  raw: string,
  opts: { match?: SearchMatchMode; mode?: SearchBooleanMode } = {},
): ParsedQuery {
  const match: SearchMatchMode = opts.match ?? 'auto';
  const mode: SearchBooleanMode = opts.mode ?? 'or';

  const positive: ParsedTerm[] = [];
  const required: ParsedTerm[] = [];
  const excluded: ParsedTerm[] = [];

  for (const tok of tokenize(raw)) {
    // For an FTS branch, the token must survive metacharacter cleaning; for the
    // substring/phrase branch the literal text is used. A term that cleans to
    // nothing AND is not usable as a substring is dropped.
    const branch = branchForTerm(tok.text, tok.kind, match);

    let usableText: string;
    if (branch === 'fts' || branch === 'ftsPrefix') {
      usableText = cleanFtsLexeme(tok.text);
    } else {
      // phrase / substring keep the literal (trimmed) text.
      usableText = tok.text.trim();
    }
    if (!usableText) continue;

    // Stack-depth guard: stop after MAX_PARSED_TERMS surviving terms (positive +
    // required + excluded, combined) so the SQL tsquery nesting stays shallow.
    // The first 64 terms are kept in stable order; the rest are dropped.
    if (positive.length + required.length + excluded.length >= MAX_PARSED_TERMS) {
      break;
    }

    const term: ParsedTerm = { text: usableText, branch };

    if (tok.op === '+') required.push(term);
    else if (tok.op === '-') excluded.push(term);
    else positive.push(term);
  }

  const parsed: ParsedQuery = { raw: raw ?? '', positive, required, excluded, mode };

  if (positive.length === 0) {
    // Required terms with no positive recall still form a valid positive set (the
    // required predicates ARE the recall). Only when there is neither a positive
    // nor a required term is the query empty / only-negation.
    if (required.length === 0) {
      parsed.reason = excluded.length > 0 ? 'only-negation' : 'empty';
    }
  }

  return parsed;
}

/**
 * Does this parsed query have any positive recall to run? False means we must
 * short-circuit to an empty result (with `reason`), never a costly NOT-only scan.
 */
export function hasPositiveRecall(parsed: ParsedQuery): boolean {
  return parsed.positive.length > 0 || parsed.required.length > 0;
}
