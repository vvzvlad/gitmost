import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blockPlainText,
  replaceNodeById,
  deleteNodeById,
  insertNodeRelative,
} from "../../build/lib/node-ops.js";

// ProseMirror builders. Blocks carry a stable id in attrs.id.
const textNode = (text) => ({ type: "text", text });
const para = (id, ...children) => ({
  type: "paragraph",
  attrs: { id },
  content: children,
});
const doc = (...children) => ({ type: "doc", content: children });
const snapshot = (v) => JSON.parse(JSON.stringify(v));

// A callout / table-cell wraps its children in `content`, just like any other
// block, so recursion reaches a paragraph nested inside it.
const callout = (id, ...children) => ({
  type: "callout",
  attrs: { id, type: "info" },
  content: children,
});
const tableDoc = (innerPara) =>
  doc({
    type: "table",
    attrs: { id: "table-1" },
    content: [
      {
        type: "tableRow",
        attrs: { id: "row-1" },
        content: [
          {
            type: "tableCell",
            attrs: { id: "cell-1" },
            content: [innerPara],
          },
        ],
      },
    ],
  });

// ---------------------------------------------------------------------------
// blockPlainText
// ---------------------------------------------------------------------------

test("blockPlainText concatenates nested text", () => {
  const node = {
    type: "callout",
    content: [
      para("p-1", textNode("Hello "), textNode("world")),
      para("p-2", textNode("!")),
    ],
  };
  assert.equal(blockPlainText(node), "Hello world!");
});

test("blockPlainText returns '' for nullish / non-object", () => {
  assert.equal(blockPlainText(null), "");
  assert.equal(blockPlainText(undefined), "");
  assert.equal(blockPlainText("just a string"), "");
});

test("blockPlainText reads a bare text node", () => {
  assert.equal(blockPlainText(textNode("solo")), "solo");
});

// ---------------------------------------------------------------------------
// replaceNodeById
// ---------------------------------------------------------------------------

test("replaceNodeById replaces the matching block and leaves others, count===1", () => {
  const input = doc(
    para("p-1", textNode("one")),
    para("p-2", textNode("two")),
    para("p-3", textNode("three")),
  );
  const newNode = para("p-2", textNode("REPLACED"));

  const { doc: out, replaced } = replaceNodeById(input, "p-2", newNode);

  assert.equal(replaced, 1);
  // Target replaced.
  assert.equal(out.content[1].content[0].text, "REPLACED");
  // Siblings untouched (text and ids).
  assert.equal(out.content[0].content[0].text, "one");
  assert.equal(out.content[2].content[0].text, "three");
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["p-1", "p-2", "p-3"],
  );
});

test("replaceNodeById on no-match returns replaced===0 and does not throw", () => {
  const input = doc(para("p-1", textNode("one")));
  const { doc: out, replaced } = replaceNodeById(
    input,
    "missing",
    para("x", textNode("x")),
  );
  assert.equal(replaced, 0);
  // Document content is preserved.
  assert.equal(out.content[0].content[0].text, "one");
});

test("replaceNodeById replaces EVERY node sharing the id (count reflects all)", () => {
  const input = doc(
    para("dup", textNode("a")),
    para("dup", textNode("b")),
    para("keep", textNode("c")),
  );
  const { doc: out, replaced } = replaceNodeById(
    input,
    "dup",
    para("dup", textNode("NEW")),
  );
  assert.equal(replaced, 2);
  assert.equal(out.content[0].content[0].text, "NEW");
  assert.equal(out.content[1].content[0].text, "NEW");
  assert.equal(out.content[2].content[0].text, "c");
  // The two replacements must not share a reference (deep clone per match).
  assert.notEqual(out.content[0], out.content[1]);
});

test("replaceNodeById reaches a node nested inside a callout", () => {
  const input = doc(callout("c-1", para("inner", textNode("old"))));
  const { doc: out, replaced } = replaceNodeById(
    input,
    "inner",
    para("inner", textNode("new")),
  );
  assert.equal(replaced, 1);
  assert.equal(out.content[0].content[0].content[0].text, "new");
});

