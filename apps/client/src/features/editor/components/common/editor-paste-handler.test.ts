import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  collectScrollAncestors,
  reflowAfterPaste,
} from "./editor-paste-handler";

/**
 * Unit tests for the #146 post-paste reflow helpers. jsdom does not compute
 * styles or layout, so we stub getComputedStyle (per element via a Map) and the
 * scroll/overflow geometry properties (per element via Object.defineProperty).
 * Element trees are built DETACHED from `document`, so the ancestor walk only
 * traverses the elements we create. collectScrollAncestors always appends
 * document.scrollingElement, so we assert on specific ancestors with
 * toContain/not.toContain rather than exact-array equality.
 */

type Overflow = { overflowX: string; overflowY: string };
const styleMap = new Map<Element, Overflow>();

function makeScrollable(
  overflowY: string,
  {
    sh = 0,
    ch = 0,
    sw = 0,
    cw = 0,
    left = 0,
    top = 0,
    overflowX = "visible",
  }: {
    sh?: number;
    ch?: number;
    sw?: number;
    cw?: number;
    left?: number;
    top?: number;
    overflowX?: string;
  } = {},
) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: sh });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: ch });
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: sw });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: cw });
  Object.defineProperty(el, "scrollLeft", { configurable: true, value: left });
  Object.defineProperty(el, "scrollTop", { configurable: true, value: top });
  styleMap.set(el, { overflowX, overflowY });
  return el;
}

// A leaf node whose parentElement is `parent`. The walk starts from
// node.parentElement, so the parent is the first candidate ancestor.
function makeNodeUnder(parent: HTMLElement) {
  const node = document.createElement("div");
  parent.appendChild(node);
  return node;
}

// Override `document.scrollingElement` as an instance own-property (the native
// implementation is a getter on Document.prototype, which we never touch).
function setScrollingElement(value: Element | null) {
  Object.defineProperty(document, "scrollingElement", {
    configurable: true,
    get: () => value,
  });
}

beforeEach(() => {
  styleMap.clear();
  vi.stubGlobal("getComputedStyle", (el: Element) => {
    return styleMap.get(el) ?? { overflowX: "visible", overflowY: "visible" };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Drop the per-test instance override so the native prototype getter shows
  // through again (it was never modified, so no further restore is needed).
  delete (document as any).scrollingElement;
});

describe("collectScrollAncestors", () => {
  it("includes an overflow:overlay ancestor that overflows (macOS case)", () => {
    setScrollingElement(null);
    const a = makeScrollable("overlay", { sh: 200, ch: 100 });
    const node = makeNodeUnder(a);
    expect(collectScrollAncestors(node)).toContain(a);
  });

  it("excludes an overflow:auto ancestor that does NOT overflow (gate fails)", () => {
    setScrollingElement(null);
    const a = makeScrollable("auto", { sh: 100, ch: 100 });
    const node = makeNodeUnder(a);
    expect(collectScrollAncestors(node)).not.toContain(a);
  });

  it("includes an overflow:auto ancestor that overflows", () => {
    setScrollingElement(null);
    const a = makeScrollable("auto", { sh: 200, ch: 100 });
    const node = makeNodeUnder(a);
    expect(collectScrollAncestors(node)).toContain(a);
  });

  it("excludes a non-scrollable overflow even when it overflows", () => {
    setScrollingElement(null);
    const a = makeScrollable("hidden", { sh: 200, ch: 100 });
    const node = makeNodeUnder(a);
    expect(collectScrollAncestors(node)).not.toContain(a);
  });

  it("includes an X-axis overflow:scroll ancestor that overflows horizontally", () => {
    setScrollingElement(null);
    const a = makeScrollable("visible", {
      overflowX: "scroll",
      sw: 200,
      cw: 100,
    });
    const node = makeNodeUnder(a);
    expect(collectScrollAncestors(node)).toContain(a);
  });

  it("dedups: scrollingElement already in the walk is added exactly once", () => {
    const a = makeScrollable("auto", { sh: 200, ch: 100 });
    setScrollingElement(a);
    const node = makeNodeUnder(a);
    const result = collectScrollAncestors(node);
    expect(result.filter((x) => x === a).length).toBe(1);
  });

  it("does not throw and appends nothing when scrollingElement is null", () => {
    setScrollingElement(null);
    const a = makeScrollable("auto", { sh: 200, ch: 100 });
    const node = makeNodeUnder(a);
    const result = collectScrollAncestors(node);
    // Only the qualifying ancestor we built — no trailing scrollingElement.
    expect(result).toEqual([a]);
  });
});

describe("reflowAfterPaste", () => {
  it("runs the double rAF and nudges each ancestor with scrollTo(scrollLeft, scrollTop)", () => {
    // Run the double-nested requestAnimationFrame synchronously.
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      },
    );
    setScrollingElement(null);

    const a = makeScrollable("auto", { sh: 200, ch: 100, left: 5, top: 10 });
    const node = makeNodeUnder(a);
    (a as any).scrollTo = vi.fn();

    reflowAfterPaste({ view: { dom: node } } as any);

    expect((a as any).scrollTo).toHaveBeenCalledWith(5, 10);
  });
});
