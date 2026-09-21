// Markdown-export coverage for atom/media block nodes.
//
// The existing schema.test.mjs only exercises the Yjs (fromYdoc/toYdoc) path.
// These tests exercise the SEPARATE markdown-export path
// (convertProseMirrorToMarkdown) and the full PM -> markdown -> PM round-trip
// (markdownToProseMirror), which is where a missing converter case silently
// drops a whole block.
import { test } from "node:test";
import assert from "node:assert/strict";

import { convertProseMirrorToMarkdown } from "../../build/lib/markdown-converter.js";
import { markdownToProseMirror } from "../../build/lib/collaboration.js";

// Builders.
const doc = (...content) => ({ type: "doc", content });
const para = (...content) => ({ type: "paragraph", content });
const text = (t) => ({ type: "text", text: t });

// Recursively collect every descendant node (and self) of the given type.
const findAll = (node, type, acc = []) => {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  for (const c of node.content || []) findAll(c, type, acc);
  return acc;
};

// ---------------------------------------------------------------------------
// #293 canon: atom block nodes with no NATIVE markdown syntax are preserved via
// dedicated converter forms (they used to serialize to "" and vanish — the old
// mcp converter's data-loss gap, now fixed by consuming the shared package):
//   - htmlEmbed  -> a raw `<div data-type="htmlEmbed" data-source=… data-height=…>`
//                   block (source base64-encoded so arbitrary HTML is inert);
//   - pageBreak  -> a standalone `<!--pagebreak-->` machinery comment (#5).
// Both survive markdown export AND a full PM -> markdown -> PM round-trip.
// ---------------------------------------------------------------------------
test("htmlEmbed block survives markdown export (source + height preserved)", () => {
  const input = doc(
    para(text("before")),
    { type: "htmlEmbed", attrs: { source: "<b>hi</b>", height: 200 } },
    para(text("after")),
  );
  const md = convertProseMirrorToMarkdown(input);

  assert.match(md, /data-type="htmlEmbed"/);
  assert.match(md, /data-height="200"/);
  // The raw source is base64-encoded in data-source (not emitted verbatim), so
  // the surrounding markdown cannot be corrupted by hostile embed HTML.
  assert.match(md, /data-source="[^"]+"/);
  assert.ok(md.includes("before") && md.includes("after"));
});

test("htmlEmbed round-trips PM -> markdown -> PM (node + source recovered)", async () => {
  const input = doc(
    para(text("x")),
    { type: "htmlEmbed", attrs: { source: "<i>raw</i>", height: 120 } },
  );
  const out = await markdownToProseMirror(convertProseMirrorToMarkdown(input));
  const embeds = findAll(out, "htmlEmbed");
  assert.equal(embeds.length, 1, "htmlEmbed survives the markdown round-trip");
  assert.equal(embeds[0].attrs.source, "<i>raw</i>", "source recovered intact");
});

test("pageBreak block survives markdown export and round-trips", async () => {
  const input = doc(para(text("a")), { type: "pageBreak" }, para(text("b")));
  const md = convertProseMirrorToMarkdown(input);
  assert.match(md, /<!--pagebreak-->/);
  const out = await markdownToProseMirror(md);
  assert.equal(findAll(out, "pageBreak").length, 1);
});

// ---------------------------------------------------------------------------
// Media block nodes that DO have converter cases must survive markdown export
// AND a full PM -> markdown -> PM round-trip. The schema.test.mjs Yjs path does
// not exercise the converter, so these lock in the converter+schema pairing.
// (Numeric width/height come back as strings via the schema parseHTML; we
// assert survival + the identifying src/ids rather than exact attr types.)
// ---------------------------------------------------------------------------
const roundtrip = async (node, type) =>
  findAll(await markdownToProseMirror(convertProseMirrorToMarkdown(doc(node))), type);

