/**
 * Shared schema-HTML builders for the media/discriminator family (#293 canon
 * #8).
 *
 * Canon #8 gives ten node types (youtube/video/audio/drawio/excalidraw —
 * image-form; pdf/attachment/embed — link-form; pageEmbed/transclusionReference
 * — standalone) a readable markdown TOP-LEVEL form (`![](src)`/`[text](src)`/a
 * bare comment) plus a discriminator `<!--name {…}-->` comment. But TWO other
 * paths still need the RAW SCHEMA-HTML form of each node:
 *
 *   1. The serializer's raw-HTML/columns path (`blockToHtml`): a comment node is
 *      dropped by the DOM parse stage that reads a raw-HTML block back, so inside
 *      a column/cell these nodes MUST stay schema HTML or they vanish (data loss).
 *   2. The importer's `applyCommentDirectives`: to materialize the discriminator
 *      comment it rebuilds the SAME schema element the raw-HTML path emits, then
 *      swaps it in for the `<img>`/`<a>`/comment.
 *
 * Keeping these builders in ONE module means the serializer's raw-HTML path and
 * the importer's materialization can never drift: both call the same function.
 * Each builder reproduces BYTE-FOR-BYTE the schema HTML the top-level
 * `processNode` cases previously returned (so existing columns/raw-HTML goldens
 * stay green), and each output round-trips through the matching schema parseHTML
 * in docmost-schema.ts.
 */

/**
 * Escape a value interpolated into an HTML double-quoted attribute value.
 * Identical semantics to markdown-converter's `escapeAttr`: escape ONLY `&` and
 * `"` (idempotent; parse5 decodes both back). `<`/`>`/`'` are deliberately left
 * alone so values never accumulate escapes across round-trips.
 */
const escapeAttr = (value: unknown): string =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Uploaded `<video>` player. Emits `<div><video …></video></div>`; the outer
 * `<div>` (no data-type) forces block treatment so marked does not wrap the
 * inline `<video>` in a `<p>`. Mirrors the Video schema: src/aria-label standard
 * attrs, the rest as data-*.
 */
export function videoToHtml(attrs: Record<string, any>): string {
  const parts: string[] = [`src="${escapeAttr(attrs.src ?? "")}"`];
  if (attrs.alt) parts.push(`aria-label="${escapeAttr(attrs.alt)}"`);
  if (attrs.attachmentId)
    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
  if (attrs.width != null) parts.push(`width="${escapeAttr(attrs.width)}"`);
  if (attrs.height != null) parts.push(`height="${escapeAttr(attrs.height)}"`);
  if (attrs.size != null) parts.push(`data-size="${escapeAttr(attrs.size)}"`);
  // align default is "center" (schema): OMIT it so a bare/center node stays
  // clean and parse's re-materialized "center" default is not a P2 churn — only
  // a genuinely non-default left/right emits data-align (mirrors imageToHtml).
  if (attrs.align && attrs.align !== "center")
    parts.push(`data-align="${escapeAttr(attrs.align)}"`);
  if (attrs.aspectRatio != null)
    parts.push(`data-aspect-ratio="${escapeAttr(attrs.aspectRatio)}"`);
  return `<div><video ${parts.join(" ")}></video></div>`;
}

/** YouTube embed. Emits `div[data-type="youtube"]` (src via data-src). */
export function youtubeToHtml(attrs: Record<string, any>): string {
  const parts: string[] = [
    `data-type="youtube"`,
    `data-src="${escapeAttr(attrs.src ?? "")}"`,
  ];
  if (attrs.width != null)
    parts.push(`data-width="${escapeAttr(attrs.width)}"`);
  if (attrs.height != null)
    parts.push(`data-height="${escapeAttr(attrs.height)}"`);
  // "center" is the schema default -> omit (see videoToHtml rationale).
  if (attrs.align && attrs.align !== "center")
    parts.push(`data-align="${escapeAttr(attrs.align)}"`);
  return `<div ${parts.join(" ")}></div>`;
}

/** Uploaded `<audio>` player. Emits `<div><audio …></audio></div>`. */
export function audioToHtml(attrs: Record<string, any>): string {
  const parts: string[] = [`src="${escapeAttr(attrs.src ?? "")}"`];
  if (attrs.attachmentId)
    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
  if (attrs.size != null) parts.push(`data-size="${escapeAttr(attrs.size)}"`);
  return `<div><audio ${parts.join(" ")}></audio></div>`;
}

/**
 * draw.io / excalidraw diagram (shared diagramAttributes). Emits
 * `div[data-type="drawio"|"excalidraw"]` carrying src/title/alt/width/height/
 * size/aspectRatio/align/attachmentId as data-*.
 */
