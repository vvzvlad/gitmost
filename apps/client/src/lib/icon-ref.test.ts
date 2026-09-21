import { describe, it, expect } from "vitest";
import {
  parseIconRef,
  serializeIconRef,
  resolvePageIconColor,
  DEFAULT_PAGE_ICON_COLOR,
  PAGE_ICON_PALETTE,
  type IconRef,
} from "./icon-ref";

describe("parseIconRef / serializeIconRef", () => {
  it("round-trips a page icon ref (name + color)", () => {
    const ref: IconRef = { name: "rocket", color: "blue" };
    const json = serializeIconRef(ref);
    expect(json).toBe('{"name":"rocket","color":"blue"}');
    expect(parseIconRef(json)).toEqual(ref);
  });

  it("round-trips a role icon ref (name only, no color)", () => {
    const ref: IconRef = { name: "rocket" };
    const json = serializeIconRef(ref);
    expect(json).toBe('{"name":"rocket"}');
    const parsed = parseIconRef(json);
    expect(parsed).toEqual(ref);
    // No color key is invented for a role ref.
    expect(parsed && "color" in parsed).toBe(false);
  });

  it("rejects a native emoji character → null", () => {
    // Legacy stored value. JSON.parse throws → defensive null.
    expect(parseIconRef("🚀")).toBeNull();
    expect(parseIconRef("📁")).toBeNull();
    expect(parseIconRef("🔬 Researcher")).toBeNull();
  });

  it("rejects null / undefined / empty / whitespace → null", () => {
    expect(parseIconRef(null)).toBeNull();
    expect(parseIconRef(undefined)).toBeNull();
    expect(parseIconRef("")).toBeNull();
    expect(parseIconRef("   ")).toBeNull();
  });

  it("rejects garbage / non-object / nameless JSON → null", () => {
    expect(parseIconRef("not json")).toBeNull();
    expect(parseIconRef("{")).toBeNull();
    expect(parseIconRef("[1,2,3]")).toBeNull();
    expect(parseIconRef("123")).toBeNull();
    expect(parseIconRef('"just a string"')).toBeNull();
    expect(parseIconRef("null")).toBeNull();
    expect(parseIconRef("{}")).toBeNull();
    expect(parseIconRef('{"color":"blue"}')).toBeNull();
    expect(parseIconRef('{"name":""}')).toBeNull();
    expect(parseIconRef('{"name":"   "}')).toBeNull();
    expect(parseIconRef('{"name":123}')).toBeNull();
  });

  it("normalizes an unknown palette token to the default color", () => {
    const parsed = parseIconRef('{"name":"rocket","color":"chartreuse"}');
    expect(parsed).toEqual({ name: "rocket", color: DEFAULT_PAGE_ICON_COLOR });
  });

  it("keeps a valid non-default palette token", () => {
    expect(parseIconRef('{"name":"rocket","color":"teal"}')).toEqual({
      name: "rocket",
      color: "teal",
    });
  });
});

describe("resolvePageIconColor", () => {
  it("returns the default for unknown / missing tokens", () => {
    expect(resolvePageIconColor(undefined)).toBe(DEFAULT_PAGE_ICON_COLOR);
    expect(resolvePageIconColor(null)).toBe(DEFAULT_PAGE_ICON_COLOR);
    expect(resolvePageIconColor("")).toBe(DEFAULT_PAGE_ICON_COLOR);
    expect(resolvePageIconColor("chartreuse")).toBe(DEFAULT_PAGE_ICON_COLOR);
  });

  it("passes through every known palette token", () => {
    for (const token of PAGE_ICON_PALETTE) {
      expect(resolvePageIconColor(token)).toBe(token);
    }
  });
});
