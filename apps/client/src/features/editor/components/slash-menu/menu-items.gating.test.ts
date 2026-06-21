import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSuggestionItems,
  isHtmlEmbedFeatureEnabled,
} from "./menu-items";

// Gating coverage for the workspace-level "HTML embed" slash item. The gate is
// read from the persisted `currentUser` localStorage entry (the same payload
// `currentUserAtom` writes). It must default to OFF, only show when the toggle
// is explicitly true, and never throw on a broken/garbage stored value.

const KEY = "currentUser";

function setCurrentUser(value: unknown): void {
  localStorage.setItem(KEY, JSON.stringify(value));
}

afterEach(() => {
  localStorage.clear();
});

describe("isHtmlEmbedFeatureEnabled (workspace toggle gate)", () => {
  it("is OFF when no currentUser is persisted (default)", () => {
    localStorage.removeItem(KEY);
    expect(isHtmlEmbedFeatureEnabled()).toBe(false);
  });

  it("is OFF when the toggle is absent from workspace settings", () => {
    setCurrentUser({ workspace: { settings: {} } });
    expect(isHtmlEmbedFeatureEnabled()).toBe(false);
  });

  it("is OFF when the toggle is explicitly false", () => {
    setCurrentUser({ workspace: { settings: { htmlEmbed: false } } });
    expect(isHtmlEmbedFeatureEnabled()).toBe(false);
  });

  it("is ON only when the toggle is exactly true", () => {
    setCurrentUser({ workspace: { settings: { htmlEmbed: true } } });
    expect(isHtmlEmbedFeatureEnabled()).toBe(true);
  });

  it("does not throw and returns false on a broken localStorage value", () => {
    // Invalid JSON: JSON.parse throws; the gate must swallow it -> false.
    localStorage.setItem(KEY, "{not valid json");
    expect(() => isHtmlEmbedFeatureEnabled()).not.toThrow();
    expect(isHtmlEmbedFeatureEnabled()).toBe(false);
  });
});

function hasHtmlEmbedItem(query = "html"): boolean {
  const groups = getSuggestionItems({ query });
  return Object.values(groups)
    .flat()
    .some((item) => item.title === "HTML embed");
}

describe("getSuggestionItems — HTML embed item gating", () => {
  it("hides the HTML embed item when the toggle is OFF (default)", () => {
    localStorage.removeItem(KEY);
    expect(hasHtmlEmbedItem()).toBe(false);
  });

  it("hides the HTML embed item when the toggle is explicitly false", () => {
    setCurrentUser({ workspace: { settings: { htmlEmbed: false } } });
    expect(hasHtmlEmbedItem()).toBe(false);
  });

  it("shows the HTML embed item when the toggle is ON", () => {
    setCurrentUser({ workspace: { settings: { htmlEmbed: true } } });
    expect(hasHtmlEmbedItem()).toBe(true);
  });

  it("hides the item without throwing on a broken localStorage value", () => {
    localStorage.setItem(KEY, "{not valid json");
    expect(() => getSuggestionItems({ query: "html" })).not.toThrow();
    expect(hasHtmlEmbedItem()).toBe(false);
  });
});
