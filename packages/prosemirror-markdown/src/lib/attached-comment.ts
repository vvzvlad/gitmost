/**
 * Attached-comment convention (#293 canon).
 *
 * Some block-level attributes have no native markdown syntax (paragraph/heading
 * `textAlign` — #9; image/media attrs — #4/#8). Rather than HTML-wrapping the
 * whole block (the old `<div align>` / `<p style>` forms, which the maintainer
 * had to patch repeatedly and which did not round-trip cleanly), we ATTACH a
 * compact HTML comment at the END of the block's rendered line:
 *
 *     Some paragraph text <!--attrs {"textAlign":"center"}-->
 *
 * The comment is invisible in any markdown renderer and is dropped by the
 * DOM/generateJSON import stage, so it can never leak into the document body.
 * The importer intercepts it BEFORE that stage (see markdown-to-prosemirror's
 * applyAttachedComments) and re-applies the encoded attributes to the node.
 *
 * This module holds the two PURE, reusable primitives of the convention so the
 * serializer, the parser, and future decisions (#4 image, #8 media) share ONE
 * implementation:
 *   - `attachedCommentFor(name, json)` — build the comment string.
 *   - `parseAttachedComment(data)`     — parse a comment node's data back.
 */

/**
 * A parsed attached comment: the leading `name` token and the decoded JSON
 * object payload (empty object when the comment carried no JSON body).
 */
export interface AttachedComment {
  name: string;
  attrs: Record<string, unknown>;
}

/**
 * Grammar of an attached comment's DATA (the text between `<!--` and `-->`):
 * a leading name token (`attrs`, `img`, …) optionally followed by whitespace
 * and a single JSON object. The name deliberately does NOT allow `:` so the
 * file-level envelope comments (`docmost:meta` / `docmost:comments`) never match
 * and stay inert here.
 */
const ATTACHED_COMMENT_RE = /^\s*([A-Za-z][\w-]*)(?:\s+(\{[\s\S]*\}))?\s*$/;

/**
 * Build an attached HTML comment `<!--name {compact-json}-->` for `json`.
 *
 * The JSON is emitted compactly (no spaces) via `JSON.stringify`. A string value
 * may legitimately contain two consecutive hyphens `--`, which would prematurely
 * close the HTML comment (`-->`). We defuse that WITHOUT changing the decoded
 * value: each hyphen of every `--` pair is rewritten as the JSON unicode escape
 * `-`, so `JSON.parse` on the reading side restores the exact original
 * hyphens. `--` can only occur inside a JSON string (structural JSON never
 * produces it), so a blanket replace over the stringified payload is safe.
 */
export function attachedCommentFor(name: string, json: object): string {
  return `<!--${name} ${escapeCommentJson(json)}-->`;
}

/**
 * Compactly stringify `json` and defuse any `--` pair so the payload can never
 * close the HTML comment early. Shared by `attachedCommentFor` (attached form)
 * and `standaloneCommentFor` (standalone form) so both stay in sync.
 *
 * A string value may legitimately contain two consecutive hyphens `--`, which
 * would prematurely close the comment (`-->`). We defuse that WITHOUT changing
 * the decoded value: each hyphen of every `--` pair is rewritten as the JSON
 * unicode escape `-`, so `JSON.parse` on the reading side restores the exact
 * original hyphens. `--` can only occur inside a JSON string (structural JSON
 * never produces it), so a blanket replace over the stringified payload is safe.
 * Scanning left-to-right and replacing each `--` handles odd runs too (`---` ->
 * two escapes + one bare `-`, still `---` after JSON.parse).
 */
function escapeCommentJson(json: object): string {
  return JSON.stringify(json).replace(/--/g, "\\u002d\\u002d");
}

/**
 * Build a STANDALONE machinery comment (#293 canon #5) for a block node that
 * lives on its OWN line, e.g. `<!--pagebreak-->` or `<!--subpages-->`.
 *
 * Grammar is identical to the attached form (`<!--name {JSON?}-->`), but the
 * JSON body is emitted ONLY when there are real attributes to carry:
 *   - `standaloneCommentFor("pagebreak")`            -> `<!--pagebreak-->`
 *   - `standaloneCommentFor("subpages")`             -> `<!--subpages-->`
 *   - `standaloneCommentFor("subpages", {recursive:true})`
 *                                    -> `<!--subpages {"recursive":true}-->`
 *
 * When `attrs` is undefined/null/empty-object the comment is name-only (no JSON,
 * which parses back to default attrs). Otherwise the JSON body is emitted with
 * the SAME `--`-escaping as `attachedCommentFor` (via `escapeCommentJson`), so
 * the standalone and attached encoders can never diverge.
 */
export function standaloneCommentFor(name: string, attrs?: object | null): string {
  if (!attrs || Object.keys(attrs).length === 0) {
    return `<!--${name}-->`;
  }
  return `<!--${name} ${escapeCommentJson(attrs)}-->`;
}

/**
 * Parse the DATA of a comment node into `{ name, attrs }`, or `null` when it is
 * not a well-formed attached comment.
 *
 * Fail-open by design (maintainer spec): a comment whose name token is missing,
 * whose JSON body is malformed, or whose body is not a plain object returns
 * `null` so the caller ignores it and keeps default attributes. Unknown keys in
 * a valid object are preserved here and filtered by the caller.
 */
export function parseAttachedComment(data: string): AttachedComment | null {
  const m = ATTACHED_COMMENT_RE.exec(data);
  if (!m) return null;
  const name = m[1];
  if (m[2] === undefined) {
    // Name-only comment (no JSON body): a valid attached marker with no attrs.
    return { name, attrs: {} };
  }
  try {
    const parsed = JSON.parse(m[2]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { name, attrs: parsed as Record<string, unknown> };
    }
    return null; // fail-open: payload is not a plain object
  } catch {
    return null; // fail-open: malformed JSON -> ignore the comment
  }
}