test("round-trip: video node survives markdown export with src + attachmentId", async () => {
  const found = await roundtrip(
    { type: "video", attrs: { src: "/api/files/v.mp4", width: 640, height: 360, attachmentId: "att1" } },
    "video",
  );
  assert.equal(found.length, 1, "video node should survive");
  assert.equal(found[0].attrs?.src, "/api/files/v.mp4");
  assert.equal(found[0].attrs?.attachmentId, "att1");
});

test("round-trip: youtube node survives markdown export with src", async () => {
  const found = await roundtrip(
    { type: "youtube", attrs: { src: "https://youtube.com/watch?v=x", width: 560, height: 315 } },
    "youtube",
  );
  assert.equal(found.length, 1, "youtube node should survive");
  assert.equal(found[0].attrs?.src, "https://youtube.com/watch?v=x");
});

test("round-trip: embed node survives markdown export with src + provider", async () => {
  const found = await roundtrip(
    { type: "embed", attrs: { src: "https://e.com/x", provider: "iframe", width: 600 } },
    "embed",
  );
  assert.equal(found.length, 1, "embed node should survive");
  assert.equal(found[0].attrs?.src, "https://e.com/x");
  assert.equal(found[0].attrs?.provider, "iframe");
});

test("round-trip: excalidraw node survives markdown export with src + attachmentId", async () => {
  const found = await roundtrip(
    { type: "excalidraw", attrs: { src: "/api/files/d.excalidraw", title: "D", attachmentId: "a2" } },
    "excalidraw",
  );
  assert.equal(found.length, 1, "excalidraw node should survive");
  assert.equal(found[0].attrs?.src, "/api/files/d.excalidraw");
  assert.equal(found[0].attrs?.attachmentId, "a2");
});

test("round-trip: audio node survives markdown export with src + attachmentId", async () => {
  const found = await roundtrip(
    { type: "audio", attrs: { src: "/api/files/a.mp3", attachmentId: "a3" } },
    "audio",
  );
  assert.equal(found.length, 1, "audio node should survive");
  assert.equal(found[0].attrs?.src, "/api/files/a.mp3");
  assert.equal(found[0].attrs?.attachmentId, "a3");
});

test("round-trip: pdf node survives markdown export with src + name + attachmentId", async () => {
  const found = await roundtrip(
    { type: "pdf", attrs: { src: "/api/files/x.pdf", name: "x.pdf", attachmentId: "a4" } },
    "pdf",
  );
  assert.equal(found.length, 1, "pdf node should survive");
  assert.equal(found[0].attrs?.src, "/api/files/x.pdf");
  assert.equal(found[0].attrs?.name, "x.pdf");
  assert.equal(found[0].attrs?.attachmentId, "a4");
});

// The converter emits captioned images as a raw <img data-caption="...">; for
// the caption to survive the PM -> markdown -> PM round-trip the docmost-schema
// Image node must parse data-caption back into the `caption` attr. Without that
// (stock @tiptap/extension-image), the caption is silently lost — these guard
// the "lossless" claim.
test("round-trip: image caption survives markdown export (data-caption restored)", async () => {
  const found = await roundtrip(
    { type: "image", attrs: { src: "/api/files/cat.png", alt: "cat", caption: "A grey cat" } },
    "image",
  );
  assert.equal(found.length, 1, "image node should survive");
  assert.equal(found[0].attrs?.src, "/api/files/cat.png");
  assert.equal(found[0].attrs?.caption, "A grey cat", "caption must round-trip");
});

test("round-trip: image caption with special chars survives markdown export", async () => {
  const found = await roundtrip(
    { type: "image", attrs: { src: "/api/files/cat.png", caption: 'Tom & "Jerry"' } },
    "image",
  );
  assert.equal(found.length, 1, "image node should survive");
  assert.equal(
    found[0].attrs?.caption,
    'Tom & "Jerry"',
    "special-char caption must round-trip unescaped",
  );
});
