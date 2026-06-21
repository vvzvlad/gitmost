import { describe, it, expect } from "vitest";
import { resolveAssistantName } from "./assistant-name";

describe("resolveAssistantName", () => {
  it("returns a real name unchanged", () => {
    expect(resolveAssistantName("Ada")).toBe("Ada");
  });

  it("trims surrounding whitespace from a real name", () => {
    expect(resolveAssistantName("  Ada  ")).toBe("Ada");
  });

  it("returns null for a whitespace-only name (the reason for .trim())", () => {
    expect(resolveAssistantName("   ")).toBeNull();
  });

  it("returns null when the name is undefined", () => {
    expect(resolveAssistantName(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(resolveAssistantName("")).toBeNull();
  });
});
