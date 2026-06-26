import { describe, it, expect } from "vitest";
import { getLabelColor } from "@/features/label/utils/label-colors.ts";

/**
 * Tests for the deterministic label-color hashing. `hashName` is not exported,
 * so we exercise it through `getLabelColor`. We assert determinism, that light
 * and dark schemes resolve to the SAME palette key (so a label's "blue" stays
 * "blue" across themes), that the returned color is always a real palette
 * entry, and that a realistic sample of names does not all collapse into one
 * bucket (guards the murmur fmix finalizer that de-clusters the % bucket).
 */

// The 8 distinct light-scheme bg colors, used to recover a name's bucket index.
const LIGHT_BGS = [
  "#eef1f5", // slate
  "#e6f0ff", // blue
  "#e3f5ea", // green
  "#fbf0d9", // amber
  "#fde6e6", // red
  "#efe9fb", // purple
  "#fce6ee", // pink
  "#daf1ee", // teal
];

const DARK_BGS = [
  "#2a3140",
  "#152a52",
  "#143b27",
  "#3d2c0e",
  "#401a1a",
  "#2a1f4d",
  "#3c1a2a",
  "#103633",
];

describe("getLabelColor — determinism", () => {
  it("returns the same color object shape for the same name", () => {
    const a = getLabelColor("bug");
    const b = getLabelColor("bug");
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      bg: expect.any(String),
      fg: expect.any(String),
      dot: expect.any(String),
    });
  });

  it("is stable across many repeated calls", () => {
    const first = getLabelColor("enhancement");
    for (let i = 0; i < 50; i++) {
      expect(getLabelColor("enhancement")).toEqual(first);
    }
  });
});

describe("getLabelColor — scheme parity", () => {
  it("light and dark resolve to the SAME palette key for a given name", () => {
    const names = ["bug", "enhancement", "wontfix", "duplicate", "p1", "docs"];
    for (const name of names) {
      const lightIdx = LIGHT_BGS.indexOf(getLabelColor(name, "light").bg);
      const darkIdx = DARK_BGS.indexOf(getLabelColor(name, "dark").bg);
      expect(lightIdx).toBeGreaterThanOrEqual(0); // it is a real palette entry
      expect(darkIdx).toBeGreaterThanOrEqual(0);
      expect(darkIdx).toBe(lightIdx); // same bucket across themes
    }
  });

  it("defaults to the light scheme", () => {
    expect(getLabelColor("bug")).toEqual(getLabelColor("bug", "light"));
  });
});

describe("getLabelColor — index bounds & distribution", () => {
  it("always returns a color whose bg is one of the 8 palette entries", () => {
    const names = Array.from({ length: 200 }, (_, i) => `label-${i}`);
    for (const name of names) {
      expect(LIGHT_BGS).toContain(getLabelColor(name).bg);
    }
  });

  it("handles the empty string without crashing and within bounds", () => {
    expect(LIGHT_BGS).toContain(getLabelColor("").bg);
  });

  it("a sample of distinct names does not all collide into one bucket", () => {
    const names = Array.from({ length: 64 }, (_, i) => `name-${i}-${i * 7}`);
    const buckets = new Set(names.map((n) => getLabelColor(n).bg));
    // The fmix finalizer should spread these across multiple buckets, not 1.
    expect(buckets.size).toBeGreaterThan(1);
    // Realistically a 64-name sample lands in most/all of the 8 buckets.
    expect(buckets.size).toBeGreaterThanOrEqual(4);
  });
});
