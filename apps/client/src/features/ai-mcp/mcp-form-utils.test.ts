import { describe, it, expect } from "vitest";
import { resolveToolAllowlist } from "./mcp-form-utils.ts";

describe("resolveToolAllowlist", () => {
  it("sends the typed tools when the field is non-empty", () => {
    expect(resolveToolAllowlist(["a", "b"], { toolAllowlist: null })).toEqual([
      "a",
      "b",
    ]);
  });

  it("creates as null (unrestricted) when empty and there is no server", () => {
    expect(resolveToolAllowlist([], undefined)).toBeNull();
  });

  it("sends null for an empty field on a previously-unrestricted server", () => {
    expect(resolveToolAllowlist([], { toolAllowlist: null })).toBeNull();
  });

  it("preserves deny-all: an empty field on a `[]` server stays `[]`, not null", () => {
    // The core #476/#477 guard: editing a deny-all server (rename/toggle) with
    // an empty tag field must NOT silently widen it to allow-all.
    expect(resolveToolAllowlist([], { toolAllowlist: [] })).toEqual([]);
  });

  it("still sends explicit tools even if the server was deny-all", () => {
    expect(resolveToolAllowlist(["x"], { toolAllowlist: [] })).toEqual(["x"]);
  });
});
