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
export {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
  serializeDocmostMarkdownBody,
} from "./markdown-document.js";
export type { DocmostMdMeta } from "./markdown-document.js";

export {
  convertProseMirrorToMarkdown,
  ConverterLossError,
} from "./markdown-converter.js";
export type { ConvertProseMirrorToMarkdownOptions } from "./markdown-converter.js";

export {
  markdownToProseMirror,
  markdownToProseMirrorSync,
} from "./markdown-to-prosemirror.js";
export type { MarkdownImportOptions } from "./markdown-to-prosemirror.js";

// Foreign-markdown normalizer (#493): the input-liberal pre-pass that rewrites
// GFM `[^id]` reference footnotes to canonical inline `^[body]`. Two variants:
// `normalizeForeignMarkdown` (server FILE-import boundary) ALSO strips a leading
// YAML front-matter block; `normalizeAgentMarkdown` (canonical AGENT-WRITE path,
// mcp `markdownToProseMirrorCanonical`) does NOT — a full-body agent rewrite must
// not lose a leading `---…---` horizontalRule to the front-matter strip (#493
// review). The reference-footnote rewrite is shared so agent + import stay unified
// where it matters, without the content-losing strip on the write path.
export {
  normalizeForeignMarkdown,
  normalizeAgentMarkdown,
} from "./foreign-markdown.js";
// Pure primitive: detect the unambiguously-internal wiki-page link path
// (`/s/<space>/p/<slug>`) and promote such link marks to their native internal
// form during import (#522). A strict subset of the server's INTERNAL_LINK_REGEX.
export { isInternalPagePath, markInternalLinks } from "./internal-links.js";

// The Docmost tiptap schema mirror. Exposed so consumers (and the sync
// engine's schema-validity regression tests) can build the exact ProseMirror
// schema the converter targets.
export { docmostExtensions } from "./docmost-schema.js";

// Schema-adjacent sanitizers used by consumers (mcp) so the single canonical,
// alias-aware / allowlist implementations live ONLY here (no drifting copies).
export { clampCalloutType, sanitizeCssColor } from "./docmost-schema.js";

// Attached-comment convention (#293 canon #9/#4/#8): the reusable primitives
// the serializer/parser use to encode attrs that have no native markdown syntax
// as trailing `<!--name {json}-->` comments.
export {
  attachedCommentFor,
  standaloneCommentFor,
  parseAttachedComment,
} from "./attached-comment.js";
export type { AttachedComment } from "./attached-comment.js";

export {
  canonicalizeContent,
  docsCanonicallyEqual,
} from "./canonicalize.js";
export { parsePageFile, serializePageFile } from "./page-file.js";

// Pure, network-free helpers for manipulating a ProseMirror/TipTap document
// tree by node id (#414: the single canonical copy, formerly forked into mcp).
// Consumed by `@docmost/mcp` (patch/insert/delete node, table tools, outline).
export {
  blockPlainText,
  buildOutline,
  getNodeByRef,
  replaceNodeById,
  replaceNodeByIdWithMany,
  reassignCollidingBlockIds,
  deleteNodeById,
  sanitizeForYjs,
  findUnstorableAttr,
  findInvalidNode,
  insertNodeRelative,
  insertNodesRelative,
  readTable,
  insertTableRow,
  deleteTableRow,
  updateTableCell,
  assertUnambiguousMatch,
} from "./node-ops.js";
export type { OutlineEntry } from "./node-ops.js";

// Normalize a ProseMirror node arg that the model may have serialized as a JSON
// string (#414: single copy shared by mcp and the CommonJS server app).
export { parseNodeArg } from "./parse-node-arg.js";

// Locator markdown-stripping (#493 dedup): the single canonical copy of the
// markdown-tolerant anchor-normalization primitives, imported by mcp's
// text-normalize.ts instead of a forked duplicate. `stripInlineMarkdown` is the
// lenient locator normalizer (trims stray decoration); `stripWrappersAndLinks`
// is the strict balanced-wrapper/link primitive mcp builds `stripBalancedWrappers`
// on top of.
export {
  stripInlineMarkdown,
  stripWrappersAndLinks,
} from "./text-normalize.js";

// Fold canon (#658): the single source of truth for the invisible-character /
// typography fold tables, shared by mcp editPageText, createComment anchoring
// and footnote-normalize-merge (R3 — no more forked copies).
export {
  DOUBLE_QUOTES,
  SINGLE_QUOTES,
  DASHES,
  isFoldDelete,
  isFoldSpace,
  isLegacySpace,
  foldInvisibles,
  foldTypography,
  escapeInvisibles,
} from "./text-normalize.js";

// Inline-footnote authoring convention (#414: single copy, formerly the mcp
// `footnote-authoring.ts` fork), shared with the importer's `assembleFootnotes`.
export {
  footnoteContentKey,
  makeFootnoteDefinition,
  generateFootnoteId,
} from "./footnote.js";
