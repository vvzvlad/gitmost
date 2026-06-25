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
export interface DocmostMdMeta {
    version: number;
    pageId?: string;
    slugId?: string;
    title?: string;
    spaceId?: string;
    parentPageId?: string | null;
}
/**
 * Assemble the full self-contained markdown file: meta block, body, and the
 * comments block. The meta block is always emitted; the comments block is always
 * emitted too (with `[]` when there are no comments) so the format stays uniform
 * and parsing stays simple.
 */
export declare function serializeDocmostMarkdown(meta: DocmostMdMeta, body: string, comments: any[]): string;
/**
 * Split a self-contained file back into its parts. Tolerant: if the meta or
 * comments block is missing (e.g. a hand-written plain-markdown file), the
 * corresponding value is returned as `null` and the whole input is treated as
 * the body. This never throws on a MISSING block; only a `JSON.parse` failure
 * inside a block that IS present is surfaced as a thrown Error with a clear
 * message. Robust to `\r\n` line endings.
 */
export declare function parseDocmostMarkdown(full: string): {
    meta: DocmostMdMeta | null;
    body: string;
    comments: any[] | null;
};
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
export declare function serializeDocmostMarkdownBody(meta: DocmostMdMeta, body: string): string;