test("replaceNodeById reaches a node nested inside a table cell", () => {
  const input = tableDoc(para("deep", textNode("before")));
  const { doc: out, replaced } = replaceNodeById(
    input,
    "deep",
    para("deep", textNode("after")),
  );
  assert.equal(replaced, 1);
  const cellPara = out.content[0].content[0].content[0].content[0];
  assert.equal(cellPara.content[0].text, "after");
});

test("replaceNodeById does NOT mutate input (deep-equal snapshot)", () => {
  const input = doc(
    para("p-1", textNode("one")),
    callout("c-1", para("inner", textNode("old"))),
  );
  const snap = snapshot(input);
  const { doc: out } = replaceNodeById(
    input,
    "inner",
    para("inner", textNode("changed")),
  );
  assert.deepEqual(input, snap);
  assert.notEqual(out, input);
});

// ---------------------------------------------------------------------------
// deleteNodeById
// ---------------------------------------------------------------------------

test("deleteNodeById removes the block and reports deleted===1", () => {
  const input = doc(
    para("p-1", textNode("one")),
    para("p-2", textNode("two")),
    para("p-3", textNode("three")),
  );
  const { doc: out, deleted } = deleteNodeById(input, "p-2");
  assert.equal(deleted, 1);
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["p-1", "p-3"],
  );
});

test("deleteNodeById on no-match returns deleted===0 and leaves content", () => {
  const input = doc(para("p-1", textNode("one")));
  const { doc: out, deleted } = deleteNodeById(input, "missing");
  assert.equal(deleted, 0);
  assert.equal(out.content.length, 1);
});

test("deleteNodeById removes a node nested inside a callout", () => {
  const input = doc(
    callout("c-1", para("inner", textNode("x")), para("keep", textNode("y"))),
  );
  const { doc: out, deleted } = deleteNodeById(input, "inner");
  assert.equal(deleted, 1);
  assert.deepEqual(
    out.content[0].content.map((n) => n.attrs.id),
    ["keep"],
  );
});

test("deleteNodeById removes EVERY node sharing the id", () => {
  const input = doc(
    para("dup", textNode("a")),
    para("keep", textNode("b")),
    para("dup", textNode("c")),
  );
  const { doc: out, deleted } = deleteNodeById(input, "dup");
  assert.equal(deleted, 2);
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["keep"],
  );
});

test("deleteNodeById does NOT mutate input (deep-equal snapshot)", () => {
  const input = doc(
    para("p-1", textNode("one")),
    para("p-2", textNode("two")),
  );
  const snap = snapshot(input);
  const { doc: out } = deleteNodeById(input, "p-2");
  assert.deepEqual(input, snap);
  assert.notEqual(out, input);
});

// ---------------------------------------------------------------------------
// insertNodeRelative
// ---------------------------------------------------------------------------

test("insertNodeRelative before by anchorNodeId", () => {
  const input = doc(para("p-1", textNode("one")), para("p-2", textNode("two")));
  const node = para("new", textNode("NEW"));
  const { doc: out, inserted } = insertNodeRelative(input, node, {
    position: "before",
    anchorNodeId: "p-2",
  });
  assert.equal(inserted, true);
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["p-1", "new", "p-2"],
  );
});

test("insertNodeRelative after by anchorNodeId", () => {
  const input = doc(para("p-1", textNode("one")), para("p-2", textNode("two")));
  const node = para("new", textNode("NEW"));
  const { doc: out, inserted } = insertNodeRelative(input, node, {
    position: "after",
    anchorNodeId: "p-1",
  });
  assert.equal(inserted, true);
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["p-1", "new", "p-2"],
  );
});

test("insertNodeRelative before/after by anchorNodeId reaches a nested sibling", () => {
  const input = doc(
    callout("c-1", para("a", textNode("a")), para("b", textNode("b"))),
  );
  const node = para("new", textNode("NEW"));
  const { doc: out, inserted } = insertNodeRelative(input, node, {
    position: "after",
    anchorNodeId: "a",
  });
  assert.equal(inserted, true);
  // Inserted as a sibling inside the callout's content array.
  assert.deepEqual(
    out.content[0].content.map((n) => n.attrs.id),
    ["a", "new", "b"],
  );
});

