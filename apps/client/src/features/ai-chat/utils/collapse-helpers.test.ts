import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  shouldCollapseOnOutsidePointer,
  isHeaderClick,
} from "./collapse-helpers";

describe("shouldCollapseOnOutsidePointer", () => {
  let windowEl: HTMLDivElement;
  let inside: HTMLSpanElement;
  let portal: HTMLDivElement;
  let portalChild: HTMLButtonElement;
  let page: HTMLDivElement;

  beforeEach(() => {
    // The floating window with a child node.
    windowEl = document.createElement("div");
    inside = document.createElement("span");
    windowEl.appendChild(inside);

    // A Mantine-style portal (data-portal="true") with a child (e.g. a menu item).
    portal = document.createElement("div");
    portal.setAttribute("data-portal", "true");
    portalChild = document.createElement("button");
    portal.appendChild(portalChild);

    // An unrelated page element.
    page = document.createElement("div");

    document.body.append(windowEl, portal, page);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns false for a target inside the window", () => {
    expect(shouldCollapseOnOutsidePointer(inside, windowEl)).toBe(false);
    expect(shouldCollapseOnOutsidePointer(windowEl, windowEl)).toBe(false);
  });

  it("returns false for a target inside a Mantine portal", () => {
    expect(shouldCollapseOnOutsidePointer(portal, windowEl)).toBe(false);
    expect(shouldCollapseOnOutsidePointer(portalChild, windowEl)).toBe(false);
  });

  it("returns true for a target on the page (outside window and portals)", () => {
    expect(shouldCollapseOnOutsidePointer(page, windowEl)).toBe(true);
  });

  it("returns false when there is no window element", () => {
    expect(shouldCollapseOnOutsidePointer(page, null)).toBe(false);
  });

  it("returns false for a non-Element target", () => {
    expect(shouldCollapseOnOutsidePointer(null, windowEl)).toBe(false);
    expect(shouldCollapseOnOutsidePointer(document, windowEl)).toBe(false);
  });
});

describe("isHeaderClick", () => {
  it("treats a zero-movement press as a click", () => {
    expect(isHeaderClick(100, 100, 100, 100)).toBe(true);
  });

  it("treats movement within the threshold as a click", () => {
    expect(isHeaderClick(100, 100, 103, 97)).toBe(true);
    expect(isHeaderClick(100, 100, 104, 104)).toBe(true);
  });

  it("treats movement beyond the threshold (either axis) as a drag", () => {
    expect(isHeaderClick(100, 100, 105, 100)).toBe(false);
    expect(isHeaderClick(100, 100, 100, 105)).toBe(false);
  });

  it("honors a custom threshold", () => {
    expect(isHeaderClick(0, 0, 8, 0, 10)).toBe(true);
    expect(isHeaderClick(0, 0, 11, 0, 10)).toBe(false);
  });
});
