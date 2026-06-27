import { describe, it, expect } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  isHeaderCell,
  sortItems,
  weaveItems,
  type SortableItem,
} from "./sort-cells";

// isHeaderCell only reads node.type.name and node.attrs?.header, so a minimal
// duck-typed node is sufficient (no real ProseMirror schema needed).
function fakeNode(typeName: string, attrs: Record<string, unknown> = {}) {
  return { type: { name: typeName }, attrs } as unknown as ProseMirrorNode;
}

function item<T>(
  payload: T,
  text: string,
  originalOrder: number,
  opts: { isHeader?: boolean; isEmpty?: boolean } = {},
): SortableItem<T> {
  return {
    payload,
    text,
    originalOrder,
    isHeader: opts.isHeader ?? false,
    isEmpty: opts.isEmpty ?? text.trim() === "",
  };
}

describe("isHeaderCell", () => {
  it("recognizes the tableHeader node type", () => {
    expect(isHeaderCell(fakeNode("tableHeader"))).toBe(true);
  });

  it("recognizes the snake_case table_header node type", () => {
    expect(isHeaderCell(fakeNode("table_header"))).toBe(true);
  });

  it("treats a plain cell with header:true attr as a header", () => {
    expect(isHeaderCell(fakeNode("tableCell", { header: true }))).toBe(true);
  });

  it("returns false for a regular body cell", () => {
    expect(isHeaderCell(fakeNode("tableCell", { header: false }))).toBe(false);
    expect(isHeaderCell(fakeNode("tableCell"))).toBe(false);
  });
});

describe("sortItems", () => {
  it("sorts non-empty rows ascending using a base/numeric collator", () => {
    const data = [
      item("c", "cherry", 0),
      item("a", "Apple", 1),
      item("b", "banana", 2),
    ];
    expect(sortItems(data, "asc").map((i) => i.payload)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("sorts descending when direction is desc", () => {
    const data = [
      item("a", "apple", 0),
      item("b", "banana", 1),
      item("c", "cherry", 2),
    ];
    expect(sortItems(data, "desc").map((i) => i.payload)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("orders numerically, not lexically (numeric collator)", () => {
    const data = [
      item("ten", "10", 0),
      item("two", "2", 1),
      item("one", "1", 2),
    ];
    expect(sortItems(data, "asc").map((i) => i.payload)).toEqual([
      "one",
      "two",
      "ten",
    ]);
  });

  it("always pushes empty cells to the bottom regardless of direction", () => {
    const data = [
      item("empty", "", 0, { isEmpty: true }),
      item("b", "banana", 1),
      item("a", "apple", 2),
    ];
    const asc = sortItems(data, "asc");
    expect(asc.map((i) => i.payload)).toEqual(["a", "b", "empty"]);
    const desc = sortItems(data, "desc");
    // Empty stays last even when the rest is reversed.
    expect(desc[desc.length - 1].payload).toBe("empty");
  });

  it("keeps empty cells in their original relative order (stable)", () => {
    const data = [
      item("e1", "", 5, { isEmpty: true }),
      item("e2", "", 2, { isEmpty: true }),
      item("a", "apple", 9),
    ];
    const sorted = sortItems(data, "asc");
    // e2 (originalOrder 2) before e1 (originalOrder 5).
    expect(sorted.map((i) => i.payload)).toEqual(["a", "e2", "e1"]);
  });

  it("does not mutate the input array", () => {
    const data = [item("b", "banana", 0), item("a", "apple", 1)];
    const snapshot = data.map((i) => i.payload);
    sortItems(data, "asc");
    expect(data.map((i) => i.payload)).toEqual(snapshot);
  });
});

describe("weaveItems", () => {
  it("keeps header rows pinned in place and fills body slots from sorted data", () => {
    const header = item("H", "Name", 0, { isHeader: true });
    const all = [
      header,
      item("orig-b", "b", 1),
      item("orig-a", "a", 2),
    ];
    const sortedBody = [item("orig-a", "a", 2), item("orig-b", "b", 1)];

    const woven = weaveItems(all, sortedBody);
    // Header never moves out of row 0...
    expect(woven[0]).toBe(header);
    // ...and the body positions are filled in sorted order.
    expect(woven.slice(1).map((i) => i.payload)).toEqual(["orig-a", "orig-b"]);
  });

  it("does not consume body data for header positions (header stays at top)", () => {
    const header = item("H", "head", 0, { isHeader: true });
    const all = [header, item("x", "x", 1), item("y", "y", 2)];
    const sortedBody = [item("y", "y", 2), item("x", "x", 1)];
    const woven = weaveItems(all, sortedBody);
    expect(woven[0].isHeader).toBe(true);
    expect(woven.filter((i) => !i.isHeader).map((i) => i.payload)).toEqual([
      "y",
      "x",
    ]);
  });

  it("interleaves correctly when a header sits between body rows", () => {
    const header = item("H", "head", 1, { isHeader: true });
    const all = [
      item("b1", "b1", 0),
      header,
      item("b2", "b2", 2),
    ];
    const sortedBody = [item("b2", "b2", 2), item("b1", "b1", 0)];
    const woven = weaveItems(all, sortedBody);
    expect(woven.map((i) => i.payload)).toEqual(["b2", "H", "b1"]);
    expect(woven[1]).toBe(header);
  });
});
