import { describe, it, expect } from "vitest";
import { getSelectionRangeInColumn } from "./get-selection-range-in-column";
import { cell, row, table, doc, trFor } from "./table-test-helpers";

/**
 * getSelectionRangeInColumn computes the rectangular column range (the set of
 * column indexes, plus anchor/head cell positions) that a drag-reorder or
 * column-select operation should act on, accounting for merged (colspan) cells.
 * It keys off the table found from the current selection, so we drive it with a
 * real EditorState whose selection sits inside the table.
 */

// A 2-row x 3-col grid; each column is identifiable by its top-row letter.
const grid3x2 = () =>
  doc(
    table(
      row(cell("a"), cell("b"), cell("c")),
      row(cell("d"), cell("e"), cell("f")),
    ),
  );

describe("getSelectionRangeInColumn", () => {
  it("returns a single-column range for a single index", () => {
    // Asking for column 1 yields exactly indexes [1].
    const tr = trFor(grid3x2());
    const range = getSelectionRangeInColumn(tr, 1);
    expect(range).toBeTruthy();
    expect(range!.indexes).toEqual([1]);
  });

  it("anchor/head resolve to the top and bottom cells OF the requested column", () => {
    // $head must point at the column's first (top) cell and $anchor at its last
    // (bottom) cell — pinning that the returned positions belong to column 1,
    // not some other column.
    const tr = trFor(grid3x2());
    const range = getSelectionRangeInColumn(tr, 1)!;
    expect(tr.doc.nodeAt(range.$head.pos)?.textContent).toBe("b"); // top of col 1
    expect(tr.doc.nodeAt(range.$anchor.pos)?.textContent).toBe("e"); // bottom of col 1
  });

  it("returns the inclusive span of columns for a multi-column request", () => {
    // A 0..2 request must enumerate every covered column, in order.
    const tr = trFor(grid3x2());
    const range = getSelectionRangeInColumn(tr, 0, 2);
    expect(range!.indexes).toEqual([0, 1, 2]);
  });

  it("returns a two-column span for an adjacent pair", () => {
    const tr = trFor(grid3x2());
    const range = getSelectionRangeInColumn(tr, 1, 2);
    expect(range!.indexes).toEqual([1, 2]);
  });

  it("expands the range to cover a horizontally merged (colspan) cell", () => {
    // Row 0 col 0 spans 2 columns. Requesting just column 0 must pull column 1
    // into the range because they are merged together in the top row.
    const d = doc(
      table(
        row(cell("ab", { colspan: 2 }), cell("c")),
        row(cell("d"), cell("e"), cell("f")),
      ),
    );
    const tr = trFor(d);
    const range = getSelectionRangeInColumn(tr, 0);
    expect(range!.indexes).toEqual([0, 1]);
  });

  it("throws when the requested column is entirely out of range", () => {
    // No cells exist at column 5 of a 3-wide table, so the function cannot pick
    // an anchor cell and dereferences undefined — pin this as the current
    // (caller-guarded) contract so a silent behavior change is caught.
    const tr = trFor(grid3x2());
    expect(() => getSelectionRangeInColumn(tr, 5)).toThrow();
  });
});