export function diagramToHtml(
  type: "drawio" | "excalidraw",
  attrs: Record<string, any>,
): string {
  const parts: string[] = [
    `data-type="${type}"`,
    `data-src="${escapeAttr(attrs.src ?? "")}"`,
  ];
  if (attrs.title != null) parts.push(`data-title="${escapeAttr(attrs.title)}"`);
  if (attrs.alt != null) parts.push(`data-alt="${escapeAttr(attrs.alt)}"`);
  if (attrs.width != null)
    parts.push(`data-width="${escapeAttr(attrs.width)}"`);
  if (attrs.height != null)
    parts.push(`data-height="${escapeAttr(attrs.height)}"`);
  if (attrs.size != null) parts.push(`data-size="${escapeAttr(attrs.size)}"`);
  if (attrs.aspectRatio != null)
    parts.push(`data-aspect-ratio="${escapeAttr(attrs.aspectRatio)}"`);
  // "center" is the schema default -> omit (see videoToHtml rationale).
  if (attrs.align && attrs.align !== "center")
    parts.push(`data-align="${escapeAttr(attrs.align)}"`);
  if (attrs.attachmentId)
    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
  return `<div ${parts.join(" ")}></div>`;
}

/** Generic provider embed. Emits `div[data-type="embed"]` (src/provider/… data-*). */
export function embedToHtml(attrs: Record<string, any>): string {
  const parts: string[] = [
    `data-type="embed"`,
    `data-src="${escapeAttr(attrs.src ?? "")}"`,
    `data-provider="${escapeAttr(attrs.provider ?? "")}"`,
  ];
  // "center" is the schema default -> omit (see videoToHtml rationale).
  if (attrs.align && attrs.align !== "center")
    parts.push(`data-align="${escapeAttr(attrs.align)}"`);
  // embed width/height default to the NUMBERS 800/600 (schema). Getting a data-
  // attribute back always yields a STRING, so emitting the default here would
  // round-trip 800 -> "800" (a number->string P1 divergence canonicalize does
  // NOT normalize). OMIT the defaults so parse re-materializes the numeric
  // default instead — mirrors the top-level embed path (markdown-converter.ts),
  // which also emits width/height only when they differ from 800/600.
  if (attrs.width != null && attrs.width !== 800)
    parts.push(`data-width="${escapeAttr(attrs.width)}"`);
  if (attrs.height != null && attrs.height !== 600)
    parts.push(`data-height="${escapeAttr(attrs.height)}"`);
  return `<div ${parts.join(" ")}></div>`;
}

/** Uploaded file attachment. Emits `div[data-type="attachment"]` (data-attachment-*). */
export function attachmentToHtml(attrs: Record<string, any>): string {
  const parts: string[] = [
    `data-type="attachment"`,
    `data-attachment-url="${escapeAttr(attrs.url ?? "")}"`,
  ];
  if (attrs.name)
    parts.push(`data-attachment-name="${escapeAttr(attrs.name)}"`);
  if (attrs.mime)
    parts.push(`data-attachment-mime="${escapeAttr(attrs.mime)}"`);
  if (attrs.size != null)
    parts.push(`data-attachment-size="${escapeAttr(attrs.size)}"`);
  if (attrs.attachmentId)
    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
  return `<div ${parts.join(" ")}></div>`;
}

/** Embedded PDF viewer. Emits `div[data-type="pdf"]` (src std, name/… data-*). */
export function pdfToHtml(attrs: Record<string, any>): string {
  const parts: string[] = [
    `data-type="pdf"`,
    `src="${escapeAttr(attrs.src ?? "")}"`,
  ];
  if (attrs.name) parts.push(`data-name="${escapeAttr(attrs.name)}"`);
  if (attrs.attachmentId)
    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
  if (attrs.size != null) parts.push(`data-size="${escapeAttr(attrs.size)}"`);
  if (attrs.width != null) parts.push(`width="${escapeAttr(attrs.width)}"`);
  if (attrs.height != null) parts.push(`height="${escapeAttr(attrs.height)}"`);
  return `<div ${parts.join(" ")}></div>`;
}

/** Whole-page live embed. Emits `div[data-type="pageEmbed"]` (data-source-page-id). */
export function pageEmbedToHtml(attrs: Record<string, any>): string {
  const parts: string[] = [`data-type="pageEmbed"`];
  if (attrs.sourcePageId)
    parts.push(`data-source-page-id="${escapeAttr(attrs.sourcePageId)}"`);
  return `<div ${parts.join(" ")}></div>`;
}

/**
 * Live transclusion reference. Emits `div[data-type="transclusionReference"]`
 * (data-source-page-id + data-transclusion-id).
 */
export function transclusionReferenceToHtml(attrs: Record<string, any>): string {
  const parts: string[] = [`data-type="transclusionReference"`];
  if (attrs.sourcePageId)
    parts.push(`data-source-page-id="${escapeAttr(attrs.sourcePageId)}"`);
  if (attrs.transclusionId)
    parts.push(`data-transclusion-id="${escapeAttr(attrs.transclusionId)}"`);
  return `<div ${parts.join(" ")}></div>`;
}
