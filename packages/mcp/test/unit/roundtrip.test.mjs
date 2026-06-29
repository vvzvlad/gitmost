// Round-trip regression tests: PM -> markdown -> PM must preserve rich nodes.
// These lock in the converter/schema fixes (math, mention, attachment, columns,
// nested blocks, text color) and the attribute-escaping idempotency fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertProseMirrorToMarkdown } from "../../build/lib/markdown-converter.js";
import { markdownToProseMirror } from "../../build/lib/collaboration.js";

const doc = (...content) => ({ type: "doc", content });
const para = (...content) => ({ type: "paragraph", content });
const text = (t, marks) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });

// Recursively collect nodes of a given type.
const findNodes = (node, type, acc = []) => {
  if (!node) return acc;
  if (node.type === type) acc.push(node);
  for (const c of node.content || []) findNodes(c, type, acc);
  return acc;
};
// Recursively collect the set of mark types present.
const markTypes = (node, acc = new Set()) => {
  if (!node) return acc;
  for (const m of node.marks || []) acc.add(m.type);
  for (const c of node.content || []) markTypes(c, acc);
  return acc;
};
const roundtrip = async (pmDoc) => markdownToProseMirror(convertProseMirrorToMarkdown(pmDoc));

test("round-trip: text color (textStyle mark) survives", async () => {
  const input = doc(para(text("colored", [{ type: "textStyle", attrs: { color: "red" } }])));
  const out = await roundtrip(input);
  const ts = findNodes(out, "text").flatMap((n) => n.marks || []).filter((m) => m.type === "textStyle");
  assert.ok(ts.length >= 1, "textStyle mark should survive");
  assert.equal(ts[0].attrs?.color, "red");
});

test("round-trip: mathInline with '<' survives and is idempotent", async () => {
  const input = doc(para(text("x"), { type: "mathInline", attrs: { text: "a < b \\leq c" } }));
  const md1 = convertProseMirrorToMarkdown(input);
  const md2 = convertProseMirrorToMarkdown(await markdownToProseMirror(md1));
  assert.equal(md1, md2, "markdown must be idempotent across a round-trip (no escape accumulation)");
  const out = await markdownToProseMirror(md1);
  const math = findNodes(out, "mathInline");
  assert.equal(math.length, 1, "mathInline node should survive");
  assert.equal(math[0].attrs?.text, "a < b \\leq c", "LaTeX (incl. '<') preserved exactly");
});

test("round-trip: mathBlock survives", async () => {
  const input = doc({ type: "mathBlock", attrs: { text: "E = mc^2" } });
  const out = await roundtrip(input);
  const math = findNodes(out, "mathBlock");
  assert.equal(math.length, 1);
  assert.equal(math[0].attrs?.text, "E = mc^2");
});

test("round-trip: mention node survives (not flattened to @text)", async () => {
  const input = doc(para(text("hi "), { type: "mention", attrs: { id: "u1", label: "Alice", entityType: "user", entityId: "u1" } }));
  const out = await roundtrip(input);
  assert.equal(findNodes(out, "mention").length, 1, "mention node should survive");
});

test("round-trip: attachment node survives with url + name", async () => {
  const input = doc({ type: "attachment", attrs: { url: "/api/files/x/report.pdf", name: "report.pdf", mime: "application/pdf" } });
  const out = await roundtrip(input);
  const att = findNodes(out, "attachment");
  assert.equal(att.length, 1, "attachment node should survive");
  assert.equal(att[0].attrs?.url, "/api/files/x/report.pdf");
  assert.equal(att[0].attrs?.name, "report.pdf");
});

test("round-trip: image inside a column survives as an image node (not literal markdown)", async () => {
  const input = doc({
    type: "columns",
    content: [
      { type: "column", content: [para(text("left")), { type: "image", attrs: { src: "/api/files/a/p.png", alt: "pic" } }] },
      { type: "column", content: [para(text("right"))] },
    ],
  });
  const out = await roundtrip(input);
  assert.equal(findNodes(out, "image").length, 1, "image inside a column must survive");
  // and it must NOT leak as literal markdown text
  assert.ok(!JSON.stringify(out).includes("![pic]"), "image must not become literal markdown text");
});

