/**
 * Locator normalization: strip inline markdown wrappers and trailing
 * decoration from a LOCATOR string so a find/anchor that the model wrote with
 * markdown (or a stray emoji) can still match the document's plain text.
 *
 * This is used ONLY as a fallback for LOCATING (after an exact match fails);
 * it is never applied to replacement text or inserted node content, so no
 * formatting is ever lost.
 *
 * CANONICAL HOME (#414/#493): this is the single source of truth for locator
 * markdown-stripping. `node-ops.ts` (which lives here) uses it directly, and the
 * mcp-side `text-normalize.ts` now IMPORTS `stripInlineMarkdown` and the shared
 * `stripWrappersAndLinks` primitive from here (via `@docmost/prosemirror-markdown`)
 * instead of keeping a drifting copy — mcp only adds its own thin
 * `stripBalancedWrappers`/`closestBlockHint` on top.
 */

/** Maximum unwrap passes, so pathological/nested input cannot loop forever. */
const MAX_PASSES = 8;

/**
 * Inline emphasis/code/strikethrough wrappers, strong BEFORE emphasis so
 * `**x**` collapses to `x` rather than leaving a stray `*x*`. Each pattern is
 * non-greedy and capture group 1 is the inner text. Applied repeatedly until
 * the string stops changing (nested wrappers like `**_x_**`).
 */
