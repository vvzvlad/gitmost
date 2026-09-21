import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { IPage } from "@/features/page/types/page.types";
import type { ICurrentUser } from "@/features/user/types/user.types";

// Page chrome (#563): rendered from the localStorage boot cache BEFORE the
// network answers. The queries are stubbed so "no network response yet" is a
// state we can hold indefinitely; the boot cache itself is the real module.

const pageQueryState: {
  data?: IPage;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
} = { data: undefined, isLoading: true, isError: false, error: undefined };

let spaceData: unknown = undefined;

vi.mock("@/features/page/queries/page-query", () => ({
  usePageQuery: () => pageQueryState,
}));

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useGetSpaceBySlugQuery: () => ({ data: spaceData }),
}));

vi.mock("@/features/editor/full-editor", () => ({
  FullEditor: () => <div data-testid="full-editor" />,
}));

vi.mock("@/features/page-history/components/history-modal", () => ({
  default: () => null,
}));

// The real header pulls in the whole menu/collab stack; the assertions here only
// need to know that it rendered and with which readOnly flag. That the REAL
// header survives an unresolved page query is a separate, deliberately
// un-mocked suite: page-chrome-real-header.test.tsx.
vi.mock("@/features/page/components/header/page-header.tsx", () => ({
  default: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="page-header" data-readonly={String(readOnly)} />
  ),
}));

