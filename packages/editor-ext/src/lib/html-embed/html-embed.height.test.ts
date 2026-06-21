import { describe, it, expect } from "vitest";
import {
  parseHtmlEmbedHeight,
  renderHtmlEmbedHeight,
} from "./html-embed";

/**
 * PIN the CURRENT behavior of `parseHtmlEmbedHeight` for crafted/corrupt
 * `data-height` attribute values. The function is a thin parseInt + Number.isFinite
 * guard; these tests document EXACTLY what it does today (including the cases
 * where today's behavior is arguably wrong) so any future change is a conscious
 * one and shows up as a failing test rather than a silent regression.
 */
describe("parseHtmlEmbedHeight: crafted / corrupt data-height", () => {
  it('"-5" passes through as -5 (DOCUMENTED QUIRK: negative height is not rejected)', () => {
    // Number.isFinite(-5) is true, so the guard does NOT catch it. A negative
    // fixed height is almost certainly wrong downstream (it disables auto-resize
    // and yields a negative/clamped iframe height), but the function as written
    // returns it verbatim. This asserts the REAL behavior, not the ideal one.
    expect(parseHtmlEmbedHeight("-5")).toBe(-5);
  });

  it('"0" returns 0 (NOT null) — note: renderHtmlEmbedHeight treats 0 as auto-resize, so parse/render are asymmetric at 0', () => {
    // parseInt("0") === 0 and Number.isFinite(0) is true, so parse keeps 0.
    expect(parseHtmlEmbedHeight("0")).toBe(0);
    // But the render side treats a falsy 0 as "auto-resize" => emits NO attribute.
    // So a stored height of 0 does not round-trip back to data-height="0".
    expect(renderHtmlEmbedHeight(0)).toEqual({});
  });

  it('" 300 " (surrounding whitespace) parses to 300 — parseInt trims leading space', () => {
    expect(parseHtmlEmbedHeight(" 300 ")).toBe(300);
  });

  it('"3.9" truncates to 3 — parseInt drops the fractional part', () => {
    expect(parseHtmlEmbedHeight("3.9")).toBe(3);
  });

  it('a huge "99999999999" passes through unclamped (finite => no upper bound here)', () => {
    // The guard only rejects NaN/Infinity; it does not clamp magnitude. Any
    // clamping is a downstream concern, NOT this function's job.
    expect(parseHtmlEmbedHeight("99999999999")).toBe(99999999999);
  });

  it('"12px" parses the leading integer (12) — parseInt stops at the first non-digit', () => {
    expect(parseHtmlEmbedHeight("12px")).toBe(12);
  });

  it("null / empty / whitespace-only / non-numeric => null (the auto-resize sentinel)", () => {
    expect(parseHtmlEmbedHeight(null)).toBeNull();
    expect(parseHtmlEmbedHeight("")).toBeNull();
    expect(parseHtmlEmbedHeight("   ")).toBeNull();
    expect(parseHtmlEmbedHeight("abc")).toBeNull();
  });

  it("never returns NaN for a non-numeric value (the Number.isFinite guard's point)", () => {
    // NaN is typeof "number" and would slip past a naive `typeof n === number`
    // check; the guard must map it to null. This is the core invariant.
    const out = parseHtmlEmbedHeight("not-a-number");
    expect(out).toBeNull();
    expect(Number.isNaN(out as unknown as number)).toBe(false);
  });
});
