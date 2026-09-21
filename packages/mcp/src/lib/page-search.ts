/**
 * Pure, network-free in-page search over a ProseMirror/TipTap document tree.
 *
 * `searchInDoc(doc, query, opts)` finds every occurrence of a literal substring
 * (default) or a regular expression across the page's TEXT CONTAINERS and
 * reports WHERE each match is — the container's ref (for getNode/patchNode;
 * see the SearchMatch.nodeId note for the `#<index>` caveat), the top-level
 * block index, and a short context window around the hit. It never touches the
 * network, the DB, or the schema mirror; like `comment-anchor.ts` it is
 * isolated-testable.
 *
 * REGEX ENGINE: with `regex:true` the pattern is compiled with RE2 (Google's
 * linear-time engine), NOT the JS `RegExp`. RE2 has no backtracking, so a
 * catastrophic pattern (e.g. `(a+)+$`) can never wedge the shared event loop —
 * it runs in linear time. The trade-off is that RE2 does not support the
 * backtracking-only features lookaround (`(?=…)`, `(?<=…)`) and backreferences
 * (`\1`); such a pattern is rejected up front with a clear tool error (see
 * searchInDoc) rather than being run, which is the desired behaviour — a clear
 * error the agent can fix beats a server hang.
 *
 * WHY plain text (not markdown): each container's inline text is glued into ONE
 * string via `blockPlainText`, so a match survives inline-mark boundaries
 * (bold/italic/link splits that fracture a run like "т.е." into several text
 * nodes) and comment-anchor spans never clutter the haystack.
 *
 * The SEARCH UNIT is a text container: a node whose direct children include
 * text nodes (a paragraph/heading, or the paragraph inside a table cell / list
 * item). ProseMirror keeps block vs. inline content exclusive, so a container
 * never nests another container — the walk reaches each cell/item's own text and
 * the context window is naturally scoped to that specific cell/item, not the
 * whole top-level block's glued text.
 */

import RE2 from "re2";

import { blockPlainText, foldInvisibles } from "@docmost/prosemirror-markdown";

/** An RE2 regex instance (RE2 extends `RegExp`, so it is usable as one). */
type Re2Regex = InstanceType<typeof RE2>;

/** True if `value` is a non-null plain object (and not an array). */
function isObject(value: any): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A text container is a node with a `content` array holding at least one text
 * node (a child with a string `text`). These are the paragraphs/headings whose
 * glued inline text we search.
 */
function isTextContainer(node: any): boolean {
  return (
    isObject(node) &&
    Array.isArray(node.content) &&
    node.content.some((c: any) => isObject(c) && typeof c.text === "string")
  );
}

/** Options controlling the search engine and result size. */
export interface SearchOptions {
  /** Treat `query` as a RegExp instead of a literal substring (default false). */
  regex?: boolean;
  /** Case-sensitive matching (default false). */
  caseSensitive?: boolean;
  /** Max matches to RETURN (default 50, clamped to [1, 200]); total is unbounded. */
  limit?: number;
}

/** One located occurrence. */
export interface SearchMatch {
  /**
   * The container's ref, for addressing the block with getNode/patchNode: its
   * `attrs.id` when it has one, otherwise `#<topLevelIndex>` of the nearest
   * top-level block. Table-cell/list-item paragraphs that carry no id fall back
   * to the `#<index>` form.
   *
   * CAVEAT: the `#<index>` form is accepted by getNode (getNodeByRef resolves
   * it by top-level index) but NOT by patchNode (replaceNodeById resolves only
   * by `attrs.id`), so id-less table/cell content can be READ by this ref but
   * not PATCHED by it.
   *
   * To anchor a comment, do NOT pass this ref to createComment — it has no
   * nodeId parameter. A top-level comment needs an exact-text `selection` that
   * occurs once on the page (it fails if the text isn't found), so build a
   * UNIQUE `selection` from before+match+after and pass THAT as createComment's
   * `selection`.
   */
  nodeId: string;
  /** The top-level block index (as in getOutline). */
  blockIndex: number;
  /** The container node's type (paragraph/heading/...). */
  type: string | undefined;
  /** ~40 chars of context immediately before the match (from THIS container). */
  before: string;
  /** The matched text. */
  match: string;
  /** ~40 chars of context immediately after the match (from THIS container). */
  after: string;
  /**
   * LITERAL mode only (#659): present and `true` IFF the invisible-fold actually
   * changed the matched DOCUMENT fragment — i.e. `match` (the original substring)
   * contains removed/collapsed invisibles (soft hyphen, NBSP, zero-width chars,
   * a whitespace run) so it differs from its folded form. Independent of case:
   * a hit that differs from the query only by letter case does NOT get `folded`.
   * Omitted on plain matches (byte-identical to pre-#659 output) and in regex
   * mode (which never folds).
   */
  folded?: boolean;
}

