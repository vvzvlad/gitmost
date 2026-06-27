import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { tableNodes, TableMap } from "@tiptap/pm/tables";
import { transpose } from "./transpose";
import { moveRowInArrayOfRows } from "./move-row-in-array-of-rows";
import { convertTableNodeToArrayOfRows } from "./convert-table-node-to-array-of-rows";
import { convertArrayOfRowsToTableNode } from "./convert-array-of-rows-to-table-node";

/**
 * Unit tests for the pure table data-transformation utilities. These functions
 * drive every drag-to-reorder row/column operation, so a regression here
 * silently corrupts table content. We test them in isolation against a real
 * ProseMirror table schema (the same primitives the editor uses).
 */

// Minimal schema containing real ProseMirror table nodes so TableMap behaves
// exactly as it does in the editor (merged cells, colspan, etc.).
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

const cell = (txt: string, attrs?: Record<string, unknown>): PMNode =>
  schema.nodes.table_cell.createChecked(attrs ?? null, schema.text(txt));
const row = (...cells: PMNode[]): PMNode =>
  schema.nodes.table_row.createChecked(null, cells);
const table = (...rows: PMNode[]): PMNode =>
  schema.nodes.table.createChecked(null, rows);

// Read the text content of each (non-null) cell so we can compare structure
// without depending on ProseMirror node identity.
const textGrid = (rows: (PMNode | null)[][]): (string | null)[][] =>
  rows.map((r) => r.map((c) => (c ? c.textContent : null)));

const tableTextGrid = (t: PMNode): (string | null)[][] =>
  textGrid(convertTableNodeToArrayOfRows(t));

describe("transpose", () => {
  it("is its own inverse on a non-square (2x3) matrix", () => {
    const arr = [
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ];
    const once = transpose(arr);
    // 2x3 -> 3x2
    expect(once.length).toBe(3);
    expect(once[0].length).toBe(2);
    const twice = transpose(once);
    expect(twice).toEqual(arr);
  });

  it("inverts indices: transpose(arr)[j][i] === arr[i][j]", () => {
    const arr = [
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ];
    const t = transpose(arr);
    for (let i = 0; i < arr.length; i++) {
      for (let j = 0; j < arr[0].length; j++) {
        expect(t[j][i]).toBe(arr[i][j]);
      }
    }
  });
});

describe("moveRowInArrayOfRows", () => {
  // Helper: the function mutates `rows` in place (it uses splice), so always
  // pass a fresh copy and read the returned array.
  const move = (
    rows: string[],
    origin: number[],
    target: number[],
    dir: -1 | 0 | 1,
  ): string[] => moveRowInArrayOfRows([...rows], origin, target, dir);

  it("moves a single row downward to a later index", () => {
    const result = move(["A", "B", "C", "D"], [0], [2], 0);
    // A starts at 0, target index 2 -> A lands after C.
    expect(result).toEqual(["B", "C", "A", "D"]);
  });

  it("moves a single row upward to an earlier index", () => {
    const result = move(["A", "B", "C", "D"], [3], [1], 0);
    expect(result).toEqual(["A", "D", "B", "C"]);
  });

  it("never drops or duplicates rows (set is preserved) for any pair", () => {
    const base = ["A", "B", "C", "D", "E"];
    for (let from = 0; from < base.length; from++) {
      for (let to = 0; to < base.length; to++) {
        if (from === to) continue;
        const result = move(base, [from], [to], 0);
        expect(result.length).toBe(base.length);
        expect([...result].sort()).toEqual([...base].sort());
      }
    }
  });

  it("moves an even-sized block (2 rows) preserving block order and full set", () => {
    // Move the [B,C] block (origin indexes 1,2) toward target index 3 (D,E region).
    const result = move(["A", "B", "C", "D", "E"], [1, 2], [3], 0);
    expect(result.length).toBe(5);
    expect([...result].sort()).toEqual(["A", "B", "C", "D", "E"]);
    // Block stays contiguous and in original internal order.
    const bi = result.indexOf("B");
    expect(result[bi + 1]).toBe("C");
  });

  it("moves an odd-sized block (3 rows) without dropping rows", () => {
    const result = move(["A", "B", "C", "D", "E"], [0, 1, 2], [4], 0);
    expect(result.length).toBe(5);
    expect([...result].sort()).toEqual(["A", "B", "C", "D", "E"]);
    // The 3-row block keeps its internal A,B,C order.
    const ai = result.indexOf("A");
    expect(result.slice(ai, ai + 3)).toEqual(["A", "B", "C"]);
  });
});

describe("convert round-trip: TableNode <-> arrayOfRows", () => {
  it("preserves a simple 2x3 grid's text content and dimensions", () => {
    const t = table(
      row(cell("a1"), cell("b1"), cell("c1")),
      row(cell("a2"), cell("b2"), cell("c2")),
    );
    const before = tableTextGrid(t);
    expect(before).toEqual([
      ["a1", "b1", "c1"],
      ["a2", "b2", "c2"],
    ]);

    const arr = convertTableNodeToArrayOfRows(t);
    const rebuilt = convertArrayOfRowsToTableNode(t, arr);

    // Structure (text content + shape) survives the round-trip.
    expect(tableTextGrid(rebuilt)).toEqual(before);
    expect(rebuilt.childCount).toBe(t.childCount);
    const mapA = TableMap.get(t);
    const mapB = TableMap.get(rebuilt);
    expect([mapB.width, mapB.height]).toEqual([mapA.width, mapA.height]);
  });

  it("represents a horizontally merged cell as a null placeholder, and round-trips it", () => {
    // First cell of row 1 spans 2 columns -> the array form has a null where
    // the covered column would be.
    const t = table(
      row(cell("merged", { colspan: 2 }), cell("c1")),
      row(cell("a2"), cell("b2"), cell("c2")),
    );

    const arr = convertTableNodeToArrayOfRows(t);
    // Row 0: [merged, null, c1] — the null marks the colspan-covered slot.
    expect(arr[0][0]?.textContent).toBe("merged");
    expect(arr[0][1]).toBeNull();
    expect(arr[0][2]?.textContent).toBe("c1");

    const rebuilt = convertArrayOfRowsToTableNode(t, arr);
    // The merged cell (and its null placeholder) is reconstructed identically.
    expect(tableTextGrid(rebuilt)).toEqual(tableTextGrid(t));
    const map = TableMap.get(rebuilt);
    expect([map.width, map.height]).toEqual([3, 2]);
  });
});
