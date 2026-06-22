import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSuggestionItems } from "./menu-items";

// The slash-command `allow` callback (slash-command.ts) keeps the popup active
// only while at least one item matches the current query:
//   const groups = getSuggestionItems({ query });
//   const hasMatches = Object.values(groups).some((items) => items.length > 0);
//   return hasMatches;
// With `allowSpaces: true`, a non-empty query that matches nothing must collapse
// to an empty result so `allow` returns false and the menu closes (instead of
// leaving literal "/todo abc" text behind). These tests pin that contract at the
// `getSuggestionItems` boundary, which is the unit-testable half of `allow`.

const KEY = "currentUser";

function hasMatches(query: string): boolean {
  // Mirror the exact predicate used by slash-command.ts `allow`.
  const groups = getSuggestionItems({ query });
  return Object.values(groups).some((items) => items.length > 0);
}

beforeEach(() => {
  // Default workspace state: HTML-embed feature OFF (matches production default).
  localStorage.setItem(KEY, JSON.stringify({ workspace: { settings: {} } }));
});

afterEach(() => {
  localStorage.clear();
});

describe("getSuggestionItems — empty-query close behavior (slash `allow`)", () => {
  it("keeps the menu allowed for a query that matches items", () => {
    expect(hasMatches("h1")).toBe(true);
  });

  it("keeps the menu allowed for a multi-word matching query", () => {
    // "Heading 1" is a multi-word title kept alive by allowSpaces.
    expect(hasMatches("Heading 1")).toBe(true);
  });

  it("closes the menu (no matches) for a non-empty query that matches nothing", () => {
    expect(hasMatches("zzzznomatch")).toBe(false);
  });

  it("closes the menu for a space-bearing non-matching query", () => {
    // The exact case the allowSpaces fix targets: "/todo abc" matches nothing.
    expect(hasMatches("todo abc")).toBe(false);
  });

  it("returns an empty result object for a no-match query", () => {
    expect(getSuggestionItems({ query: "zzzznomatch" })).toEqual({});
  });

  it("returns a non-empty result for the 'Heading 1' query", () => {
    const groups = getSuggestionItems({ query: "Heading 1" });
    const titles = Object.values(groups)
      .flat()
      .map((item) => item.title);
    expect(titles).toContain("Heading 1");
  });
});
