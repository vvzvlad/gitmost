import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";

import { docmostExtensions } from "../src/lib/docmost-schema.js";

// SCHEMA-DRIFT GUARD (must-review gate).
//
// `src/lib/docmost-schema.ts` is a VENDORED MIRROR of the canonical Docmost
// document schema defined in `@docmost/editor-ext`. git-sync uses it to convert
// pages to/from ProseMirror JSON; any node, mark, or attribute that exists in
// the canonical schema but is missing here is silently dropped on a round-trip
// (data loss). The reverse — a node/mark/attr here that no longer exists in the
// canonical schema — is dead surface that can mask drift.
//
// This test derives a stable, sorted "schema surface" (every node/mark name and
// its sorted attribute keys) and pins it against an INLINE expected constant.
// It is intentionally a LOUD must-review gate rather than an automatic
// editor-ext diff: editor-ext's Tiptap representation differs from this
// vendored copy, so a cross-representation compare would be fragile. We do NOT
// use toMatchSnapshot so the reference lives in this file and is reviewed in the
// diff of every change.
//
// AUTOMATED COMPANION GUARD (#684, invariant #7): this loud review gate no
// longer stands alone. `apps/server/src/collaboration/schema-attr-parity.spec.ts`
// now automatically DIFFS the attribute-name set of every shared node/mark
// between the AUTHORITATIVE write-path schema (`getSchema(tiptapExtensions)`)
// and this mirror (`getSchema(docmostExtensions)`), in BOTH directions, and
// fails CI on any unlisted drift — the guard that would have caught the
// `tableCell`/`tableHeader` `align` drift (mirror-declared, write-path-stripped)
// before it shipped as silent GFM-alignment loss.
//
// WHEN THIS TEST FAILS: do NOT blindly update `expectedSurface`. First confirm
// the change matches `@docmost/editor-ext` (the canonical schema) so the
// markdown <-> ProseMirror round-trip stays lossless, THEN copy the new surface
// into the expected constant below.

interface SurfaceEntry {
  name: string;
  kind: "node" | "mark";
  attrs: string[];
}

/** Derive the deterministic schema surface from the vendored extension set. */
function deriveSurface(): SurfaceEntry[] {
  const schema = getSchema(docmostExtensions as never);
  const surface: SurfaceEntry[] = [];
  for (const [name, type] of Object.entries(schema.nodes)) {
    surface.push({
      name,
      kind: "node",
      attrs: Object.keys((type as { spec?: { attrs?: object } }).spec?.attrs ?? {}).sort(),
    });
  }
  for (const [name, type] of Object.entries(schema.marks)) {
    surface.push({
      name,
      kind: "mark",
      attrs: Object.keys((type as { spec?: { attrs?: object } }).spec?.attrs ?? {}).sort(),
    });
  }
  // Sort by name, then by kind, for a representation-independent ordering.
  surface.sort((a, b) =>
    a.name === b.name ? a.kind.localeCompare(b.kind) : a.name.localeCompare(b.name),
  );
  return surface;
}

