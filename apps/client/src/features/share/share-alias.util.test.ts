import { describe, it, expect } from "vitest";
import {
  isValidShareAlias,
  normalizeShareAlias,
} from "@/features/share/share-alias.util.ts";

// Mirrors the server-side util so the modal's live feedback matches what the
// server will accept/store.
describe("normalizeShareAlias", () => {
  it("lowercases, trims and maps separators to single hyphens", () => {
    expect(normalizeShareAlias("  My  Cool_Page ")).toBe("my-cool-page");
  });

  it("collapses repeated hyphens and trims edges", () => {
    expect(normalizeShareAlias("--a---b--")).toBe("a-b");
  });
});

describe("isValidShareAlias", () => {
  it("accepts ascii hyphen-separated slugs of length 2..60", () => {
    expect(isValidShareAlias("hello-world")).toBe(true);
    expect(isValidShareAlias("a".repeat(60))).toBe(true);
  });

  it("rejects too short, edge/double hyphens, uppercase and non-ascii", () => {
    expect(isValidShareAlias("a")).toBe(false);
    expect(isValidShareAlias("-a")).toBe(false);
    expect(isValidShareAlias("a--b")).toBe(false);
    expect(isValidShareAlias("Hello")).toBe(false);
    expect(isValidShareAlias("привет")).toBe(false);
  });
});