const WRAPPER_PATTERNS: RegExp[] = [
  /\*\*([^*]+?)\*\*/g, // **x**
  /__([^_]+?)__/g, // __x__
  /~~([^~]+?)~~/g, // ~~x~~
  /\*([^*]+?)\*/g, // *x*
  /_([^_]+?)_/g, // _x_
  /``([^`]+?)``/g, // ``x``
  /`([^`]+?)`/g, // `x`
];

/**
 * Links/images -> their visible text: `[text](url)` -> `text`, `![alt](src)` ->
 * `alt`. A boolean/string equivalent of `/!?\[([^\]]*)\]\([^)]*\)/g` with `"$1"`,
 * written as a single left-to-right pass. The regex is O(n^2) on a long run of
 * unmatched `[` (each `[` restarts the `[^\]]*` scan and backtracks), so an
 * agent-supplied `replace` of `"[".repeat(100000)` fed through
 * `stripBalancedWrappers` would block the event loop for seconds. This scanner
 * never re-scans: on a `[` that cannot complete a link it jumps `i` past the
 * first `]` (no `[` before it can form a link either), and a missing `]`/`)`
 * short-circuits the rest — so it is O(n) on every input.
 */
function stripLinks(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const bracket =
      s[i] === "!" && s[i + 1] === "[" ? i + 1 : s[i] === "[" ? i : -1;
    if (bracket === -1) {
      out += s[i];
      i++;
      continue;
    }
    const close = s.indexOf("]", bracket + 1);
    if (close === -1) {
      // No `]` anywhere after this `[` — no link can start here or later.
      out += s.slice(i);
      break;
    }
    if (s[close + 1] === "(") {
      const rparen = s.indexOf(")", close + 2);
      if (rparen === -1) {
        // `](` with no closing `)` anywhere after — no link can complete.
        out += s.slice(i);
        break;
      }
      out += s.slice(bracket + 1, close); // the visible text ($1)
      i = rparen + 1;
      continue;
    }
    // `[...]` present but not followed by `(...)`: not a link. Emit up to and
    // including this `]` — no `[` in this span can form a link (its first `]`
    // is this one, which isn't followed by a matched `(...)`).
    out += s.slice(i, close + 1);
    i = close + 1;
  }
  return out;
}

/**
 * Apply the two balanced/link passes: first collapse links/images to their
 * visible text, then collapse balanced inline wrappers repeatedly until stable.
 * Does NOT trim decoration, does NOT guard against an empty result — it returns
 * exactly the transformed string.
 */
export function stripWrappersAndLinks(s: string): string {
  // 1. Links/images -> their visible text (linear, see stripLinks).
  let out = stripLinks(s);

  // 2. Strip balanced wrappers, repeating until the string is stable so nested
  //    wrappers (`**_x_**`) and adjacent runs both collapse.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = out;
    for (const re of WRAPPER_PATTERNS) {
      out = out.replace(re, "$1");
    }
    if (out === before) break;
  }
  return out;
}

/**
 * Conservatively strip inline markdown from a locator string.
 *
 * Deterministic, order-fixed steps:
 *  1. Links/images: `[text](url)` -> `text`, `![alt](src)` -> `alt`.
 *  2. Balanced inline wrappers (strong before emphasis, code, strikethrough),
 *     applied repeatedly until stable for nested cases.
 *  3. Trim leading/trailing decoration only: whitespace, leftover marker chars
 *     (`* _ ~ \``) and emoji. Letters/digits and sentence punctuation (`.`/`,`
 *     etc.) are NEVER trimmed.
 *
 * If the result is empty (e.g. the input was only markers like `***`), the
 * ORIGINAL string is returned so a locator can never normalize down to "" and
 * match everything.
 */
export function stripInlineMarkdown(s: string): string {
  if (typeof s !== "string" || s.length === 0) return s;

  // 1 + 2. Shared link/image and balanced-wrapper passes.
  let out = stripWrappersAndLinks(s);

  // 3. Trim leading/trailing decoration: whitespace, leftover markdown markers,
  //    and emoji (Extended_Pictographic plus the VS16 / ZWJ joiners, plus the
  //    regional-indicator range U+1F1E6–U+1F1FF for flag emoji, which are NOT
  //    Extended_Pictographic). The `u` flag enables the Unicode property escape.
  //    Anchored runs only — interior text and sentence punctuation are untouched.
  const DECORATION =
    "[\\s*_~\\x60\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}\\u{FE0F}\\u{200D}]+";
  out = out
    .replace(new RegExp("^" + DECORATION, "u"), "")
    .replace(new RegExp(DECORATION + "$", "u"), "");

  // 4. Never normalize a locator down to nothing.
  if (out.length === 0) return s;

  return out;
}

/* ─────────────────────────── Fold canon (#658) ─────────────────────────────
 * The single source of truth (R3) for the character-class tables the matching
 * layer (mcp editPageText / createComment / footnote-normalize-merge) folds
 * before comparing. TWO independent whitespace classifications live here on
 * purpose:
 *   - LEGACY_SPACE — byte-identical to the historic anchor-normalizer whitespace
 *     predicate (JS `\s`, which already includes NBSP and U+FEFF). The
 *     createComment pass-1 anchor + footnote merge are rebuilt from it so their
 *     golden behaviour is preserved exactly.
 *   - FOLD_DELETE / FOLD_SPACE — the new self-healing classes: zero-width / join
 *     control chars are DELETED and non-breaking / special spaces are FOLDED to a
 *     single normal space, so a `find` that differs from the document only by
 *     invisible characters still localizes.
 * Note U+FEFF (BOM / ZWNBSP) deliberately moves from LEGACY_SPACE (a space) to
 * FOLD_DELETE (invisible junk) in the fold classes only.
 */

/** Typographic double-quote variants mapped to ASCII `"`. */
export const DOUBLE_QUOTES = "«»„“”‟〝〞＂";
/** Typographic single-quote/apostrophe variants mapped to ASCII `'`. */
export const SINGLE_QUOTES = "‘’‚‛";
/** Dash variants mapped to ASCII `-`. */
export const DASHES = "–—―−‐‑‒";

/** Invisible chars removed entirely before matching (fold classes only). */
const FOLD_DELETE_SET = new Set<string>([
  "\u00AD", // SHY  soft hyphen
  "\u200B", // ZWSP zero-width space
  "\u200C", // ZWNJ zero-width non-joiner
  "\u200D", // ZWJ  zero-width joiner
  "\u2060", // WJ   word joiner
  "\uFEFF", // BOM / ZWNBSP
]);

/** Non-breaking / special spaces folded to a normal space (NBSP family). */
const NBSP_FAMILY_SET = new Set<string>([
  "\u00A0", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005",
  "\u2006", "\u2007", "\u2008", "\u2009", "\u200A", "\u202F", "\u205F",
  "\u3000",
]);

/** Explicit legacy spaces (all in JS `\s`; listed for cross-engine determinism). */
const LEGACY_EXPLICIT_SET = new Set<string>([
  "\u00A0", "\u2007", "\u202F", "\u2009", "\u200A", "\u2002", "\u2003",
]);

/** True for a character the FOLD classes delete outright (before run-collapse). */
export function isFoldDelete(ch: string): boolean {
  return FOLD_DELETE_SET.has(ch);
}

/** True for a character the FOLD classes collapse to a single normal space. */
export function isFoldSpace(ch: string): boolean {
  if (FOLD_DELETE_SET.has(ch)) return false;
  return /\s/.test(ch) || NBSP_FAMILY_SET.has(ch);
}

/**
 * True for the HISTORIC anchor-normalizer whitespace class — equivalent to the
 * old `isWhitespaceChar` (JS `\s` plus the explicit NBSP family). Kept distinct
 * from the fold classes: U+FEFF stays a SPACE here (legacy) but is DELETED in
 * the fold classes. comment-anchor's `normalizeForMatch` is rebuilt from this.
 */
export function isLegacySpace(ch: string): boolean {
  return /\s/.test(ch) || LEGACY_EXPLICIT_SET.has(ch);
}

/**
 * Shared fold core. Deletes FOLD_DELETE chars (transparent — a delete inside a
 * whitespace run does not break the run), collapses every FOLD_SPACE run to a
 * SINGLE space mapped to the run's first raw index, and copies every other
 * character through (atoms U+FFFC included — they are neither folded nor
 * whitespace). When `mapGlyphs`, typographic quotes/dashes are also mapped to
 * ASCII (1:1, so the index map is preserved). `map[i]` is the source index of
 * the i-th folded character.
 */
function foldWith(
  s: string,
  mapGlyphs: boolean,
): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (isFoldDelete(ch)) {
      // delete-first: transparent to a surrounding run, emits nothing on its own.
      i++;
      continue;
    }
    if (isFoldSpace(ch)) {
      const runStart = i;
      i++;
      // A run continues through further fold-spaces AND transparent deletes, so
      // "␣SHY␣" is ONE run -> one space.
      while (i < n && (isFoldSpace(s[i]) || isFoldDelete(s[i]))) i++;
      folded += " ";
      map.push(runStart);
      continue;
    }
    let mapped = ch;
    if (mapGlyphs) {
      if (DOUBLE_QUOTES.indexOf(ch) !== -1) mapped = '"';
      else if (SINGLE_QUOTES.indexOf(ch) !== -1) mapped = "'";
      else if (DASHES.indexOf(ch) !== -1) mapped = "-";
    }
    folded += mapped;
    map.push(i);
    i++;
  }
  return { folded, map };
}