test("round-trip: captioned image inside a column preserves its caption (imageToHtml branch)", async () => {
  // A captioned image in a column is emitted via the imageToHtml helper (raw
  // HTML container), a different path from the top-level image case. Special
  // chars in the caption exercise attribute escaping on the way out and in.
  const caption = 'Tom & "Jerry"';
  const input = doc({
    type: "columns",
    content: [
      { type: "column", content: [{ type: "image", attrs: { src: "/api/files/a/p.png", alt: "pic", caption } }] },
      { type: "column", content: [para(text("right"))] },
    ],
  });
  const out = await roundtrip(input);
  const imgs = findNodes(out, "image");
  assert.equal(imgs.length, 1, "captioned image inside a column must survive");
  assert.equal(imgs[0].attrs?.caption, caption, "caption (incl. special chars) must be preserved");
});

test("round-trip: blockquote inside a column survives as a blockquote node", async () => {
  const input = doc({
    type: "columns",
    content: [
      { type: "column", content: [{ type: "blockquote", content: [para(text("quoted"))] }] },
      { type: "column", content: [para(text("r"))] },
    ],
  });
  const out = await roundtrip(input);
  assert.equal(findNodes(out, "blockquote").length, 1, "blockquote inside a column must survive");
});

test("round-trip: table cell with colspan>1 keeps the grid (HTML fallback)", async () => {
  const cell = (t, attrs = {}) => ({ type: "tableCell", attrs, content: [para(text(t))] });
  const header = (t) => ({ type: "tableHeader", attrs: {}, content: [para(text(t))] });
  const input = doc({
    type: "table",
    content: [
      { type: "tableRow", content: [header("A"), header("B")] },
      { type: "tableRow", content: [cell("wide", { colspan: 2 })] },
    ],
  });
  const out = await roundtrip(input);
  const tables = findNodes(out, "table");
  assert.equal(tables.length, 1, "table should survive");
  const spanned = findNodes(out, "tableCell").find((c) => (c.attrs?.colspan ?? 1) > 1);
  assert.ok(spanned, "colspan>1 cell should be preserved via the HTML fallback");
});

test("import: an unsafe highlight color (raw data-color) is sanitized to null (no style breakout)", async () => {
  // data-color is read verbatim (no CSSOM isolation), so it is the real
  // injection surface; a value with quotes/semicolons must be clamped to null.
  const out = await markdownToProseMirror('<mark data-color="red&quot;; background:url(x)">hi</mark>');
  const hl = findNodes(out, "text").flatMap((n) => n.marks || []).filter((m) => m.type === "highlight");
  assert.ok(hl.length >= 1, "highlight mark present");
  assert.equal(hl[0].attrs?.color ?? null, null, "unsafe color must be clamped to null");
});

test("import: a safe highlight color is preserved", async () => {
  const out = await markdownToProseMirror('<mark style="background-color: #ff0000">hi</mark>');
  const hl = findNodes(out, "text").flatMap((n) => n.marks || []).filter((m) => m.type === "highlight");
  assert.ok(hl.length >= 1);
  assert.equal(hl[0].attrs?.color, "#ff0000");
});

test("round-trip: attribute value with an apostrophe is idempotent (no &amp; accumulation)", async () => {
  const input = doc({ type: "attachment", attrs: { url: "/api/files/x/o'brien's file.pdf", name: "o'brien's file.pdf" } });
  const md1 = convertProseMirrorToMarkdown(input);
  const md2 = convertProseMirrorToMarkdown(await markdownToProseMirror(md1));
  assert.equal(md1, md2, "apostrophe in an attribute value must not accumulate escapes across round-trips");
  const att = findNodes(await markdownToProseMirror(md1), "attachment");
  assert.equal(att.length, 1);
  assert.equal(att[0].attrs?.name, "o'brien's file.pdf", "apostrophe preserved verbatim");
});

test("import: a colored span that is also a comment keeps the comment mark", async () => {
  const out = await markdownToProseMirror('<span data-comment-id="c1" style="color: red">x</span>');
  const marks = findNodes(out, "text").flatMap((n) => n.marks || []).map((m) => m.type);
  assert.ok(marks.includes("comment"), "comment mark must survive (textStyle must not steal the span)");
});

test("import: a colored mention span keeps the mention node", async () => {
  const out = await markdownToProseMirror('<span data-type="mention" data-id="u1" data-label="Alice" style="color: blue">@Alice</span>');
  assert.equal(findNodes(out, "mention").length, 1, "mention node must survive a colored span");
});
