import { describe, expect, it } from "vitest";
import { mcpTestButtonView } from "./ai-mcp-server-test-view";

/**
 * Pure-helper tests for the inline "Test" button presentation. Covers the four
 * states (idle / loading is handled by the component's `isPending`, so here:
 * idle / ok-with-tools / ok-without-tools / failed) and the tooltip text
 * branches that are easiest to break silently.
 */
// Identity-ish translator that echoes the key and interpolates {{n}} so the
// label/tooltip branches are observable without the real i18n bundle.
const t = (key: string, options?: Record<string, unknown>): string =>
  options && "n" in options
    ? key.replace("{{n}}", String((options as { n: unknown }).n))
    : key;

describe("mcpTestButtonView", () => {
  it("idle when there is no result", () => {
    expect(mcpTestButtonView(undefined, t)).toEqual({
      state: "idle",
      color: undefined,
      variant: "default",
      label: "Test",
      tooltip: "",
    });
  });

  it("ok with tools lists them in the tooltip", () => {
    expect(mcpTestButtonView({ ok: true, tools: ["a", "b"] }, t)).toEqual({
      state: "ok",
      color: "green",
      variant: "light",
      label: "OK · 2",
      tooltip: "a, b",
    });
  });

  it('ok with zero tools shows "No tools available"', () => {
    expect(mcpTestButtonView({ ok: true, tools: [] }, t)).toEqual({
      state: "ok",
      color: "green",
      variant: "light",
      label: "OK · 0",
      tooltip: "No tools available",
    });
  });

  it("failed surfaces the error text in the tooltip", () => {
    expect(
      mcpTestButtonView({ ok: false, error: "402: nope" }, t),
    ).toEqual({
      state: "failed",
      color: "red",
      variant: "light",
      label: "Failed",
      tooltip: "402: nope",
    });
  });
});
