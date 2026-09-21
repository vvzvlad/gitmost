/**
 * ProseMirror -> Docmost-flavoured Markdown converter.
 *
 * #293 STEP 5: the converter CORE now lives in the shared
 * `@docmost/prosemirror-markdown` package (the canonical, lossless
 * implementation carrying every git-sync fix and the #293 canon decisions).
 * MCP consumes it directly instead of keeping its own drifted copy, so the two
 * can never diverge again. This file is a thin re-export shim kept only so the
 * many existing `./markdown-converter.js` importers (client.ts, tests) do not
 * have to move.
 */
export {
  convertProseMirrorToMarkdown,
  type ConvertProseMirrorToMarkdownOptions,
} from "@docmost/prosemirror-markdown";