/**
 * Fold invisible characters only: delete FOLD_DELETE chars, collapse FOLD_SPACE
 * runs to a single space. No quotes/dashes/case folding. `map[i]` is the source
 * index of the i-th folded character.
 */
export function foldInvisibles(s: string): { folded: string; map: number[] } {
  return foldWith(s, false);
}

/**
 * `foldInvisibles` PLUS typographic quote/dash normalization to ASCII. Used for
 * DIAGNOSTICS only (detecting a "differs only in typography" miss); never used
 * to auto-apply an edit, so wiki typography is never silently rewritten.
 */
export function foldTypography(s: string): { folded: string; map: number[] } {
  return foldWith(s, true);
}

/**
 * Escape table (canon, next to the fold tables). Applied ONLY to diagnostic
 * text — never to document data — so a miss message can quote the document with
 * its invisible characters made visible (e.g. `⟨SHY⟩`, `⟨NBSP⟩`, `⟨node⟩`).
 */
const ESCAPE_MAP: Record<number, string> = {
  0x00ad: "⟨SHY⟩",
  0x200b: "⟨ZWSP⟩",
  0x200c: "⟨ZWNJ⟩",
  0x200d: "⟨ZWJ⟩",
  0x2060: "⟨WJ⟩",
  0xfeff: "⟨BOM⟩",
  0x00a0: "⟨NBSP⟩",
  0x202f: "⟨NNBSP⟩",
  0xfffc: "⟨node⟩",
};

/**
 * Render invisible characters visible for a diagnostic quote. Known invisibles
 * map to a named tag; any other non-ASCII FOLD_SPACE char maps to `⟨U+XXXX⟩`;
 * everything else is passed through unchanged. NEVER apply this to data.
 */
export function escapeInvisibles(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const named = ESCAPE_MAP[cp];
    if (named !== undefined) {
      out += named;
      continue;
    }
    if (cp > 0x7f && isFoldSpace(ch)) {
      out += "⟨U+" + cp.toString(16).toUpperCase().padStart(4, "0") + "⟩";
      continue;
    }
    out += ch;
  }
  return out;
}
