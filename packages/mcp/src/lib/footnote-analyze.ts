/**
 * Legacy footnote advisory for imported Markdown (issue #166, reduced in #414).
 *
 * Since #293 STEP 5 the canonical import form is inline `^[body]` footnotes
 * (handled by `@docmost/prosemirror-markdown`). LEGACY reference-style
 * `[^id]: …` definition markup is now INERT on import — the importer leaves it as
 * literal text — so authoring it silently produces broken footnotes (the #410
 * incident class). Rather than the old, elaborate diagnostics of every problem
 * SHAPE (dangling/duplicate/empty/in-table) that no longer describe what the
 * importer builds, this module surfaces ONE advisory warning whenever legacy
 * reference-style definition syntax is present, nudging the author to the inline
 * form. It never changes the document — the importer still creates the page.
 *
 * The scan is fence-aware: a `[^id]:` line inside a ``` / ~~~ code block is
 * example text, not markup, so it never triggers the warning.
 */

/** A legacy footnote DEFINITION line: `[^id]:` at the start of a (non-fenced) line. */
const FOOTNOTE_DEF_RE = /^\[\^[^\]\s]+\]:/;
/** Opening/closing code fence marker (``` or ~~~). */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** The single advisory shown when legacy reference-style footnotes are present. */
export const LEGACY_FOOTNOTE_WARNING =
  "Reference-style footnotes (`[^id]: …`) are not parsed on import and will " +
  "appear as literal text. Use inline footnotes instead: `^[footnote text]`.";

/**
 * True when `markdown` contains a legacy `[^id]:` definition line OUTSIDE any
 * code fence. Pure; safe to call on any body.
 */
export function hasLegacyFootnoteDefinition(markdown: string): boolean {
  if (typeof markdown !== "string" || !markdown.includes("[^")) return false;
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker; // opening fence
      else if (marker === fence) fence = null; // matching closing fence
      continue;
    }
    if (fence !== null) continue; // inside a fence: inert example text
    if (FOOTNOTE_DEF_RE.test(line)) return true;
  }
  return false;
}

/**
 * The optional `footnoteWarnings` field for a page-write tool result: present
 * (with the single advisory) only when `markdown` uses legacy reference-style
 * footnote syntax, omitted otherwise. One helper so all three call sites
 * (create/update/import) attach the field identically. Spread into the result:
 * `{ ...result, ...footnoteWarningsField(text) }`.
 */
export function footnoteWarningsField(markdown: string): {
  footnoteWarnings?: string[];
} {
  return hasLegacyFootnoteDefinition(markdown)
    ? { footnoteWarnings: [LEGACY_FOOTNOTE_WARNING] }
    : {};
}
