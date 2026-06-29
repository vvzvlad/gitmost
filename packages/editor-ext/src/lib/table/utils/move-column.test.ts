import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { tableNodes, CellSelection } from "@tiptap/pm/tables";
import { EditorState, Selection } from "@tiptap/pm/state";
import { moveColumn } from "./move-column";
import { convertTableNodeToArrayOfRows } from "./convert-table-node-to-array-of-rows";
import { findTable } from "./query";

/**
 * moveColumn reorders whole columns of a real ProseMirror table by mutating a
 * Transaction (transpose -> move row -> transpose back -> replace). The invariant
 * is that after the call each column appears at its new position with every
 * cell's content preserved and nothing dropped or duplicated.
 */

const tNodes = tableNodes({
  tableGroup: "block",
  cellContent: "inline*",
  cellAttributes: {},
});
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    ...tNodes,
  },
  marks: {},
});
const cell = (txt: string): PMNode =>
  schema.nodes.table_cell.createChecked(null, schema.text(txt));
const row = (...cells: PMNode[]): PMNode =>
  schema.nodes.table_row.createChecked(null, cells);
const table = (...rows: PMNode[]): PMNode =>
  schema.nodes.table.createChecked(null, rows);
const doc = (...content: PMNode[]): PMNode =>
  schema.nodes.doc.createChecked(null, content);

const grid = (tr: any): string[][] => {
  const t = findTable(tr.doc.resolve(tr.selection.from))!;
  return convertTableNodeToArrayOfRows(t.node).map((r) =>
    r.map((c) => (c ? c.textContent : "")),
  );
};

// 2-row x 3-col table; column k is (rowX-col-k). Columns: 0=(a,d) 1=(b,e) 2=(c,f).
const grid3x2 = () =>
  doc(
    table(
      row(cell("a"), cell("b"), cell("c")),
      row(cell("d"), cell("e"), cell("f")),
    ),
  );

const stateFor = (d: PMNode) =>
  EditorState.create({ doc: d, selection: Selection.atStart(d) });

describe("moveColumn", () => {
  it("moves the first column to the last index, preserving column content", () => {
    // origin 0 -> target 2 sends column (a,d) to the right: cols become 1,2,0.
    const state = stateFor(grid3x2());
    const tr = state.tr;
    const ok = moveColumn({
      tr,
      originIndex: 0,
      targetIndex: 2,
      select: false,
      pos: state.selection.from,
    });
    expect(ok).toBe(true);
    expect(grid(tr)).toEqual([
      ["b", "c", "a"],
      ["e", "f", "d"],
    ]);
  });

  it("moves a later column to the first index", () => {
    // origin 2 -> target 0 pulls column (c,f) to the front: cols become 2,0,1.
    const state = stateFor(grid3x2());
    const tr = state.tr;
    const ok = moveColumn({
      tr,
      originIndex: 2,
      targetIndex: 0,
      select: false,
      pos: state.selection.from,
    });
    expect(ok).toBe(true);
    expect(grid(tr)).toEqual([
      ["c", "a", "b"],
      ["f", "d", "e"],
    ]);
  });

  it("never drops or duplicates cells when reordering columns", () => {
    const state = stateFor(grid3x2());
    const tr = state.tr;
    moveColumn({
      tr,
      originIndex: 1,
      targetIndex: 2,
      select: false,
      pos: state.selection.from,
    });
    expect(grid(tr).flat().sort()).toEqual(
      ["a", "b", "c", "d", "e", "f"].sort(),
    );
    expect(grid(tr)[0].length).toBe(3);
  });

  it("returns false (no-op) when target equals origin", () => {
    const state = stateFor(grid3x2());
    const tr = state.tr;
    const before = grid(tr);
    const ok = moveColumn({
      tr,
      originIndex: 1,
      targetIndex: 1,
      select: false,
      pos: state.selection.from,
    });
    expect(ok).toBe(false);
    expect(grid(tr)).toEqual(before);
  });

  it("returns false when pos is not inside a table", () => {
    const d = doc(
      schema.nodes.paragraph.createChecked(null, schema.text("plain")),
    );
    const state = stateFor(d);
    const tr = state.tr;
    const ok = moveColumn({
      tr,
      originIndex: 0,
      targetIndex: 1,
      select: false,
      pos: state.selection.from,
    });
    expect(ok).toBe(false);
  });

  it("installs a CellSelection on the moved column when select is true", () => {
    const state = stateFor(grid3x2());
    const tr = state.tr;
    const ok = moveColumn({
      tr,
      originIndex: 0,
      targetIndex: 2,
      select: true,
      pos: state.selection.from,
    });
    expect(ok).toBe(true);
    expect(tr.selection instanceof CellSelection).toBe(true);
  });
});
