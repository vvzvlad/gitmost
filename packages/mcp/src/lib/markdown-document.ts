/**
 * Self-contained Docmost-flavoured Markdown document envelope (`docmost:meta` /
 * `docmost:comments` blocks).
 *
 * #293 STEP 5: this envelope is now owned by the shared
 * `@docmost/prosemirror-markdown` package (the mcp copy was byte-identical to
 * the package's, so re-exporting is lossless). Kept as a thin shim so the
 * existing `./markdown-document.js` importers (client.ts, tests) do not move.
 */
export {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
  serializeDocmostMarkdownBody,
} from "@docmost/prosemirror-markdown";
export type { DocmostMdMeta } from "@docmost/prosemirror-markdown";
