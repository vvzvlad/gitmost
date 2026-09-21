import { describe, it, expect } from "vitest";
import { computeColumnLayout } from "./compute-column-layout";

const COL_MAX = 900;
const GAP = 16;

describe("computeColumnLayout", () => {
  it("closed panel reproduces the current centered layout (full width column)", () => {
    // W = closed content width; asideOffset = 0.
    const { left, width } = computeColumnLayout(1400, 0, COL_MAX, GAP);
    // Exactly the CSS `margin: auto` centered position and full COL_MAX width.
    expect(left).toBe((1400 - COL_MAX) / 2); // 250
    expect(width).toBe(COL_MAX); // 900
  });

  it("open panel keeps the LEFT edge identical to the closed layout", () => {
    const closed = computeColumnLayout(1400, 0, COL_MAX, GAP);
    // Panel open: Main lost `asideOffset` px, so its current content width is
    // 1400 - 420 = 980 while asideOffset = 420.
    const open = computeColumnLayout(980, 420, COL_MAX, GAP);
    expect(open.left).toBe(closed.left); // 250 — left edge pinned
  });

  it("open panel narrows the column on the right (width < colMax)", () => {
    const open = computeColumnLayout(980, 420, COL_MAX, GAP);
    expect(open.width).toBeLessThan(COL_MAX);
    // width = min(900, 980 - 250 - 16) = 714
    expect(open.width).toBe(714);
  });

  it("open column's right edge stays a gap clear of the panel (<= W - GAP)", () => {
    const W = 980;
    const { left, width } = computeColumnLayout(W, 420, COL_MAX, GAP);
    expect(left + width).toBeLessThanOrEqual(W - GAP);
  });

  it("never produces negative geometry on a very narrow Main", () => {
    const { left, width } = computeColumnLayout(300, 420, COL_MAX, GAP);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(width).toBeGreaterThanOrEqual(0);
  });

  it("caps width at colMax even when Main is wider than needed", () => {
    const { width } = computeColumnLayout(3000, 0, COL_MAX, GAP);
    expect(width).toBe(COL_MAX);
  });
});
