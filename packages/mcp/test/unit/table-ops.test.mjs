import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readTable,
  insertTableRow,
  deleteTableRow,
  updateTableCell,
} from "../../build/lib/node-ops.js";

// ---------------------------------------------------------------------------
// Builders. Tables/rows/cells carry NO attrs.id — only the paragraph inside a
// cell does. A cell holds a single plain-text paragraph.
// ---------------------------------------------------------------------------
const textNode = (text) => ({ type: "text", text });
const para = (id, text) => ({
  type: "paragraph",
  attrs: { id, indent: 0 },
  content: text ? [textNode(text)] : [],
});
const cell = (paraId, text, colwidth) => ({
  type: "tableCell",
  attrs: { colspan: 1, rowspan: 1, ...(colwidth ? { colwidth } : {}) },
  content: [para(paraId, text)],
});
const row = (...cells) => ({ type: "tableRow", content: cells });
const doc = (...children) => ({ type: "doc", content: children });
const snapshot = (v) => JSON.parse(JSON.stringify(v));

// Heading at index 0, a 3x3 table at index 1.
// Header row "A"/"B"/"C" with colwidths [120]/[200]/[150]; two data rows.
const makeDoc = () =>
  doc(
    { type: "heading", attrs: { id: "h1", level: 1 }, content: [textNode("Title")] },
    {
      type: "table",
      content: [
        row(
          cell("hpA", "A", [120]),
          cell("hpB", "B", [200]),
          cell("hpC", "C", [150]),
        ),
        row(cell("p10", "r1c0"), cell("p11", "r1c1"), cell("p12", "r1c2")),
        row(cell("p20", "r2c0"), cell("p21", "r2c1"), cell("p22", "r2c2")),
      ],
    },
  );

// Gather every attrs.id present anywhere in a doc.
const allIds = (node, acc = new Set()) => {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    if (node.attrs && typeof node.attrs.id === "string") acc.add(node.attrs.id);
    if (Array.isArray(node.content)) node.content.forEach((c) => allIds(c, acc));
  }
  return acc;
};

// ---------------------------------------------------------------------------
// readTable
// ---------------------------------------------------------------------------

test("readTable('#1') returns the 3x3 matrix, cell ids, and path", () => {
  const t = readTable(makeDoc(), "#1");
  assert.ok(t);
  assert.equal(t.rows, 3);
  assert.equal(t.cols, 3);
  assert.deepEqual(t.cells, [
    ["A", "B", "C"],
    ["r1c0", "r1c1", "r1c2"],
    ["r2c0", "r2c1", "r2c2"],
  ]);
  assert.deepEqual(t.cellIds, [
    ["hpA", "hpB", "hpC"],
    ["p10", "p11", "p12"],
    ["p20", "p21", "p22"],
  ]);
  assert.deepEqual(t.path, [1]);
});

test("readTable(<cell paragraph id>) resolves the enclosing table", () => {
  const t = readTable(makeDoc(), "p21"); // a paragraph inside a data cell
  assert.ok(t);
  assert.equal(t.rows, 3);
  assert.equal(t.cols, 3);
  assert.deepEqual(t.path, [1]);
});

test("readTable on a non-table block / unknown ref returns null", () => {
  assert.equal(readTable(makeDoc(), "#0"), null); // heading, not a table
  assert.equal(readTable(makeDoc(), "nope"), null); // no such id
});

// ---------------------------------------------------------------------------
// insertTableRow
// ---------------------------------------------------------------------------

