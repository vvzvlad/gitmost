import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { Provider, createStore } from "jotai";
import type { IPage } from "@/features/page/types/page.types";
import type { ICurrentUser } from "@/features/user/types/user.types";

// #563 — the boot cache makes page.tsx render the REAL <PageHeader/> as soon as
// the cached metadata exists, i.e. BEFORE the page query resolves. The header's
// menu reads the SAME `["pages", id]` query, so it too sees `undefined` on that
// first paint. This suite therefore renders the header FOR REAL (deliberately
// NOT mocked — the wholesale header mock in page.test.tsx is precisely what let
// an unguarded `page.lastUpdatedBy.name` through): the chrome must paint, and
// nothing may throw into the page's ErrorBoundary.

const pageQueryState: {
  data?: IPage;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
} = { data: undefined, isLoading: true, isError: false, error: undefined };

// NOTE: `vi.mock` factories are hoisted above every declaration in this file, so
// they may only close over values read LAZILY at call time (`pageQueryState`) —
// anything evaluated during the factory itself is declared inside it.

// One stub for BOTH page hooks: in the app they share the query-cache entry
// `["pages", <id>]`, so "the response has not arrived yet" is the same state for
// the page body and for the header menu. The other stubs below only replace what
// would hit the network; the header, its menu and the breadcrumb are REAL.
vi.mock("@/features/page/queries/page-query", () => {
  const noop = () => ({
    mutate: () => undefined,
    mutateAsync: async () => ({}),
    isPending: false,
  });
  return {
    usePageQuery: () => pageQueryState,
    usePageMetaQuery: () => pageQueryState,
    usePageBreadcrumbsQuery: () => ({ data: undefined }),
    useCreatePageMutation: noop,
    useRemovePageMutation: noop,
    useMovePageMutation: noop,
    useUpdatePageMutation: noop,
    updateCacheOnMovePage: () => undefined,
  };
});

// Several modules the header pulls in import the app's shared `queryClient` from
// main.tsx — importing that file for real would BOOTSTRAP the whole app (it calls
// ReactDOM.createRoot on #root). Hand them a standalone client instead.
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useGetSpaceBySlugQuery: () => ({ data: undefined }),
  // ShareModal (rendered once the live page confirms edit rights) reads this.
  useSpaceQuery: () => ({ data: undefined }),
}));

vi.mock("@/features/favorite/queries/favorite-query", () => {
  const noop = () => ({
    mutate: () => undefined,
    mutateAsync: async () => ({}),
    isPending: false,
  });
  return {
    useFavoriteIds: () => new Set<string>(),
    useAddFavoriteMutation: noop,
    useRemoveFavoriteMutation: noop,
  };
});

vi.mock("@/features/page/queries/watcher-query", () => {
  const noop = () => ({
    mutate: () => undefined,
    mutateAsync: async () => ({}),
    isPending: false,
  });
  return {
    useWatchStatusQuery: () => ({ data: undefined }),
    useWatchPageMutation: noop,
    useUnwatchPageMutation: noop,
  };
});

vi.mock("@/features/page-embed/queries/page-embed-query.ts", () => ({
  useToggleTemporaryMutation: () => ({
    mutate: () => undefined,
    mutateAsync: async () => ({}),
    isPending: false,
  }),
  syncTemporaryExpiresInCache: () => undefined,
}));

vi.mock("@/features/editor/full-editor", () => ({
  FullEditor: () => <div data-testid="full-editor" />,
}));

vi.mock("@/features/page-history/components/history-modal", () => ({
  default: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ defaults }: { defaults?: string }) => <span>{defaults}</span>,
  // src/i18n.ts (pulled in transitively by lib/time.ts) plugs this into i18next.
  initReactI18next: { type: "3rdParty", init: () => undefined },
}));

import Page from "./page";
import { writePageMetaAtom } from "@/features/page/atoms/page-meta-cache-atom";
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
    // The cache is told the user may edit — and must still grant nothing.
    permissions: { canEdit: true, hasRestriction: false },
    deletedAt: null as unknown as Date,
    ...overrides,
  };
}

/** The page as the server returns it, once the request finally lands. */
function livePage(overrides: Partial<IPage> = {}): IPage {
  return {
    ...cachedPage(),
    content: "{}",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z",
    creator: { name: "Ada" },
    lastUpdatedBy: { name: "Ada" },
    ...overrides,
  } as unknown as IPage;
}

// Each test gets its own (workspace, user) scope: the cache atom family is
// module-global, so a shared scope would leak one test's entry into the next.
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

function tree(store: ReturnType<typeof createStore>, queryClient: QueryClient) {
  return (
    <HelmetProvider>
      <MantineProvider>
        <QueryClientProvider client={queryClient}>
          <Provider store={store}>
            <MemoryRouter initialEntries={["/s/engineering/p/page-slug1"]}>
              <Routes>
                <Route path="/s/:spaceSlug/p/:pageSlug" element={<Page />} />
              </Routes>
            </MemoryRouter>
          </Provider>
        </QueryClientProvider>
      </MantineProvider>
    </HelmetProvider>
  );
}

function renderPage(store: ReturnType<typeof createStore>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(tree(store, queryClient));
  return {
    ...utils,
    // Re-render the SAME tree after the query state changed (the live response).
    update: () => utils.rerender(tree(store, queryClient)),
  };
}

const header = () => document.querySelector("[data-page-header]");

beforeEach(() => {
  localStorage.clear();
  process.env.LOCAL_FIRST_ENABLED = "true";
  pageQueryState.data = undefined;
  pageQueryState.isLoading = true;
  pageQueryState.isError = false;
  pageQueryState.error = undefined;
});

afterEach(() => {
  delete process.env.LOCAL_FIRST_ENABLED;
  vi.restoreAllMocks();
});

describe("real PageHeader, cache hit, page query still pending (#563)", () => {
  it("paints the chrome and never throws into the ErrorBoundary", () => {
    // Before the guard, PageActionMenu dereferenced `page.lastUpdatedBy.name`,
    // `page.id`, `page.slugId` — every one of them undefined here — and the
    // ErrorBoundary showed "Failed to load page" on EVERY reload of a cached page.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeStore(cachedPage());

    renderPage(store);

    expect(
      screen.queryByText("Failed to load page. An error occurred."),
    ).toBeNull();
    expect(header()).not.toBeNull();
    // React logs the caught render error before the boundary swaps the UI, so an
    // empty console is a second, independent witness that nothing threw.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("offers the page-actions menu only once the live page lands", () => {
    const store = makeStore(cachedPage());
    const { update } = renderPage(store);

    // Cache hit, no response: the trigger keeps the header's shape but is inert —
    // every item behind it acts on a page we have not re-validated.
    expect(screen.getByLabelText("Page actions").hasAttribute("disabled")).toBe(
      true,
    );

    pageQueryState.data = livePage();
    pageQueryState.isLoading = false;
    update();

    expect(screen.getByLabelText("Page actions").hasAttribute("disabled")).toBe(
      false,
    );
  });
});
