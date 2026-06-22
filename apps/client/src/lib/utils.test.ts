import { describe, it, expect } from "vitest";
import { computeSpaceSlug } from "@/lib/utils.tsx";

// `computeSpaceSlug` derives a space slug that must satisfy the server-side
// @IsAlphanumeric / ^[a-zA-Z0-9]+$ constraint: lowercase the name and strip
// every non-[a-z0-9] character (spaces, punctuation, and non-ascii letters).
// No hyphens, no uppercase, no separators survive.
describe("computeSpaceSlug", () => {
  it("strips the space between two words", () => {
    expect(computeSpaceSlug("Product Team")).toBe("productteam");
  });

  it("lowercases and joins a two-word name", () => {
    expect(computeSpaceSlug("Hello World")).toBe("helloworld");
  });

  it("lowercases a single word with no separators", () => {
    expect(computeSpaceSlug("SingleWord")).toBe("singleword");
  });

  it("lowercases an all-caps word and removes the inner space", () => {
    expect(computeSpaceSlug("UPPER case")).toBe("uppercase");
  });

  it("drops non-ascii characters, keeping ascii letters and digits", () => {
    // "Привет" (Cyrillic) is stripped entirely; only "a", "b" and "1" remain.
    expect(computeSpaceSlug("a b Привет 1")).toBe("ab1");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(computeSpaceSlug("  ")).toBe("");
  });

  it("always produces output matching /^[a-z0-9]*$/", () => {
    const samples = [
      "Product Team",
      "Hello World",
      "SingleWord",
      "UPPER case",
      "a b Привет 1",
      "  ",
      "Mixed-123 !@#",
      "Café Münster",
    ];
    for (const sample of samples) {
      expect(computeSpaceSlug(sample)).toMatch(/^[a-z0-9]*$/);
    }
  });
});