test("insertNodeRelative before by anchorText (top-level)", () => {
  const input = doc(
    para("p-1", textNode("alpha")),
    para("p-2", textNode("beta")),
  );
  const node = para("new", textNode("NEW"));
  const { doc: out, inserted } = insertNodeRelative(input, node, {
    position: "before",
    anchorText: "beta",
  });
  assert.equal(inserted, true);
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["p-1", "new", "p-2"],
  );
});

test("insertNodeRelative after by anchorText (top-level)", () => {
  const input = doc(
    para("p-1", textNode("alpha")),
    para("p-2", textNode("beta")),
  );
  const node = para("new", textNode("NEW"));
  const { doc: out, inserted } = insertNodeRelative(input, node, {
    position: "after",
    anchorText: "alpha",
  });
  assert.equal(inserted, true);
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["p-1", "new", "p-2"],
  );
});

test("insertNodeRelative anchorText scans TOP-LEVEL blocks via recursive plain text", () => {
  // anchorText matches the FIRST top-level block whose (recursive) blockPlainText
  // includes the string. "deeptext" lives nested in a top-level callout, so the
  // callout itself is the matched top-level block and the node lands as its
  // sibling at the top level (not inside the callout).
  const input = doc(
    callout("c-1", para("inner", textNode("deeptext"))),
    para("p-2", textNode("tail")),
  );
  const node = para("new", textNode("NEW"));
  const { doc: out, inserted } = insertNodeRelative(input, node, {
    position: "after",
    anchorText: "deeptext",
  });
  assert.equal(inserted, true);
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["c-1", "new", "p-2"],
  );
});

test("insertNodeRelative anchorText does NOT match text only present below top level when no top-level block contains it", () => {
  // The only block whose plain text includes "lonely" is a paragraph nested two
  // levels deep, but the top-level scan still sees it through the callout's
  // recursive plain text. To prove the scan is TOP-LEVEL (parent-array) only,
  // assert the insertion happens at the top level beside the callout, never
  // inside it.
  const input = doc(callout("c-1", para("inner", textNode("lonely word"))));
  const node = para("new", textNode("NEW"));
  const { doc: out, inserted } = insertNodeRelative(input, node, {
    position: "before",
    anchorText: "lonely",
  });
  assert.equal(inserted, true);
  // Inserted at the top level (siblings of the callout), not into the callout.
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["new", "c-1"],
  );
  // The callout's own children are untouched.
  assert.deepEqual(
    out.content[1].content.map((n) => n.attrs.id),
    ["inner"],
  );
});

test("insertNodeRelative append pushes the node at the end of top-level content", () => {
  const input = doc(para("p-1", textNode("one")), para("p-2", textNode("two")));
  const node = para("new", textNode("NEW"));
  const { doc: out, inserted } = insertNodeRelative(input, node, {
    position: "append",
  });
  assert.equal(inserted, true);
  assert.deepEqual(
    out.content.map((n) => n.attrs.id),
    ["p-1", "p-2", "new"],
  );
});

test("insertNodeRelative inserted===false when anchorNodeId missing", () => {
  const input = doc(para("p-1", textNode("one")));
  const node = para("new", textNode("NEW"));
  const { doc: out, inserted } = insertNodeRelative(input, node, {
    position: "after",
    anchorNodeId: "nope",
  });
  assert.equal(inserted, false);
  assert.deepEqual(out, input);
});

test("insertNodeRelative inserted===false when anchorText missing", () => {
  const input = doc(para("p-1", textNode("one")));
  const node = para("new", textNode("NEW"));
  const { inserted } = insertNodeRelative(input, node, {
    position: "before",
    anchorText: "nomatch",
  });
  assert.equal(inserted, false);
});

test("insertNodeRelative does NOT mutate input (deep-equal snapshot)", () => {
  const input = doc(para("p-1", textNode("one")), para("p-2", textNode("two")));
  const snap = snapshot(input);
  const node = para("new", textNode("NEW"));
  const { doc: out } = insertNodeRelative(input, node, {
    position: "after",
    anchorNodeId: "p-1",
  });
  assert.deepEqual(input, snap);
  assert.notEqual(out, input);
});
