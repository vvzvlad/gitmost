// #413: unit tests for the markdown-fragment helpers used by patchNode/insertNode.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  importMarkdownFragment,
  canBeDocChild,
  findUnrepresentableTableAttrs,
} from "../../build/lib/markdown-fragment.js";

function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content))
    for (const c of node.content) findAll(c, type, acc);
  return acc;
}

test("importMarkdownFragment: plain markdown -> blocks, no definitions", async () => {
  const { blocks, definitions } = await importMarkdownFragment(
    "first\n\nsecond",
  );
  assert.equal(blocks.length, 2);
  assert.equal(definitions.length, 0);
  assert.equal(blocks[0].type, "paragraph");
});

test("importMarkdownFragment: `^[...]` footnote -> a definition + a remapped ref", async () => {
  const { blocks, definitions } = await importMarkdownFragment(
    "a claim^[the note]",
  );
  assert.equal(definitions.length, 1);
  const refs = findAll({ type: "doc", content: blocks }, "footnoteReference");
  assert.equal(refs.length, 1);
  // The reference id must match the (remapped) definition id.
  assert.equal(refs[0].attrs.id, definitions[0].attrs.id);
  // The id is NOT the importer's sequential "fn-1" — it was remapped to a fresh
  // uuid so it cannot collide with a page footnote of the same number.
  assert.notEqual(refs[0].attrs.id, "fn-1");
});

test("importMarkdownFragment: whitespace markdown imports to a single empty paragraph", async () => {
  // The importer yields one empty paragraph for whitespace-only input (not zero
  // blocks), so the fragment path returns that block. The client's XOR guard
  // (markdown.trim() !== "") is what rejects an empty-string patch up front, so
  // importMarkdownFragment never sees a truly empty string via patch/insert.
  const { blocks, definitions } = await importMarkdownFragment("   \n  ");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(definitions.length, 0);
});

test("canBeDocChild: paragraph/heading/table are doc children; tableRow/cell are not", () => {
  assert.equal(canBeDocChild("paragraph"), true);
  assert.equal(canBeDocChild("heading"), true);
  assert.equal(canBeDocChild("table"), true);
  assert.equal(canBeDocChild("tableRow"), false);
  assert.equal(canBeDocChild("tableCell"), false);
  assert.equal(canBeDocChild("tableHeader"), false);
  assert.equal(canBeDocChild("text"), false);
  assert.equal(canBeDocChild(undefined), false);
  assert.equal(canBeDocChild("notARealType"), false);
});

const cell = (attrs, text) => ({
  type: "tableCell",
  attrs,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

test("findUnrepresentableTableAttrs: null for a plain paragraph and a simple table", () => {
  assert.equal(
    findUnrepresentableTableAttrs({
      type: "paragraph",
      content: [{ type: "text", text: "x" }],
    }),
    null,
  );
  const simpleTable = {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [cell({ colspan: 1, rowspan: 1 }, "a")],
      },
    ],
  };
  assert.equal(findUnrepresentableTableAttrs(simpleTable), null);
});

test("findUnrepresentableTableAttrs: flags colspan/rowspan/colwidth/backgroundColor", () => {
  const mk = (attrs) => ({
    type: "table",
    content: [{ type: "tableRow", content: [cell(attrs, "a")] }],
  });
  assert.match(findUnrepresentableTableAttrs(mk({ colspan: 2 })), /colspan/);
  assert.match(findUnrepresentableTableAttrs(mk({ rowspan: 2 })), /rowspan/);
  assert.match(
    findUnrepresentableTableAttrs(mk({ colwidth: [120] })),
    /colwidth/,
  );
  assert.match(
    findUnrepresentableTableAttrs(mk({ backgroundColor: "#eee" })),
    /backgroundColor/,
  );
});

test("findUnrepresentableTableAttrs: finds a span nested deep (table inside a callout)", () => {
  const doc = {
    type: "callout",
    content: [
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell({ colspan: 3 }, "wide")] },
        ],
      },
    ],
  };
  assert.match(findUnrepresentableTableAttrs(doc), /colspan/);
});