vi.mock("react-helmet-async", () => ({
  Helmet: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="helmet">{children}</div>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import Page from "./page";
import {
  pageMetaCacheAtom,
  writePageMetaAtom,
} from "@/features/page/atoms/page-meta-cache-atom";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";

function cachedPage(overrides: Partial<IPage> = {}): Partial<IPage> {
  return {
    id: PAGE_ID,
    slugId: "slug1",
    title: "Cached title",
    icon: "🚀",
    spaceId: "space-1",
    space: { slug: "engineering" } as IPage["space"],
    permissions: { canEdit: true, hasRestriction: false },
    deletedAt: null as unknown as Date,
    ...overrides,
  };
}

function renderPage(store: ReturnType<typeof createStore>) {
  return render(
    <MantineProvider>
      <Provider store={store}>
        <MemoryRouter initialEntries={["/s/engineering/p/page-slug1"]}>
          <Routes>
            <Route path="/s/:spaceSlug/p/:pageSlug" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </Provider>
    </MantineProvider>,
  );
}

// The chrome is "the title + the header": a skeleton-only render has neither.
function chromeTitle(): string | null {
  return screen.queryByTestId("helmet")?.textContent ?? null;
}

// Each test gets its OWN (workspace, user) scope: the cache atom family and its
// debounced write queue are module-global, so a shared scope would let one
// test's cached entry hydrate the next test's "empty cache" store.
let scopeCounter = 0;

function makeStore(seed?: Partial<IPage>) {
  scopeCounter += 1;
  const store = createStore();
  store.set(currentUserAtom, {
    user: { id: `u${scopeCounter}` },
    workspace: { id: `w${scopeCounter}` },
  } as unknown as ICurrentUser);
  if (seed) store.set(writePageMetaAtom, seed);
  return store;
}

beforeEach(() => {
  localStorage.clear();
  process.env.LOCAL_FIRST_ENABLED = "true";
  pageQueryState.data = undefined;
  pageQueryState.isLoading = true;
  pageQueryState.isError = false;
  pageQueryState.error = undefined;
  spaceData = undefined;
});

afterEach(() => {
  delete process.env.LOCAL_FIRST_ENABLED;
  vi.restoreAllMocks();
});

describe("Page chrome (local-first boot cache)", () => {
  it("renders the chrome from the cache with NO network response — no skeleton chrome", () => {
    const store = makeStore(cachedPage());
    // Sanity: the entry really is in the cache the component will read.
    expect(store.get(pageMetaCacheAtom)["slug1"]).toBeDefined();

    renderPage(store);

    // Title + header are on screen even though the page query is still pending.
    expect(chromeTitle()).toContain("Cached title");
    // The page icon is a Lucide IconRef now, not a glyph renderable in a
    // text-only <title>; the legacy emoji no longer prefixes the tab title.
    expect(chromeTitle()).not.toContain("🚀");
    expect(screen.getByTestId("page-header")).toBeDefined();
    // Ф7 (#643) — the body NO LONGER waits for the network: with local-first ON
    // the editor mounts on the cached meta (it renders from the local ydoc / a
    // skeleton internally). Phase 1's "body stays skeleton until /pages/info"
    // assertion is exactly what #643 removes.
    expect(screen.getByTestId("full-editor")).toBeDefined();
  });

  it("FAIL-CLOSED: a cached canEdit:true is read-only until the LIVE response confirms it", () => {
    // The cached page says the user may edit. A permission downgrade (editor ->
    // viewer) still returns a perfectly readable page — no 403/404 — so nothing
    // would ever evict that cached `canEdit`. Edit affordances therefore wait for
    // the live response; only the chrome paints from the cache.
    const store = makeStore(
      cachedPage({ permissions: { canEdit: true, hasRestriction: false } }),
    );
    const { rerender } = renderPage(store);

    expect(chromeTitle()).toContain("Cached title");
    expect(screen.getByTestId("page-header").getAttribute("data-readonly")).toBe(
      "true",
    );

    // The live response lands and confirms the rights -> editable.
    pageQueryState.data = {
      ...cachedPage(),
      content: "{}",
    } as unknown as IPage;
    pageQueryState.isLoading = false;
    spaceData = { settings: {} };
    rerender(
      <MantineProvider>
        <Provider store={store}>
          <MemoryRouter initialEntries={["/s/engineering/p/page-slug1"]}>
            <Routes>
              <Route path="/s/:spaceSlug/p/:pageSlug" element={<Page />} />
            </Routes>
          </MemoryRouter>
        </Provider>
      </MantineProvider>,
    );

    expect(screen.getByTestId("page-header").getAttribute("data-readonly")).toBe(
      "false",
    );
  });

  it("keeps a LIVE trashed page read-only (deletedAt beats canEdit)", () => {
    const store = makeStore(cachedPage());
    pageQueryState.data = {
      ...cachedPage({
        deletedAt: "2026-07-01T00:00:00.000Z" as unknown as Date,
      }),
      content: "{}",
    } as unknown as IPage;
    pageQueryState.isLoading = false;
    spaceData = { settings: {} };

    renderPage(store);
    expect(screen.getByTestId("page-header").getAttribute("data-readonly")).toBe(
      "true",
    );
  });

  it("cache MISS falls back to today's skeleton (no chrome, no header)", () => {
    const store = makeStore(); // nothing cached
    renderPage(store);

    expect(screen.queryByTestId("helmet")).toBeNull();
    expect(screen.queryByTestId("page-header")).toBeNull();
    expect(screen.queryByTestId("full-editor")).toBeNull();
  });

  it("reconciles: the live query's title beats a stale cached title", () => {
    const store = makeStore(cachedPage({ title: "Stale title" }));
    const { rerender } = renderPage(store);
    expect(chromeTitle()).toContain("Stale title");

    // The forced on-mount refetch lands with a renamed page.
    pageQueryState.data = {
      ...cachedPage({ title: "Renamed on the server" }),
      content: "{}",
    } as unknown as IPage;
    pageQueryState.isLoading = false;
    spaceData = { settings: {} };

    rerender(
      <MantineProvider>
        <Provider store={store}>
          <MemoryRouter initialEntries={["/s/engineering/p/page-slug1"]}>
            <Routes>
              <Route path="/s/:spaceSlug/p/:pageSlug" element={<Page />} />
            </Routes>
          </MemoryRouter>
        </Provider>
      </MantineProvider>,
    );

    expect(chromeTitle()).toContain("Renamed on the server");
    expect(chromeTitle()).not.toContain("Stale title");
    // Body swaps in once the full page AND the space have resolved.
    expect(screen.getByTestId("full-editor")).toBeDefined();
  });

  it("ignores the keepPreviousData placeholder: chrome shows THIS page, not the previous one", () => {
    const store = makeStore(cachedPage()); // cache holds slug1 = "Cached title"
    // react-query hands back the PREVIOUS page while navigating into slug1.
    pageQueryState.data = {
      id: "99999999-9999-4999-8999-999999999999",
      slugId: "other",
      title: "Previously open page",
      content: "{}",
      space: { slug: "engineering" },
      permissions: { canEdit: true },
    } as unknown as IPage;
    pageQueryState.isLoading = false;
    spaceData = { settings: {} };

    renderPage(store);

    expect(chromeTitle()).toContain("Cached title");
    expect(chromeTitle()).not.toContain("Previously open page");
    // Body behavior is unchanged: the previous page's editor stays until the new
    // content arrives (phase 1 does not touch the body).
    expect(screen.getByTestId("full-editor")).toBeDefined();
  });

  it("403/404 shows not-found — never the stale cached chrome", () => {
    const store = makeStore(cachedPage());
    pageQueryState.isLoading = false;
    pageQueryState.isError = true;
    pageQueryState.error = { status: 403 };

    renderPage(store);

    expect(screen.getByText("Page not found")).toBeDefined();
    expect(screen.queryByTestId("helmet")).toBeNull();
    expect(screen.queryByTestId("page-header")).toBeNull();
  });
});
