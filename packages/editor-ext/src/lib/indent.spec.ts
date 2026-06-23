import { describe, it, expect } from "vitest";
import { clampIndent } from "./indent";

// Unit tests for `clampIndent` (indent.ts) — the pure core of the indent
// extension. The extension stores an integer `indent` level on paragraphs and
// headings (default range [0, 8]); `clampIndent` keeps every code path
// (increment via Tab, outdent via Shift-Tab, and parsing junk `data-indent`
// attributes from pasted HTML) inside the configured bounds. A regression would
// let an out-of-range / NaN level reach renderHTML and produce broken padding.
//
// NOTE: the "excluded containers stay flat" behaviour (paragraphs inside list
// items / table cells / code blocks) lives in `updateIndent` /
// `appendTransaction`, which require a real ProseMirror EditorState and document
// resolution — it cannot be isolated into a pure function, so it is intentionally
// out of scope here and is exercised at the extension/editor level.

const MIN = 0;
const MAX = 8;

describe("clampIndent", () => {
  it("leaves in-range values untouched", () => {
    expect(clampIndent(0, MIN, MAX)).toBe(0);
    expect(clampIndent(4, MIN, MAX)).toBe(4);
    expect(clampIndent(8, MIN, MAX)).toBe(8);
  });

  it("clamps increments at the max (8)", () => {
    // Tab at level 8 would compute 9 -> stays at 8.
    expect(clampIndent(8 + 1, MIN, MAX)).toBe(8);
    expect(clampIndent(100, MIN, MAX)).toBe(8);
  });

  it("clamps outdents at the min (0)", () => {
    // Shift-Tab at level 0 would compute -1 -> stays at 0.
    expect(clampIndent(0 - 1, MIN, MAX)).toBe(0);
    expect(clampIndent(-100, MIN, MAX)).toBe(0);
  });

  it("treats non-finite junk (NaN / Infinity) as the min", () => {
    // parseInt('abc', 10) === NaN, which must not propagate to the attribute.
    expect(clampIndent(NaN, MIN, MAX)).toBe(MIN);
    expect(clampIndent(Infinity, MIN, MAX)).toBe(MIN);
    expect(clampIndent(-Infinity, MIN, MAX)).toBe(MIN);
  });

  it("truncates fractional values toward zero before clamping", () => {
    expect(clampIndent(3.9, MIN, MAX)).toBe(3);
    expect(clampIndent(-0.5, MIN, MAX)).toBe(MIN);
  });

  it("clamps junk data-indent values (negative / > max) to the rails", () => {
    // Mirrors parseHTML(parseInt(data-indent, 10)) for adversarial pasted HTML.
    expect(clampIndent(-3, MIN, MAX)).toBe(MIN);
    expect(clampIndent(42, MIN, MAX)).toBe(MAX);
  });
});
