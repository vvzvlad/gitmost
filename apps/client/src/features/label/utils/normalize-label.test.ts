import { describe, it, expect } from "vitest";
import { normalizeLabelName } from "@/features/label/utils/normalize-label.ts";

/**
 * `normalizeLabelName` = trim + collapse ALL whitespace runs to a single hyphen
 * + lowercase. Used to canonicalize label names so "Bug Fix" and " bug  fix "
 * map to the same key.
 */
describe("normalizeLabelName", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeLabelName("  bug  ")).toBe("bug");
  });

  it("lowercases", () => {
    expect(normalizeLabelName("BUG")).toBe("bug");
    expect(normalizeLabelName("MixedCase")).toBe("mixedcase");
  });

  it("collapses internal whitespace runs to a single hyphen", () => {
    expect(normalizeLabelName("bug   fix")).toBe("bug-fix");
    expect(normalizeLabelName("a b c")).toBe("a-b-c");
  });

  it("combines trim + collapse + lowercase", () => {
    expect(normalizeLabelName("  Bug   Fix  ")).toBe("bug-fix");
  });

  it("treats tab and newline as whitespace", () => {
    expect(normalizeLabelName("bug\tfix")).toBe("bug-fix");
    expect(normalizeLabelName("bug\nfix")).toBe("bug-fix");
    expect(normalizeLabelName("bug\r\nfix")).toBe("bug-fix");
  });

  it("treats unicode whitespace (no-break space) as a separator", () => {
    // U+00A0 NO-BREAK SPACE is matched by the \s class.
    expect(normalizeLabelName("bug fix")).toBe("bug-fix");
  });

  it("leaves an already-normalized name unchanged", () => {
    expect(normalizeLabelName("bug-fix")).toBe("bug-fix");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeLabelName("   ")).toBe("");
    expect(normalizeLabelName("")).toBe("");
  });
});
