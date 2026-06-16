import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOutline, getNodeByRef } from "../../build/lib/node-ops.js";

// Helpers to build the small fixture doc.
const textNode = (text) => ({ type: "text", text });
const paragraph = (id, text) => ({
  type: "paragraph",
  attrs: { id },
  content: [textNode(text)],
});
// A table cell holds a paragraph; cells/rows/table carry NO attrs.id.
const cell = (text) => ({
  type: "tableCell",
  content: [{ type: "paragraph", content: [textNode(text)] }],
});
const row = (...texts) => ({
  type: "tableRow",
  content: texts.map(cell),
});
const listItem = (text) => ({
  type: "listItem",
  content: [{ type: "paragraph", content: [textNode(text)] }],
});

// A long paragraph to exercise truncation (>100 chars).
const longText = "x".repeat(150);

const buildDoc = () => ({
  type: "doc",
  content: [
    { type: "heading", attrs: { id: "h1", level: 2 }, content: [textNode("Title")] },
    paragraph("p1", longText),
    {
      type: "table",
      content: [row("A", "B", "C"), row("1", "2", "3")],
    },
    {
      type: "bulletList",
      attrs: { id: "list1" },
      content: [listItem("one"), listItem("two")],
    },
  ],
});

test("buildOutline returns one compact entry per top-level block", () => {
  const outline = buildOutline(buildDoc());
  assert.equal(outline.length, 4);

  // Heading: level + id + firstText.
  assert.equal(outline[0].type, "heading");
  assert.equal(outline[0].level, 2);
  assert.equal(outline[0].id, "h1");
  assert.equal(outline[0].firstText, "Title");

  // Long paragraph text is truncated to 100 chars + ellipsis.
  assert.equal(outline[1].id, "p1");
  assert.equal(outline[1].firstText, "x".repeat(100) + "…");
  assert.equal(outline[1].firstText.length, 101);

  // Table: rows/cols/header from the first row; no id on the table itself.
  assert.equal(outline[2].type, "table");
  assert.equal(outline[2].rows, 2);
  assert.equal(outline[2].cols, 3);
  assert.deepEqual(outline[2].header, ["A", "B", "C"]);
  assert.equal(outline[2].id, null);

  // List: item count.
  assert.equal(outline[3].type, "bulletList");
  assert.equal(outline[3].items, 2);
});

test("buildOutline is null-safe", () => {
  assert.deepEqual(buildOutline(undefined), []);
  assert.deepEqual(buildOutline({ type: "doc" }), []);
  assert.deepEqual(buildOutline(42), []);
});

test("getNodeByRef resolves a block id to its node and path", () => {
  const doc = buildDoc();
  const hit = getNodeByRef(doc, "h1");
  assert.ok(hit);
  assert.equal(hit.type, "heading");
  assert.deepEqual(hit.path, [0]);
  assert.equal(hit.node.attrs.id, "h1");
});

test("getNodeByRef resolves #<index> to a top-level block (table)", () => {
  const doc = buildDoc();
  const hit = getNodeByRef(doc, "#2");
  assert.ok(hit);
  assert.equal(hit.type, "table");
  assert.deepEqual(hit.path, [2]);
});

test("getNodeByRef returns null for an unknown ref", () => {
  assert.equal(getNodeByRef(buildDoc(), "nope"), null);
});

test("getNodeByRef returns a clone (mutating it does not change the input)", () => {
  const doc = buildDoc();
  const hit = getNodeByRef(doc, "h1");
  hit.node.attrs.id = "MUTATED";
  hit.node.content[0].text = "changed";
  // Original doc is untouched.
  assert.equal(doc.content[0].attrs.id, "h1");
  assert.equal(doc.content[0].content[0].text, "Title");
});
