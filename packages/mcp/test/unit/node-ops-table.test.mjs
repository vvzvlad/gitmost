import { test } from "node:test";
import assert from "node:assert/strict";

import {
  insertNodeRelative,
  sanitizeForYjs,
  findUnstorableAttr,
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

// A table cell holding a single paragraph.
const cell = (id, innerPara) => ({
  type: "tableCell",
  attrs: { id },
  content: [innerPara],
});
const row = (id, ...cells) => ({
  type: "tableRow",
  attrs: { id },
  content: cells,
});
const table = (id, ...rows) => ({
  type: "table",
  attrs: { id },
  content: rows,
});

// A 2x2 table: rows r1/r2, cells c1..c4, each cell holds a paragraph p1..p4.
const make2x2Table = () =>
  doc(
    table(
      "t1",
      row("r1", cell("c1", para("p1", textNode("A1"))), cell("c2", para("p2", textNode("A2")))),
      row("r2", cell("c3", para("p3", textNode("B1"))), cell("c4", para("p4", textNode("B2")))),
    ),
  );

const freshRow = () => row("rNEW", cell("cNEW", para("pNEW", textNode("NEW"))));
const freshCell = () => cell("cNEW", para("pNEW", textNode("NEW")));

// ---------------------------------------------------------------------------
// sanitizeForYjs
// ---------------------------------------------------------------------------

test("sanitizeForYjs strips undefined node-attr keys, preserves null/false/0/''", () => {
  const input = doc({
    type: "paragraph",
    attrs: {
      id: "p-1",
      gone: undefined,
      keptNull: null,
      keptFalse: false,
      keptZero: 0,
      keptEmpty: "",
    },
    content: [textNode("x")],
  });
  const out = sanitizeForYjs(input);
  const attrs = out.content[0].attrs;
  assert.equal("gone" in attrs, false);
  assert.equal("keptNull" in attrs, true);
  assert.equal(attrs.keptNull, null);
  assert.equal(attrs.keptFalse, false);
  assert.equal(attrs.keptZero, 0);
  assert.equal(attrs.keptEmpty, "");
  // Input must not be mutated.
  assert.equal("gone" in input.content[0].attrs, true);
});

test("sanitizeForYjs strips undefined mark-attr keys, preserves falsy values", () => {
  const input = doc({
    type: "paragraph",
    attrs: { id: "p-1" },
    content: [
      {
        type: "text",
        text: "x",
        marks: [
          {
            type: "link",
            attrs: { href: "", target: undefined, rel: null },
          },
        ],
      },
    ],
  });
  const out = sanitizeForYjs(input);
  const markAttrs = out.content[0].content[0].marks[0].attrs;
  assert.equal("target" in markAttrs, false);
  assert.equal(markAttrs.href, "");
  assert.equal(markAttrs.rel, null);
});

// ---------------------------------------------------------------------------
// findUnstorableAttr
// ---------------------------------------------------------------------------

test("findUnstorableAttr returns a path for an undefined node attr", () => {
  const input = doc(
    para("p-0", textNode("ok")),
    {
      type: "paragraph",
      attrs: { id: "p-1", indent: undefined },
      content: [textNode("y")],
    },
  );
  const hit = findUnstorableAttr(input);
  assert.equal(hit, "content[1].attrs.indent (undefined)");
});

test("findUnstorableAttr finds an unstorable mark attr", () => {
  const input = doc({
    type: "paragraph",
    attrs: { id: "p-1" },
    content: [
      {
        type: "text",
        text: "x",
        marks: [{ type: "link", attrs: { href: () => {} } }],
      },
    ],
  });
  const hit = findUnstorableAttr(input);
  assert.equal(hit, "content[0].content[0].marks[0].attrs.href (function)");
});

test("findUnstorableAttr returns null for a clean doc", () => {
  const input = doc(para("p-1", textNode("clean")));
  assert.equal(findUnstorableAttr(input), null);
});

// ---------------------------------------------------------------------------
// insertNodeRelative — table-structure-aware
// ---------------------------------------------------------------------------

test("insertNodeRelative inserting a tableRow anchored on a paragraph INSIDE a cell appends a sibling row to the table", () => {
  const input = make2x2Table();
  const { doc: out, inserted } = insertNodeRelative(input, freshRow(), {
    position: "after",
    anchorNodeId: "p4", // paragraph inside last cell of the last row
  });
  assert.equal(inserted, true);
  const tbl = out.content[0];
  // table.content length +1 (the row is a direct child of the table).
  assert.equal(tbl.content.length, 3);
  // The new row is a direct child of the table, NOT nested inside a cell.
  const newRow = tbl.content[2];
  assert.equal(newRow.type, "tableRow");
  assert.equal(newRow.attrs.id, "rNEW");
  // Existing rows' cells are intact.
  assert.deepEqual(
    tbl.content[0].content.map((c) => c.attrs.id),
    ["c1", "c2"],
  );
  assert.deepEqual(
    tbl.content[1].content.map((c) => c.attrs.id),
    ["c3", "c4"],
  );
  // Assert the new row is NOT nested inside any existing cell.
  for (const r of [tbl.content[0], tbl.content[1]]) {
    for (const c of r.content) {
      const ids = (c.content || []).map((n) => n.attrs?.id);
      assert.equal(ids.includes("rNEW"), false);
    }
  }
});

test("insertNodeRelative before/after place the new row at the correct index relative to the enclosing row", () => {
  // "before" the first row.
  {
    const input = make2x2Table();
    const { doc: out } = insertNodeRelative(input, freshRow(), {
      position: "before",
      anchorNodeId: "p1", // paragraph in first row
    });
    assert.deepEqual(
      out.content[0].content.map((r) => r.attrs.id),
      ["rNEW", "r1", "r2"],
    );
  }
  // "after" the first row.
  {
    const input = make2x2Table();
    const { doc: out } = insertNodeRelative(input, freshRow(), {
      position: "after",
      anchorNodeId: "p1", // paragraph in first row
    });
    assert.deepEqual(
      out.content[0].content.map((r) => r.attrs.id),
      ["r1", "rNEW", "r2"],
    );
  }
});

test("insertNodeRelative inserting a tableCell anchored inside a cell adds it to the enclosing row", () => {
  const input = make2x2Table();
  const { doc: out, inserted } = insertNodeRelative(input, freshCell(), {
    position: "after",
    anchorNodeId: "p1", // paragraph inside first cell of first row
  });
  assert.equal(inserted, true);
  // The cell is spliced into the enclosing row (r1) after c1.
  assert.deepEqual(
    out.content[0].content[0].content.map((c) => c.attrs.id),
    ["c1", "cNEW", "c2"],
  );
  // The other row is untouched.
  assert.deepEqual(
    out.content[0].content[1].content.map((c) => c.attrs.id),
    ["c3", "c4"],
  );
});

test("insertNodeRelative inserting a tableRow with an anchor NOT inside a table throws", () => {
  const input = doc(para("p-1", textNode("plain")));
  assert.throws(
    () =>
      insertNodeRelative(input, freshRow(), {
        position: "after",
        anchorNodeId: "p-1",
      }),
    /not inside a table/,
  );
});

test("insertNodeRelative append + tableRow throws", () => {
  const input = make2x2Table();
  assert.throws(
    () => insertNodeRelative(input, freshRow(), { position: "append" }),
    /cannot append a tableRow at the top level/,
  );
});

test("insertNodeRelative structural insert with unresolved anchor returns inserted:false (no throw)", () => {
  const input = make2x2Table();
  const { doc: out, inserted } = insertNodeRelative(input, freshRow(), {
    position: "after",
    anchorNodeId: "does-not-exist",
  });
  assert.equal(inserted, false);
  assert.deepEqual(out, input);
});

test("insertNodeRelative tableRow by anchorText resolving to the table block appends within the table", () => {
  const input = make2x2Table();
  // anchorText "A1" lives in the first cell; the matched top-level block is the
  // table itself, so the row appends at the end of the table.
  const { doc: out, inserted } = insertNodeRelative(input, freshRow(), {
    position: "after",
    anchorText: "A1",
  });
  assert.equal(inserted, true);
  assert.deepEqual(
    out.content[0].content.map((r) => r.attrs.id),
    ["r1", "r2", "rNEW"],
  );
});

// ---------------------------------------------------------------------------
// Regression: a normal (non-structural) paragraph insert is unchanged.
// ---------------------------------------------------------------------------

test("insertNodeRelative regression: normal paragraph before/after a top-level block behaves as before", () => {
  const before = doc(para("p-1", textNode("one")), para("p-2", textNode("two")));
  {
    const { doc: out, inserted } = insertNodeRelative(
      before,
      para("new", textNode("NEW")),
      { position: "before", anchorNodeId: "p-2" },
    );
    assert.equal(inserted, true);
    assert.deepEqual(
      out.content.map((n) => n.attrs.id),
      ["p-1", "new", "p-2"],
    );
  }
  {
    const snap = snapshot(before);
    const { doc: out, inserted } = insertNodeRelative(
      before,
      para("new", textNode("NEW")),
      { position: "after", anchorNodeId: "p-1" },
    );
    assert.equal(inserted, true);
    assert.deepEqual(
      out.content.map((n) => n.attrs.id),
      ["p-1", "new", "p-2"],
    );
    // Input not mutated.
    assert.deepEqual(before, snap);
  }
});
