// Extra media round-trip coverage (issue #244), complementing
// media-roundtrip.test.mjs.
//
// The existing media-roundtrip.test.mjs already asserts that video, youtube,
// embed, excalidraw, audio and pdf SURVIVE a PM -> markdown -> PM round-trip and
// keeps their identifying src / provider / name / attachmentId. It does NOT,
// however, exercise:
//   * the `drawio` node (a distinct schema node that shares the excalidraw
//     converter case) — not covered at all;
//   * the dimension / layout attributes (width, height, align) that ride in
//     data-* attributes — exactly where a converter<->schema mismatch silently
//     drops a value while the node itself survives;
//   * attribute escaping for a src containing `"` (escapeAttr) — a malformed
//     value here would either break the round-trip or inject HTML.
//
// These are the gaps this file locks down.
import { test } from "node:test";
import assert from "node:assert/strict";

import { convertProseMirrorToMarkdown } from "../../build/lib/markdown-converter.js";
import { markdownToProseMirror } from "../../build/lib/collaboration.js";

const doc = (...content) => ({ type: "doc", content });

const findAll = (node, type, acc = []) => {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  for (const c of node.content || []) findAll(c, type, acc);
  return acc;
};

// PM node -> markdown -> PM; return both the markdown and the matching nodes.
const roundtrip = async (node, type) => {
  const md = convertProseMirrorToMarkdown(doc(node));
  const pm = await markdownToProseMirror(md);
  return { md, found: findAll(pm, type) };
};

// ---------------------------------------------------------------------------
// drawio: a separate schema node sharing the excalidraw converter case. Not
// covered by the existing file at all, so guard its full round-trip here.
// ---------------------------------------------------------------------------
test("round-trip: drawio diagram survives with src, title, dimensions, align, attachmentId", async () => {
  const { md, found } = await roundtrip(
    {
      type: "drawio",
      attrs: {
        src: "/api/files/d.drawio",
        title: "Flow",
        width: 400,
        height: 300,
        align: "left",
        attachmentId: "dz1",
      },
    },
    "drawio",
  );
  // The converter must emit the schema-matching div[data-type="drawio"].
  assert.match(md, /data-type="drawio"/);
  assert.equal(found.length, 1, "drawio node must survive the round-trip");
  const a = found[0].attrs;
  assert.equal(a.src, "/api/files/d.drawio");
  assert.equal(a.title, "Flow");
  assert.equal(a.attachmentId, "dz1");
  assert.equal(a.align, "left");
  // Numeric dimensions come back as strings via the schema parseHTML.
  assert.equal(String(a.width), "400");
  assert.equal(String(a.height), "300");
});

// ---------------------------------------------------------------------------
// Dimension + align attrs ride in data-* (or width/height) attributes. The
// existing file checks only src/provider/name/attachmentId, so a dropped
// width/height/align would pass there but fail here.
// ---------------------------------------------------------------------------
test("round-trip: youtube preserves width/height/align (data-* attrs)", async () => {
  const { found } = await roundtrip(
    { type: "youtube", attrs: { src: "https://youtube.com/watch?v=x", width: 560, height: 315, align: "left" } },
    "youtube",
  );
  assert.equal(found.length, 1);
  const a = found[0].attrs;
  assert.equal(String(a.width), "560");
  assert.equal(String(a.height), "315");
  assert.equal(a.align, "left");
});

test("round-trip: embed preserves provider, width/height and align", async () => {
  const { found } = await roundtrip(
    { type: "embed", attrs: { src: "https://e.com/x", provider: "iframe", width: 600, height: 480, align: "right" } },
    "embed",
  );
  assert.equal(found.length, 1);
  const a = found[0].attrs;
  assert.equal(a.provider, "iframe");
  assert.equal(String(a.width), "600");
  assert.equal(String(a.height), "480");
  assert.equal(a.align, "right");
});

test("round-trip: video preserves width/height and align (data-align)", async () => {
  const { found } = await roundtrip(
    { type: "video", attrs: { src: "/api/files/v.mp4", attachmentId: "att1", width: 640, height: 360, align: "right" } },
    "video",
  );
  assert.equal(found.length, 1);
  const a = found[0].attrs;
  assert.equal(String(a.width), "640");
  assert.equal(String(a.height), "360");
  assert.equal(a.align, "right");
});

test("round-trip: pdf preserves width/height (standard attrs) plus name", async () => {
  const { found } = await roundtrip(
    { type: "pdf", attrs: { src: "/api/files/x.pdf", name: "x.pdf", attachmentId: "a4", width: 700, height: 900 } },
    "pdf",
  );
  assert.equal(found.length, 1);
  const a = found[0].attrs;
  assert.equal(a.name, "x.pdf");
  assert.equal(String(a.width), "700");
  assert.equal(String(a.height), "900");
});

// ---------------------------------------------------------------------------
// Escaping: a src containing a double quote must survive the attribute-quoted
// HTML emission (escapeAttr) and re-parse to the exact original value, with no
// node loss and no HTML injection.
// ---------------------------------------------------------------------------
test("round-trip: a src containing a double quote is escaped and recovered intact", async () => {
  const tricky = 'https://e.com/x?a="b"&c=1';
  const { found } = await roundtrip({ type: "youtube", attrs: { src: tricky } }, "youtube");
  assert.equal(found.length, 1, "node must survive a quote-bearing src");
  assert.equal(found[0].attrs.src, tricky, "the exact src is recovered");
});
