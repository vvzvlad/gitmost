/**
 * Public surface of the pure converter (`lib/`). This barrel re-exports the
 * PURE, IO-free pieces the sync engine needs: the self-contained markdown
 * (de)serializers, the lossless ProseMirror <-> Markdown converter, the
 * markdown -> ProseMirror import path, and semantic canonicalization for the
 * round-trip idempotency check (SPEC §11).
 *
 * There is no REST client, websocket/collab write-path, auth-utils or page-lock
 * here — the gitmost server writes natively.
 */
export { serializeDocmostMarkdown, parseDocmostMarkdown, serializeDocmostMarkdownBody, } from "./markdown-document.js";
export { convertProseMirrorToMarkdown } from "./markdown-converter.js";
export { markdownToProseMirror } from "./markdown-to-prosemirror.js";
export { canonicalizeContent, docsCanonicallyEqual, } from "./canonicalize.js";
export { parsePageFile, serializePageFile } from "./page-file.js";