// The committed reference surface. Built from the ACTUAL current schema; review
// every change to this constant against `@docmost/editor-ext`.
const expectedSurface: SurfaceEntry[] = [
  { name: "attachment", kind: "node", attrs: ["attachmentId", "mime", "name", "placeholder", "size", "url"] },
  { name: "audio", kind: "node", attrs: ["attachmentId", "placeholder", "size", "src"] },
  { name: "blockquote", kind: "node", attrs: [] },
  { name: "bold", kind: "mark", attrs: [] },
  { name: "bulletList", kind: "node", attrs: [] },
  { name: "callout", kind: "node", attrs: ["icon", "type"] },
  { name: "code", kind: "mark", attrs: [] },
  { name: "codeBlock", kind: "node", attrs: ["language"] },
  { name: "column", kind: "node", attrs: ["width"] },
  { name: "columns", kind: "node", attrs: ["layout", "widthMode"] },
  { name: "comment", kind: "mark", attrs: ["commentId", "resolved"] },
  { name: "details", kind: "node", attrs: ["open"] },
  { name: "detailsContent", kind: "node", attrs: [] },
  { name: "detailsSummary", kind: "node", attrs: [] },
  { name: "doc", kind: "node", attrs: [] },
  { name: "drawio", kind: "node", attrs: ["align", "alt", "aspectRatio", "attachmentId", "height", "size", "src", "title", "width"] },
  { name: "embed", kind: "node", attrs: ["align", "height", "provider", "src", "width"] },
  { name: "excalidraw", kind: "node", attrs: ["align", "alt", "aspectRatio", "attachmentId", "height", "size", "src", "title", "width"] },
  { name: "footnoteDefinition", kind: "node", attrs: ["id"] },
  { name: "footnoteReference", kind: "node", attrs: ["id"] },
  { name: "footnotesList", kind: "node", attrs: [] },
  { name: "hardBreak", kind: "node", attrs: [] },
  { name: "heading", kind: "node", attrs: ["id", "indent", "level", "textAlign"] },
  { name: "highlight", kind: "mark", attrs: ["color"] },
  { name: "horizontalRule", kind: "node", attrs: [] },
  { name: "htmlEmbed", kind: "node", attrs: ["height", "source"] },
  { name: "image", kind: "node", attrs: ["align", "alt", "aspectRatio", "attachmentId", "caption", "height", "placeholder", "size", "src", "title", "width"] },
  { name: "italic", kind: "mark", attrs: [] },
  { name: "link", kind: "mark", attrs: ["class", "href", "internal", "rel", "target", "title"] },
  { name: "listItem", kind: "node", attrs: [] },
  { name: "mathBlock", kind: "node", attrs: ["text"] },
  { name: "mathInline", kind: "node", attrs: ["text"] },
  { name: "mention", kind: "node", attrs: ["anchorId", "creatorId", "entityId", "entityType", "id", "label", "slugId"] },
  { name: "orderedList", kind: "node", attrs: ["start", "type"] },
  { name: "pageBreak", kind: "node", attrs: [] },
  { name: "pageEmbed", kind: "node", attrs: ["sourcePageId"] },
  { name: "paragraph", kind: "node", attrs: ["id", "indent", "textAlign"] },
  { name: "pdf", kind: "node", attrs: ["attachmentId", "height", "name", "placeholder", "size", "src", "width"] },
  { name: "spoiler", kind: "mark", attrs: [] },
  { name: "status", kind: "node", attrs: ["color", "text"] },
  { name: "strike", kind: "mark", attrs: [] },
  { name: "subpages", kind: "node", attrs: ["recursive"] },
  { name: "subscript", kind: "mark", attrs: [] },
  { name: "superscript", kind: "mark", attrs: [] },
  { name: "table", kind: "node", attrs: [] },
  { name: "tableCell", kind: "node", attrs: ["align", "backgroundColor", "backgroundColorName", "colspan", "colwidth", "rowspan"] },
  { name: "tableHeader", kind: "node", attrs: ["align", "backgroundColor", "backgroundColorName", "colspan", "colwidth", "rowspan"] },
  { name: "tableRow", kind: "node", attrs: [] },
  { name: "taskItem", kind: "node", attrs: ["checked"] },
  { name: "taskList", kind: "node", attrs: [] },
  { name: "text", kind: "node", attrs: [] },
  { name: "textStyle", kind: "mark", attrs: ["color"] },
  { name: "transclusionReference", kind: "node", attrs: ["sourcePageId", "transclusionId"] },
  { name: "transclusionSource", kind: "node", attrs: ["id"] },
  { name: "underline", kind: "mark", attrs: [] },
  { name: "video", kind: "node", attrs: ["align", "alt", "aspectRatio", "attachmentId", "height", "placeholder", "size", "src", "width"] },
  { name: "youtube", kind: "node", attrs: ["align", "height", "src", "width"] },
];

describe("docmost schema surface", () => {
  it("matches the committed reference surface (re-verify against @docmost/editor-ext on change)", () => {
    expect(deriveSurface()).toEqual(expectedSurface);
  });
});
