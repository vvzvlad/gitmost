import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSuggestionItems } from "./menu-items";

// Coverage for the filter/sort half of `getSuggestionItems` (distinct from the
// HTML-embed gating suite). A slash query is matched against each item three
// ways — fuzzy on the title, substring on the description, and substring on the
// searchTerms — and matched items are sorted so title-substring hits float to
// the top of their group. We also cover `excludeItems`.
//
// `getSuggestionItems` -> `isHtmlEmbedFeatureEnabled` reads the persisted
// `currentUser` localStorage entry, so a working in-memory Storage stub is a
// prerequisite (installed by vitest.setup.ts). We persist a `currentUser` with
// the HTML-embed toggle OFF (the production default) so the gated "HTML embed"
// item never leaks into these non-HTML queries.

const KEY = "currentUser";

function flatTitles(groups: ReturnType<typeof getSuggestionItems>): string[] {
  return Object.values(groups)
    .flat()
    .map((item) => item.title);
}

beforeEach(() => {
  // Default workspace state: HTML-embed feature OFF (matches production default).
  localStorage.setItem(KEY, JSON.stringify({ workspace: { settings: {} } }));
});

afterEach(() => {
  localStorage.clear();
});

describe("getSuggestionItems — filter and sort", () => {
  it("fuzzy-matches a title (non-contiguous characters)", () => {
    // "tdo" is not a substring of "to-do list" but matches fuzzily (t..d..o).
    const titles = flatTitles(getSuggestionItems({ query: "tdo" }));
    expect(titles).toContain("To-do list");
  });

  it("matches via the description when the title does not match", () => {
    // "numbering" only appears in the description "Create a list with numbering.",
    // not in the "Numbered list" title nor its searchTerms.
    const titles = flatTitles(getSuggestionItems({ query: "numbering" }));
    expect(titles).toContain("Numbered list");
  });

  it("matches via searchTerms when title and description do not match", () => {
    // "blockquote" is only present in the "Quote" item's searchTerms.
    const titles = flatTitles(getSuggestionItems({ query: "blockquote" }));
    expect(titles).toContain("Quote");
  });

  it("sorts title-substring matches before non-title (description) matches", () => {
    // For "page": several titles contain "page" (e.g. "Page break"), while
    // "Synced block" matches only through its description (".. across pages.").
    // The sort tie-break must place every title hit ahead of the non-title hit.
    const titles = flatTitles(getSuggestionItems({ query: "page" }));

    const syncedIndex = titles.indexOf("Synced block");
    const pageBreakIndex = titles.indexOf("Page break");

    // Sanity: both items survived the filter for this query.
    expect(syncedIndex).toBeGreaterThanOrEqual(0);
    expect(pageBreakIndex).toBeGreaterThanOrEqual(0);

    // The title match ("Page break") sorts before the description-only match.
    expect(pageBreakIndex).toBeLessThan(syncedIndex);
  });

  it("removes a named item via excludeItems", () => {
    const withBullet = flatTitles(getSuggestionItems({ query: "list" }));
    expect(withBullet).toContain("Bullet list");

    const withoutBullet = flatTitles(
      getSuggestionItems({
        query: "list",
        excludeItems: new Set(["Bullet list"]),
      }),
    );
    expect(withoutBullet).not.toContain("Bullet list");
    // Other "list" matches remain unaffected by the exclusion.
    expect(withoutBullet).toContain("Numbered list");
  });
});
