import { describe, it, expect } from "vitest";
import { CellSelection } from "@tiptap/pm/tables";
import { moveRow } from "./move-row";
import {
  schema,
  cell,
  row,
  table,
  doc,
  grid,
  stateFor,
} from "./table-test-helpers";

/**
 * moveRow reorders whole rows of a real ProseMirror table by mutating a
 * Transaction: it locates the table, computes origin/target row ranges, rebuilds
 * the table with rows reordered, and replaces it in the doc. The invariant is
 * that after the call the table's rows appear in the new order with every cell's
 * content preserved, and no rows are dropped or duplicated.
 */

// 3-row x 2-col table; each row identifiable by its cells.
const grid2x3 = () =>
  doc(
    table(
      row(cell("r0a"), cell("r0b")),
      row(cell("r1a"), cell("r1b")),
      row(cell("r2a"), cell("r2b")),
    ),
  );

describe("moveRow", () => {
  it("moves the first row down to the last index, preserving content", () => {
    // origin 0 -> target 2 makes row 0 land after the other rows: [r1, r2, r0].
    const state = stateFor(grid2x3());
    const tr = state.tr;
    const ok = moveRow({
      tr,
      originIndex: 0,
      targetIndex: 2,
      select: false,
      pos: state.selection.from,
    });
    expect(ok).toBe(true);
    expect(grid(tr)).toEqual([
      ["r1a", "r1b"],
      ["r2a", "r2b"],
      ["r0a", "r0b"],
    ]);
  });

  it("moves a lower row up to an earlier index", () => {
    // origin 2 -> target 0 lifts the last row above the rest: [r2, r0, r1].
    const state = stateFor(grid2x3());
    const tr = state.tr;
    const ok = moveRow({
      tr,
      originIndex: 2,
      targetIndex: 0,
      select: false,
      pos: state.selection.from,
    });
    expect(ok).toBe(true);
    expect(grid(tr)).toEqual([
      ["r2a", "r2b"],
      ["r0a", "r0b"],
      ["r1a", "r1b"],
    ]);
  });

  it("never drops or duplicates rows when reordering", () => {
    // The full multiset of cell texts is invariant under any valid move.
    const state = stateFor(grid2x3());
    const tr = state.tr;
    moveRow({
      tr,
      originIndex: 1,
      targetIndex: 2,
      select: false,
      pos: state.selection.from,
    });
    const flat = grid(tr).flat().sort();
    expect(flat).toEqual(
      ["r0a", "r0b", "r1a", "r1b", "r2a", "r2b"].sort(),
    );
    expect(grid(tr).length).toBe(3);
  });

  it("returns false (no-op) when target equals origin", () => {
    // Moving a row onto itself is rejected and leaves the table unchanged.
    const state = stateFor(grid2x3());
    const tr = state.tr;
    const before = grid(tr);
    const ok = moveRow({
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
    // Without a table at `pos`, the function bails out instead of throwing.
    const d = doc(
      schema.nodes.paragraph.createChecked(null, schema.text("plain")),
    );
    const state = stateFor(d);
    const tr = state.tr;
    const ok = moveRow({
      tr,
      originIndex: 0,
      targetIndex: 1,
      select: false,
      pos: state.selection.from,
    });
    expect(ok).toBe(false);
  });

  it("installs a CellSelection on the moved row when select is true", () => {
    // With select:true the moved row at the target index is selected.
    const state = stateFor(grid2x3());
    const tr = state.tr;
    const ok = moveRow({
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
