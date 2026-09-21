import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IPage } from "@/features/page/types/page.types";

// A fresh QueryClient stands in for the app singleton (importing the real
// @/main.tsx would run ReactDOM.createRoot, which has no DOM root in jsdom).
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

import { queryClient } from "@/main.tsx";
import { updateCacheOnMovePage } from "./page-query";

// #523: the tree-side child-loss guard removes the moved node from the local
// tree when its new parent is an unloaded branch, so `findBreadcrumbPath` misses
// it and the breadcrumb bar falls back to the server `["breadcrumbs", pageId]`
// query. That query MUST be invalidated by a move, or the crumbs keep showing
// the OLD parent until a refocus/navigation.
describe("updateCacheOnMovePage — breadcrumbs invalidation (#523)", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it("invalidates the moved page's ['breadcrumbs', pageId] query", () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    updateCacheOnMovePage("s1", "moved-page", "old-parent", "new-parent", {
      id: "moved-page",
    } as Partial<IPage>);

    const invalidatedBreadcrumbs = spy.mock.calls.some(
      ([arg]) =>
        Array.isArray((arg as { queryKey?: unknown[] })?.queryKey) &&
        (arg as { queryKey: unknown[] }).queryKey[0] === "breadcrumbs" &&
        (arg as { queryKey: unknown[] }).queryKey[1] === "moved-page",
    );
    expect(invalidatedBreadcrumbs).toBe(true);
  });
});
