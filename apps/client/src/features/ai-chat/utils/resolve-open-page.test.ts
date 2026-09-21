import { describe, it, expect } from "vitest";
import { resolveOpenPage } from "./resolve-open-page.ts";

/**
 * #665 criterion 9 (the live bug): a stale keepPreviousData placeholder from
 * usePageMetaQuery must NOT be trusted as the open page. resolveOpenPage keeps the
 * page metadata only when it matches the route page id (by slugId OR uuid), else
 * null — so a chat started off a page (/home) neither binds nor is told "you are on
 * page X".
 */
describe("resolveOpenPage", () => {
  const page = { id: "page-uuid-1", slugId: "slug10chars", title: "Doc A" };

  it("returns the page when the route slugId matches", () => {
    expect(resolveOpenPage(page, "slug10chars")).toEqual({
      id: "page-uuid-1",
      title: "Doc A",
    });
  });

  it("returns the page when the route id is the raw uuid (/p/<uuid> URL)", () => {
    // extractPageSlugId returns a uuid unchanged; a slugId-only check would wrongly
    // null out a REAL open page here.
    expect(resolveOpenPage(page, "page-uuid-1")).toEqual({
      id: "page-uuid-1",
      title: "Doc A",
    });
  });

  it("null when the placeholder page does NOT match the route (stale /home case)", () => {
    // On /home the query is disabled but its placeholder still holds the last page;
    // routePageId is undefined -> nothing is the open page.
    expect(resolveOpenPage(page, undefined)).toBeNull();
  });

  it("null when a DIFFERENT page's placeholder lingers for the current route", () => {
    // Navigated to a new page whose fetch hasn't landed: the placeholder is the OLD
    // page, the route id is the NEW page's slug -> discard the stale placeholder.
    expect(resolveOpenPage(page, "other-slug")).toBeNull();
  });

  it("null when there is no page data at all", () => {
    expect(resolveOpenPage(undefined, "slug10chars")).toBeNull();
    expect(resolveOpenPage(null, "slug10chars")).toBeNull();
  });
});
