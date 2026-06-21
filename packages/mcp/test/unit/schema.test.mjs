import { test } from "node:test";
import assert from "node:assert/strict";

import {
  docmostExtensions,
  clampCalloutType,
} from "../../build/lib/docmost-schema.js";
import { TiptapTransformer } from "@hocuspocus/transformer";

test("clampCalloutType: a known type passes through", () => {
  assert.equal(clampCalloutType("warning"), "warning");
});

test("clampCalloutType: an uppercase known type folds to lower case", () => {
  assert.equal(clampCalloutType("WARNING"), "warning");
  assert.equal(clampCalloutType("Info"), "info");
});

test("clampCalloutType: an unknown type falls back to info", () => {
  assert.equal(clampCalloutType("bogus"), "info");
});

test("clampCalloutType: null and undefined fall back to info", () => {
  assert.equal(clampCalloutType(null), "info");
  assert.equal(clampCalloutType(undefined), "info");
});

// Minimal-doc builders for the toYdoc acceptance loop.
const text = (t) => ({ type: "text", text: t });
const paragraph = (inline) => ({ type: "paragraph", content: inline });
const docOf = (...content) => ({ type: "doc", content });

// Each entry is a minimal valid doc for one Docmost node type. Inline atoms
// (mention, mathInline) and inline-capable nodes go inside a paragraph; block
// atoms and block containers go at the top level.
const cases = {
  mention: docOf(
    paragraph([{ type: "mention", attrs: { id: "u1", label: "Bob" } }]),
  ),
  mathInline: docOf(paragraph([{ type: "mathInline", attrs: { text: "x^2" } }])),
  mathBlock: docOf({ type: "mathBlock", attrs: { text: "x^2" } }),
  details: docOf({
    type: "details",
    content: [
      { type: "detailsSummary", content: [text("Summary")] },
      { type: "detailsContent", content: [paragraph([text("body")])] },
    ],
  }),
  attachment: docOf({
    type: "attachment",
    attrs: { url: "http://x/f.zip", name: "f.zip" },
  }),
  video: docOf({ type: "video", attrs: { src: "http://x/v.mp4" } }),
  youtube: docOf({ type: "youtube", attrs: { src: "http://y/watch" } }),
  embed: docOf({ type: "embed", attrs: { src: "http://e", provider: "iframe" } }),
  htmlEmbed: docOf({
    type: "htmlEmbed",
    attrs: { source: "<script>track()</script>", height: 320 },
  }),
  drawio: docOf({ type: "drawio", attrs: { src: "http://d" } }),
  excalidraw: docOf({ type: "excalidraw", attrs: { src: "http://e" } }),
  columns: docOf({
    type: "columns",
    content: [
      { type: "column", content: [paragraph([text("c1")])] },
      { type: "column", content: [paragraph([text("c2")])] },
    ],
  }),
  subpages: docOf({ type: "subpages" }),
  audio: docOf({ type: "audio", attrs: { src: "http://a.mp3" } }),
  pdf: docOf({ type: "pdf", attrs: { src: "http://p.pdf" } }),
  pageBreak: docOf({ type: "pageBreak" }),
};

for (const [name, doc] of Object.entries(cases)) {
  test(`toYdoc accepts a ${name} node without throwing`, () => {
    assert.doesNotThrow(() => {
      TiptapTransformer.toYdoc(doc, "default", docmostExtensions);
    });
  });
}

// htmlEmbed is the sandboxed raw-HTML block. The MCP write path carries it
// through Yjs (toYdoc -> fromYdoc) without rendering, so a full round-trip must
// preserve both the `source` snippet and the numeric `height`.
test("htmlEmbed round-trips source and height through Yjs", () => {
  const doc = docOf({
    type: "htmlEmbed",
    attrs: { source: "<iframe src='x'></iframe>", height: 480 },
  });
  const ydoc = TiptapTransformer.toYdoc(doc, "default", docmostExtensions);
  const back = TiptapTransformer.fromYdoc(ydoc, "default");
  const node = back.content.find((n) => n.type === "htmlEmbed");
  assert.ok(node, "htmlEmbed node survives the round-trip");
  assert.equal(node.attrs.source, "<iframe src='x'></iframe>");
  assert.equal(node.attrs.height, 480);
});