test("insertTableRow appends a 4th row, copies header colwidths, fresh unique ids", () => {
  const input = makeDoc();
  const snap = snapshot(input);
  const existingIds = allIds(input);

  const { doc: out, inserted } = insertTableRow(input, "#1", ["x", "y", "z"]);
  assert.equal(inserted, true);

  // Input not mutated.
  assert.deepEqual(input, snap);

  const tbl = out.content[1];
  assert.equal(tbl.content.length, 4);
  const newRow = tbl.content[3];
  assert.equal(newRow.type, "tableRow");
  assert.equal(newRow.content.length, 3);

  // Cell texts.
  assert.deepEqual(
    newRow.content.map((c) => c.content[0].content[0]?.text),
    ["x", "y", "z"],
  );
  // Colwidths copied from the header row.
  assert.deepEqual(
    newRow.content.map((c) => c.attrs.colwidth),
    [[120], [200], [150]],
  );
  // colspan/rowspan present.
  for (const c of newRow.content) {
    assert.equal(c.attrs.colspan, 1);
    assert.equal(c.attrs.rowspan, 1);
  }

  // New paragraph ids are unique and not equal to any existing id.
  const newIds = newRow.content.map((c) => c.content[0].attrs.id);
  assert.equal(new Set(newIds).size, 3);
  for (const id of newIds) {
    assert.ok(typeof id === "string" && id.length > 0);
    assert.equal(existingIds.has(id), false);
  }
});

test("insertTableRow at index 0 inserts before the header and pads to 3 cells", () => {
  const { doc: out, inserted } = insertTableRow(makeDoc(), "#1", ["x"], 0);
  assert.equal(inserted, true);

  const tbl = out.content[1];
  assert.equal(tbl.content.length, 4);
  const newRow = tbl.content[0]; // inserted at the front
  assert.equal(newRow.content.length, 3);
  // First cell "x", remaining two empty.
  assert.deepEqual(
    newRow.content.map((c) => c.content[0].content.length),
    [1, 0, 0],
  );
  assert.equal(newRow.content[0].content[0].content[0].text, "x");
});

test("insertTableRow throws when given more cells than columns", () => {
  assert.throws(
    () => insertTableRow(makeDoc(), "#1", ["a", "b", "c", "d"]),
    /table_insert_row: got 4 cell\(s\) but the table has 3 column\(s\)/,
  );
});

test("insertTableRow on a missing table returns inserted:false", () => {
  const { inserted } = insertTableRow(makeDoc(), "#0", ["x"]);
  assert.equal(inserted, false);
});

// A header cell uses type "tableHeader" (vs. "tableCell" for data cells).
const headerCell = (paraId, text, colwidth) => ({
  type: "tableHeader",
  attrs: { colspan: 1, rowspan: 1, ...(colwidth ? { colwidth } : {}) },
  content: [para(paraId, text)],
});

// Table whose first row uses tableHeader cells.
const makeHeaderDoc = () =>
  doc({
    type: "table",
    content: [
      row(headerCell("hA", "A"), headerCell("hB", "B")),
      row(cell("p10", "r1c0"), cell("p11", "r1c1")),
    ],
  });

test("insertTableRow at index 0 inherits the header cell type (tableHeader)", () => {
  const { doc: out, inserted } = insertTableRow(makeHeaderDoc(), "#0", ["x", "y"], 0);
  assert.equal(inserted, true);

  const tbl = out.content[0];
  const newRow = tbl.content[0]; // landed at index 0
  // The new row's cells inherit the header type.
  assert.deepEqual(
    newRow.content.map((c) => c.type),
    ["tableHeader", "tableHeader"],
  );
  assert.equal(newRow.content[0].content[0].content[0].text, "x");
});

test("insertTableRow append produces data cells (tableCell), not header cells", () => {
  const { doc: out, inserted } = insertTableRow(makeHeaderDoc(), "#0", ["x", "y"]);
  assert.equal(inserted, true);

  const tbl = out.content[0];
  const newRow = tbl.content[tbl.content.length - 1]; // appended last
  assert.deepEqual(
    newRow.content.map((c) => c.type),
    ["tableCell", "tableCell"],
  );
});

// Ragged table: row 0 has 2 cols, a later row has 3.
const makeRaggedDoc = () =>
  doc({
    type: "table",
    content: [
      row(cell("a0", "a0"), cell("a1", "a1")),
      row(cell("b0", "b0"), cell("b1", "b1"), cell("b2", "b2")),
    ],
  });

