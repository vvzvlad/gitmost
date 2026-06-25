/**
 * Self-contained Docmost-flavoured Markdown document (custom extensions).
 *
 * A single `.md` file that packages everything needed to losslessly round-trip
 * a page through "download -> edit body -> re-upload":
 *   - a leading `docmost:meta` block: a one-line JSON object with page identity;
 *   - the Markdown body (carrying inline comment anchors and diagrams as HTML);
 *   - a trailing `docmost:comments` block: a one-line JSON array of comment
 *     threads.
 *
 * Both metadata blocks are HTML comments on purpose: `marked`/`generateJSON`
 * drop HTML comments, so even if the WHOLE file were ever fed straight to the
 * importer without first stripping the blocks, the metadata cannot leak into the
 * document. (A fenced ```docmost-comments``` block would WRONGLY become a
 * codeBlock node, so a fenced block is deliberately NOT used.)
 *
 * The delimiter literals may legitimately appear in the BODY too (e.g. a user
 * re-pastes an exported `.md` into a page, or a page documents this very
 * format). To stay robust, parsing treats only the FINAL, document-ending
 * `docmost:comments` block as metadata: it is the last `<!-- docmost:comments`
 * opener whose closing `-->` sits at the very end of the file. Any earlier
 * literal occurrence is left in the body untouched.
 *
 * NOTE on comments: in this version the comment THREAD records are preserved in
 * the file but are NOT pushed back to the server on import — only the inline
 * comment marks (anchors) embedded in the body are restored. Managing comment
 * records stays with the comment tools/UI.
 */
// Match the leading meta block (allow leading whitespace). Capture group 1 is
// the JSON text between the markers.
const META_RE = /^\s*<!--\s*docmost:meta\s*\n([\s\S]*?)\n-->/;
// Match a `docmost:comments` opener. Used globally to scan for the LAST opener
// rather than end-anchoring a single regex (which would mis-capture across a
// literal opener that appears earlier in the body).
const COMMENTS_OPEN_RE = /<!--[ \t]*docmost:comments[ \t]*\r?\n/g;
/**
 * Assemble the full self-contained markdown file: meta block, body, and the
 * comments block. The meta block is always emitted; the comments block is always
 * emitted too (with `[]` when there are no comments) so the format stays uniform
 * and parsing stays simple.
 */
export function serializeDocmostMarkdown(meta, body, comments) {
    const metaJson = JSON.stringify(meta);
    const commentsJson = JSON.stringify(Array.isArray(comments) ? comments : []);
    const trimmedBody = (body ?? "").trim();
    return (`<!-- docmost:meta\n${metaJson}\n-->\n\n` +
        `${trimmedBody}\n\n` +
        `<!-- docmost:comments\n${commentsJson}\n-->\n`);
}
/**
 * Split a self-contained file back into its parts. Tolerant: if the meta or
 * comments block is missing (e.g. a hand-written plain-markdown file), the
 * corresponding value is returned as `null` and the whole input is treated as
 * the body. This never throws on a MISSING block; only a `JSON.parse` failure
 * inside a block that IS present is surfaced as a thrown Error with a clear
 * message. Robust to `\r\n` line endings.
 */
export function parseDocmostMarkdown(full) {
    // Normalize line endings so the anchored regexes work regardless of CRLF.
    const normalized = (full ?? "").replace(/\r\n/g, "\n");
    // Extract the leading meta block (start-anchored — already unambiguous).
    let meta = null;
    let metaEnd = 0;
    const metaMatch = normalized.match(META_RE);
    if (metaMatch) {
        try {
            meta = JSON.parse(metaMatch[1]);
        }
        catch (e) {
            throw new Error(`Invalid docmost:meta JSON block: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Body starts right after the matched meta block.
        metaEnd = (metaMatch.index ?? 0) + metaMatch[0].length;
    }
    // Find the LAST `<!-- docmost:comments` opener; the real file-level block is
    // the final one whose closing `-->` ends the document. Any earlier literal
    // occurrence inside the body (e.g. a re-pasted export) is left in the body.
    let lastOpenStart = -1;
    let lastOpenEnd = -1;
    let m;
    COMMENTS_OPEN_RE.lastIndex = 0;
    while ((m = COMMENTS_OPEN_RE.exec(normalized)) !== null) {
        lastOpenStart = m.index;
        lastOpenEnd = m.index + m[0].length;
    }
    let comments = null;
    let bodyEnd = normalized.length;
    if (lastOpenStart !== -1) {
        const rest = normalized.slice(lastOpenEnd);
        const close = rest.match(/\r?\n-->[ \t]*\r?\n?\s*$/); // closer must end the doc
        if (close) {
            const jsonText = rest.slice(0, close.index);
            try {
                comments = JSON.parse(jsonText);
            }
            catch (e) {
                throw new Error(`Invalid docmost:comments JSON block: ${e instanceof Error ? e.message : String(e)}`);
            }
            bodyEnd = lastOpenStart; // strip from the opener to end of document
        }
    }
    const body = normalized.slice(metaEnd, bodyEnd).trim();
    return { meta, body, comments };
}
/**
 * Serialize a self-contained markdown file with the meta block + body ONLY —
 * NO trailing `docmost:comments` block. The sync engine never touches
 * `/comments` (SPEC §3): the synced file carries just page identity (meta) and
 * the body, where comment threads survive only as inline `<span
 * data-comment-id>` anchor marks inside the body.
 *
 * `parseDocmostMarkdown` already tolerates a missing comments block (it returns
 * `comments: null` and treats the rest as body), so a file produced here
 * round-trips cleanly through the parser.
 */
export function serializeDocmostMarkdownBody(meta, body) {
    return `<!-- docmost:meta\n${JSON.stringify(meta)}\n-->\n\n${(body ?? "").trim()}\n`;
}