/** The search result. `truncated` is true when `total > matches.length`. */
export interface SearchResult {
  total: number;
  truncated: boolean;
  matches: SearchMatch[];
}

// Result-size defaults/ceiling.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Context window on each side of a match.
const CONTEXT = 40;

// Cheap sanity cap on the query/pattern length. ReDoS is handled structurally
// by the RE2 engine (linear-time, no backtracking — see the module doc), so we
// no longer truncate the per-container text: RE2 scans it in linear time and a
// cap could silently drop real matches past it. This just rejects an absurdly
// long pattern early with a clear error.
const MAX_PATTERN_LENGTH = 1000;

/** Clamp the requested limit into [1, MAX_LIMIT], defaulting when absent. */
function resolveLimit(limit: number | undefined): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? limit : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/**
 * Yield `[start, length, folded]` for every occurrence of the engine in `text`,
 * in order — offsets index the ORIGINAL `text` and `folded` is true only when
 * the invisible-fold changed the matched fragment (literal mode only).
 *
 * A regex engine uses a global RE2 regex (RE2 extends `RegExp`, so `.exec`
 * advances `lastIndex` exactly like the native engine); it does NOT fold and
 * never sets `folded`. Zero-length regex matches (e.g. `\b`, `a*`) are SKIPPED
 * and lastIndex is advanced, so a pattern that can match the empty string cannot
 * flood the results or spin forever.
 *
 * LITERAL engine (#659): folds invisibles on BOTH sides so a needle matches
 * across soft hyphens, NBSP, zero-width chars and collapsed whitespace runs —
 * exactly like editPageText's fold tier (json-edit.ts). It folds `text` into
 * `{ folded, map }` (via the shared `foldInvisibles` canon), searches the FOLDED
 * (and, when case-insensitive, case-folded) space with indexOf using the caller-
 * folded `foldQuery`, then maps each folded hit at [fi, fi+flen) back to the
 * ORIGINAL range [map[fi], map[fi+flen)) — the SAME folded->original offset
 * mapping comment-anchor's findAnchorInBlock uses (end-boundary clamps to
 * `text.length` when the match reaches the string end). Offsets are into the
 * ORIGINAL text so the reported match/context keep the document's real casing
 * and invisible characters (needed to build a unique createComment selection).
 * `folded` is true iff the original matched fragment differs from its own fold
 * (it held removed/collapsed invisibles) — independent of case.
 */
function* eachMatch(
  text: string,
  foldQuery: string,
  re: Re2Regex | null,
  caseSensitive: boolean,
): Generator<[number, number, boolean]> {
  if (re) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const len = m[0].length;
      if (len === 0) {
        // Empty match: advance past this position and do not record it.
        re.lastIndex = m.index + 1;
        continue;
      }
      yield [m.index, len, false];
    }
    return;
  }

  // Literal engine with invisible-fold. Fold the haystack once; `foldQuery` is
  // already folded by the caller. For case-insensitive search, case-fold BOTH
  // folded strings only to LOCATE the indices; the reported match/context are
  // sliced from the ORIGINAL text via the fold map so the caller gets the real
  // casing AND the original invisible characters.
  const { folded: hayFolded, map } = foldInvisibles(text);
  const haystack = caseSensitive ? hayFolded : hayFolded.toLowerCase();
  const needle = caseSensitive ? foldQuery : foldQuery.toLowerCase();
  const flen = needle.length;
  let from = 0;
  for (;;) {
    const fi = haystack.indexOf(needle, from);
    if (fi === -1) return;
    // Map the folded range [fi, fi+flen) back to the original range [oi, oj).
    const oi = map[fi];
    const oj = fi + flen < map.length ? map[fi + flen] : text.length;
    // The fold changed the matched DOCUMENT fragment iff the original substring
    // differs from its own fold (removed/collapsed invisibles inside it). This
    // is independent of case — foldInvisibles never touches letter case.
    const frag = text.slice(oi, oj);
    const folded = foldInvisibles(frag).folded !== frag;
    yield [oi, oj - oi, folded];
    // Advance in FOLDED space so occurrences are non-overlapping (no exact-vs-
    // fold double counting — a single folded pass finds plain matches too).
    from = fi + flen;
  }
}

