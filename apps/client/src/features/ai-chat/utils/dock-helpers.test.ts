import { describe, it, expect } from "vitest";
import {
  isPointWithinRect,
  isNavbarRectVisible,
  type NavbarRect,
} from "./dock-helpers.ts";

const NAVBAR: NavbarRect = { left: 0, top: 45, width: 300, height: 800 };

describe("isPointWithinRect", () => {
  it("returns true for a point inside the navbar", () => {
    expect(isPointWithinRect(150, 400, NAVBAR)).toBe(true);
  });

  it("treats the boundary edges as inside (drop exactly on the edge docks)", () => {
    // Top-left corner and bottom-right corner are both inclusive.
    expect(isPointWithinRect(0, 45, NAVBAR)).toBe(true);
    expect(isPointWithinRect(300, 845, NAVBAR)).toBe(true);
  });

  it("returns false for a point in the content area (to the right)", () => {
    expect(isPointWithinRect(500, 400, NAVBAR)).toBe(false);
  });

  it("returns false above the navbar (in the header band)", () => {
    expect(isPointWithinRect(150, 10, NAVBAR)).toBe(false);
  });

  it("returns false when the navbar rect is null (absent/collapsed)", () => {
    expect(isPointWithinRect(150, 400, null)).toBe(false);
  });
});

describe("isNavbarRectVisible", () => {
  it("returns true for a normal on-screen navbar rect", () => {
    expect(isNavbarRectVisible({ width: 300, height: 800, right: 300 })).toBe(
      true,
    );
  });

  it("returns false for a zero-size rect (width or height 0)", () => {
    expect(isNavbarRectVisible({ width: 0, height: 800, right: 300 })).toBe(
      false,
    );
    expect(isNavbarRectVisible({ width: 300, height: 0, right: 300 })).toBe(
      false,
    );
  });

  it("returns false when the navbar is translated off-screen (right <= 0)", () => {
    expect(isNavbarRectVisible({ width: 300, height: 800, right: 0 })).toBe(
      false,
    );
    expect(isNavbarRectVisible({ width: 300, height: 800, right: -50 })).toBe(
      false,
    );
  });
});