test("insertTableRow uses the max column count across all rows (ragged table)", () => {
  // colCount is 3 (the widest row), so 3 cells are accepted...
  const { doc: out, inserted } = insertTableRow(makeRaggedDoc(), "#0", ["x", "y", "z"]);
  assert.equal(inserted, true);
  const tbl = out.content[0];
  const newRow = tbl.content[tbl.content.length - 1];
  assert.equal(newRow.content.length, 3);
  assert.deepEqual(
    newRow.content.map((c) => c.content[0].content[0]?.text),
    ["x", "y", "z"],
  );

  // ...but 4 cells exceed the widest row and throw.
  assert.throws(
    () => insertTableRow(makeRaggedDoc(), "#0", ["a", "b", "c", "d"]),
    /table_insert_row: got 4 cell\(s\) but the table has 3 column\(s\)/,
  );
});

test("insertTableRow into an empty table uses colCount = supplied cells", () => {
  const empty = doc({ type: "table", content: [] });
  const { doc: out, inserted } = insertTableRow(empty, "#0", ["x", "y", "z"]);
  assert.equal(inserted, true);
  const tbl = out.content[0];
  assert.equal(tbl.content.length, 1);
  assert.equal(tbl.content[0].content.length, 3);
  assert.deepEqual(
    tbl.content[0].content.map((c) => c.content[0].content[0]?.text),
    ["x", "y", "z"],
  );
});

test("insertTableRow mints 12-char [a-z0-9] ids that are unique and non-colliding", () => {
  const input = makeDoc();
  const existingIds = allIds(input);
  const { doc: out } = insertTableRow(input, "#1", ["x", "y", "z"]);

  const tbl = out.content[1];
  const newRow = tbl.content[tbl.content.length - 1];
  const newIds = newRow.content.map((c) => c.content[0].attrs.id);

  // Docmost-style: exactly 12 chars from lowercase a-z0-9.
  for (const id of newIds) {
    assert.match(id, /^[a-z0-9]{12}$/);
    assert.equal(existingIds.has(id), false); // no collision with the doc
  }
  // All distinct within the new row.
  assert.equal(new Set(newIds).size, newIds.length);
});

// ---------------------------------------------------------------------------
// deleteTableRow
// ---------------------------------------------------------------------------

test("deleteTableRow removes the 3rd row -> rows:2", () => {
  const { doc: out, deleted } = deleteTableRow(makeDoc(), "#1", 2);
  assert.equal(deleted, true);
  const tbl = out.content[1];
  assert.equal(tbl.content.length, 2);
  // The removed row was the second data row (r2*).
  assert.deepEqual(
    tbl.content.map((r) => r.content[0].content[0].content[0]?.text ?? ""),
    ["A", "r1c0"],
  );
});

test("deleteTableRow out-of-range index throws", () => {
  assert.throws(
    () => deleteTableRow(makeDoc(), "#1", 9),
    /table_delete_row: row index 9 out of range \(table has 3 row\(s\)\)/,
  );
});

test("deleteTableRow refuses to delete the only row", () => {
  const single = doc({
    type: "table",
    content: [row(cell("only", "x"))],
  });
  assert.throws(
    () => deleteTableRow(single, "#0", 0),
    /refusing to delete the only row of the table/,
  );
});

// ---------------------------------------------------------------------------
// updateTableCell
// ---------------------------------------------------------------------------

test("updateTableCell sets cell [1,1] to 'Z' and preserves the paragraph id", () => {
  const input = makeDoc();
  const snap = snapshot(input);
  const { doc: out, updated } = updateTableCell(input, "#1", 1, 1, "Z");
  assert.equal(updated, true);

  // Input not mutated.
  assert.deepEqual(input, snap);

  const targetCell = out.content[1].content[1].content[1];
  assert.equal(targetCell.content.length, 1);
  const p = targetCell.content[0];
  assert.equal(p.type, "paragraph");
  assert.equal(p.attrs.id, "p11"); // preserved
  assert.equal(p.content[0].text, "Z");

  // Cell attrs preserved.
  assert.equal(targetCell.attrs.colspan, 1);
  assert.equal(targetCell.attrs.rowspan, 1);
});

test("updateTableCell out-of-range row/col throws", () => {
  assert.throws(
    () => updateTableCell(makeDoc(), "#1", 9, 0, "x"),
    /table_update_cell: cell \[9,0\] out of range/,
  );
  assert.throws(
    () => updateTableCell(makeDoc(), "#1", 0, 9, "x"),
    /table_update_cell: cell \[0,9\] out of range/,
  );
});
