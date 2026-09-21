/**
 * Shared inline-math boundary rule (#293 canon #6).
 *
 * Pandoc's inline-math rule lives here because it is used in TWO directions that
 * MUST agree byte-for-byte on which `$…$` spans are math:
 *
 *   - the IMPORT tokenizer (markdown-to-prosemirror.ts) that turns `$LaTeX$`
 *     into a `mathInline` node, and
 *   - the EXPORT escaper (markdown-converter.ts) that backslash-escapes a
 *     would-be-math `$…$` span sitting in PROSE text so it re-imports as literal
 *     text instead of silently materializing a phantom math node.
 *
 * Defining the rule ONCE guarantees the two directions never drift: a span the
 * tokenizer would match is EXACTLY a span the escaper neutralizes, so a prose
 * `$x$` round-trips as literal text and math `$x^2$` round-trips as math.
 *
 * The rule (currency-safe, from pandoc): an opening `$` is NOT followed by
 * whitespace; the closing `$` is NOT preceded by whitespace AND NOT immediately
 * followed by a digit; the inner run is non-empty, single-line, and may embed an
 * escaped `\$` (which never counts as the closer). Under this rule `$5`,
 * `$5 and $10`, `price is $5`, `a $5 b $6 c` all stay literal (no VALID closing
 * `$` exists — the `$` before a space-preceded amount fails the "not preceded by
 * whitespace" test, and a lone `$` has no closer), while `$x^2$` is math.
 */

// Core pattern (unanchored). Escaping note for the string form:
//   \\$        -> a literal `$`
//   (?!\s)     -> opening `$` NOT followed by whitespace (also forces a
//                 non-empty inner: the next char must exist and be non-space)
//   (?:\\\\\\$|[^$\n])+?  -> inner: shortest run of either an escaped `\$`
//                 (consumed as a unit so it is never the closer) or any char
//                 that is neither an unescaped `$` nor a newline
//   (?<!\s)    -> the char before the closing `$` is NOT whitespace
//   \\$        -> closing `$`
//   (?![0-9])  -> closing `$` NOT immediately followed by a digit (currency)
export const INLINE_MATH_SOURCE =
  "\\$(?!\\s)((?:\\\\\\$|[^$\\n])+?)(?<!\\s)\\$(?![0-9])";

/** Global matcher for the export-side prose escaper. */
export const inlineMathGlobalRe = (): RegExp =>
  new RegExp(INLINE_MATH_SOURCE, "g");

/** Anchored matcher for the import-side marked tokenizer. */
export const inlineMathAnchoredRe = (): RegExp =>
  new RegExp("^" + INLINE_MATH_SOURCE);

/** Decode a tokenizer-captured inner LaTeX: an escaped `\$` becomes `$`. */
export const decodeInlineMathLatex = (inner: string): string =>
  inner.replace(/\\\$/g, "$");

/** Escape LaTeX for the `$…$` inline form so a literal `$` cannot close early. */
export const encodeInlineMathLatex = (latex: string): string =>
  latex.replace(/\$/g, "\\$");

/**
 * Whether a `mathInline` node's LaTeX can be safely serialized as `$LaTeX$`
 * (vs. the always-lossless schema-HTML `<span>` fallback). Requires:
 *   - non-empty (an empty span has no readable `$…$` form),
 *   - non-whitespace edges (pandoc's opening/closing whitespace rules),
 *   - single line (inline math never spans lines),
 *   - no pre-existing `\$` and no trailing `\` — either would make the
 *     `$`→`\$` escape ambiguous on decode (a `\\$` sequence, or an escaped
 *     closing `$`), so those rare cases take the `<span>` fallback instead.
 * NOTE: a following-sibling digit (which would also break the pandoc closing
 * rule) cannot be seen from the node alone; that case is handled by the
 * serializer's inline-children pass, not here.
 */
export const inlineMathSerializable = (latex: string): boolean =>
  latex.length > 0 &&
  !/^\s/.test(latex) &&
  !/\s$/.test(latex) &&
  !/[\r\n]/.test(latex) &&
  !latex.includes("\\$") &&
  !/\\$/.test(latex);

/** Escape a value for an HTML double-quoted attribute (only & and " matter). */
export const escapeMathAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