/**
 * Search a ProseMirror document for `query` and return `{ total, truncated,
 * matches }`. `total` counts EVERY occurrence (even beyond the limit) and
 * `truncated` flags when the returned list was capped — nothing is silently
 * dropped.
 *
 * Throws a clear, model-actionable error (never a generic failure) on: an
 * empty/whitespace-only query, an over-long pattern, or — with `regex:true` — a
 * pattern RE2 rejects (invalid syntax, or the unsupported lookaround/
 * backreference features), so the agent can fix its input.
 */
export function searchInDoc(
  doc: any,
  query: string,
  opts: SearchOptions = {},
): SearchResult {
  // --- edge-case guards (fail loudly so the agent can correct the call) ---
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error(
      "searchInPage: query is empty — pass the text (or regex) to look for.",
    );
  }
  if (query.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `searchInPage: query is too long (${query.length} chars; max ${MAX_PATTERN_LENGTH}). Shorten the search text/pattern.`,
    );
  }

  const caseSensitive = opts.caseSensitive === true;
  const limit = resolveLimit(opts.limit);

  // LITERAL mode (#659): fold invisibles on the query once, up front, so it can
  // match through soft hyphens / NBSP / zero-width chars / collapsed whitespace
  // runs — consistent with editPageText (#658). Regex mode never folds (folding
  // would break RE2 offsets, char classes and group semantics), so foldQuery is
  // unused there.
  let foldQuery = "";
  if (opts.regex !== true) {
    foldQuery = foldInvisibles(query).folded;
    // Empty fold-guard: a query made only of invisible/whitespace chars folds to
    // empty (or a lone space) and would otherwise match every space; reject it
    // via the SAME error as a raw-empty query so the agent gets one clear signal.
    if (foldQuery.length === 0 || foldQuery === " ") {
      throw new Error(
        "searchInPage: query is empty — pass the text (or regex) to look for.",
      );
    }
  }

  // Compile the pattern up front with RE2 (linear-time, ReDoS-safe) so a bad
  // pattern is a clean tool error rather than a failure deep in the traversal —
  // and so a catastrophic-backtracking pattern can never wedge the event loop.
  // RE2 throws both on syntactically invalid input AND on backtracking-only
  // features it does not implement (lookaround, backreferences); both map to the
  // same actionable error so the agent rewrites the pattern.
  let re: Re2Regex | null = null;
  if (opts.regex === true) {
    try {
      re = new RE2(query, caseSensitive ? "g" : "gi");
    } catch (e) {
      throw new Error(
        `searchInPage: invalid or unsupported regular expression: ${
          e instanceof Error ? e.message : String(e)
        } — RE2 does not support lookaround ((?=…)/(?<=…)) or backreferences (\\1); rewrite the pattern without them.`,
      );
    }
  }

  const matches: SearchMatch[] = [];
  let total = 0;

  const topLevel =
    isObject(doc) && Array.isArray(doc.content) ? doc.content : [];

  // Descend a top-level block, collecting matches from every text container
  // within it. blockIndex/topRef stay pinned to the enclosing top-level block.
  const descend = (node: any, blockIndex: number, topRef: string): void => {
    if (!isObject(node)) return;

    if (isTextContainer(node)) {
      // Glue this container's inline text into one string (mark-safe). No length
      // cap: RE2 scans it in linear time (no ReDoS) and the whole document is
      // already in memory, so truncating would only risk dropping real matches
      // in a very long container.
      const text = blockPlainText(node);

      // The container's own id addresses it verbatim in getNode/patchNode; a
      // container with no id (e.g. a table-cell paragraph) falls back to the
      // top-level block's #<index> (readable via getNode, but not patchable —
      // see the SearchMatch.nodeId note).
      const id =
        isObject(node.attrs) && typeof node.attrs.id === "string" && node.attrs.id.length > 0
          ? node.attrs.id
          : topRef;

      for (const [idx, len, folded] of eachMatch(
        text,
        foldQuery,
        re,
        caseSensitive,
      )) {
        total++;
        if (matches.length < limit) {
          const hit: SearchMatch = {
            nodeId: id,
            blockIndex,
            type: node.type,
            before: text.slice(Math.max(0, idx - CONTEXT), idx),
            match: text.slice(idx, idx + len),
            after: text.slice(idx + len, idx + len + CONTEXT),
          };
          // Additive flag: only when the fold actually changed the matched
          // fragment (omit on plain matches so they stay byte-identical to
          // pre-#659 output).
          if (folded) hit.folded = true;
          matches.push(hit);
        }
      }
      // A text container holds inline content only — no nested containers to
      // recurse into.
      return;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) descend(child, blockIndex, topRef);
    }
  };

  for (let i = 0; i < topLevel.length; i++) {
    descend(topLevel[i], i, `#${i}`);
  }

  return { total, truncated: total > matches.length, matches };
}
