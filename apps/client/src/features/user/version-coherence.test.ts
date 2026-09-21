import { describe, it, expect } from "vitest";
import { decideVersionAction } from "./version-coherence";

describe("decideVersionAction", () => {
  it("noop when the server version is empty (fail-safe)", () => {
    expect(
      decideVersionAction({
        serverVersion: "",
        clientVersion: "v1",
        autoReloadUsed: false,
      }),
    ).toBe("noop");
  });

  it("noop when the client version is empty (fail-safe)", () => {
    expect(
      decideVersionAction({
        serverVersion: "v1",
        clientVersion: "",
        autoReloadUsed: false,
      }),
    ).toBe("noop");
  });

  it("noop when versions are equal (in sync)", () => {
    expect(
      decideVersionAction({
        serverVersion: "v1",
        clientVersion: "v1",
        autoReloadUsed: false,
      }),
    ).toBe("noop");
  });

  it("reload on a real mismatch the first time this session", () => {
    expect(
      decideVersionAction({
        serverVersion: "test-B",
        clientVersion: "test-A",
        autoReloadUsed: false,
      }),
    ).toBe("reload");
  });

  it("banner on a mismatch once the session auto-reload is spent", () => {
    expect(
      decideVersionAction({
        serverVersion: "test-B",
        clientVersion: "test-A",
        autoReloadUsed: true,
      }),
    ).toBe("banner");
  });

  it("equal versions stay noop even if auto-reload was already used", () => {
    expect(
      decideVersionAction({
        serverVersion: "v1",
        clientVersion: "v1",
        autoReloadUsed: true,
      }),
    ).toBe("noop");
  });
});
