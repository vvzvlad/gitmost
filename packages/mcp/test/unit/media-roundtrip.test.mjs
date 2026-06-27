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
// DATA-LOSS: atom block nodes with no converter case serialize to "" and the
// whole block disappears from markdown export.
//
// markdown-converter.ts has a `default` branch (~line 601) that renders a node
// as `nodeContent.map(processNode).join("")`. For a leaf/atom node (no
// content) that yields "" — so the node (and ALL its attributes) is dropped.
// `htmlEmbed` and `pageBreak` are both block atoms in docmost-schema.ts with no
// case in the converter, so they vanish on markdown export.
//
// These tests assert the CURRENT (buggy) behavior and name it, so that when a
// converter case is added the failing assertion flags the test for an update.
// ---------------------------------------------------------------------------
test("DATA-LOSS: an htmlEmbed block is silently dropped from markdown export (no converter case)", () => {
  const input = doc(
    para(text("before")),
    { type: "htmlEmbed", attrs: { source: "<b>hi</b>", height: 200 } },
    para(text("after")),
  );
  const md = convertProseMirrorToMarkdown(input);

  // BUG: the htmlEmbed block, including its `source` and `height` attrs, is
  // gone — only the surrounding paragraphs survive. If a future fix adds an
  // htmlEmbed case, update this test to assert the block (or a placeholder)
  // survives instead.
  assert.equal(md, "before\n\n\n\nafter", "htmlEmbed currently disappears");
  assert.ok(!md.includes("<b>hi</b>"), "the embed source is NOT preserved (data-loss)");
});

test("DATA-LOSS: an htmlEmbed does NOT round-trip (PM -> markdown -> PM loses the node)", async () => {
  const input = doc(
    para(text("x")),
    { type: "htmlEmbed", attrs: { source: "<i>raw</i>", height: 120 } },
  );
  const out = await markdownToProseMirror(convertProseMirrorToMarkdown(input));
  assert.equal(
    findAll(out, "htmlEmbed").length,
    0,
    "htmlEmbed is lost across a markdown round-trip (known data-loss gap)",
  );
});

test("DATA-LOSS: a pageBreak block is silently dropped from markdown export (no converter case)", () => {
  const input = doc(para(text("a")), { type: "pageBreak" }, para(text("b")));
  const md = convertProseMirrorToMarkdown(input);
  // BUG: pageBreak (a block atom with no converter case) disappears.
  assert.equal(md, "a\n\n\n\nb", "pageBreak currently disappears");
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
