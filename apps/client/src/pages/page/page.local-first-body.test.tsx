import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { IPage } from "@/features/page/types/page.types";
import type { ICurrentUser } from "@/features/user/types/user.types";

/**
 * Ф7 (#643) — the body gate is removed: page.tsx now mounts FullEditor on the
 * cached META (not on `page && space`). These tests assert the DATA-LOSS-SAFE
 * props contract at the page.tsx level — the exact resolutions the issue calls
 * out as traps — by capturing what FullEditor receives (it is mocked to a bare
 * div; the body internals live in page-editor.local-first.test.tsx).
 *
 *  - trap 2 / crit 5 CROSS-PAGE BODY: `content` comes ONLY from `livePage`,
 *    never the possibly-PREVIOUS `page` (keepPreviousData). Navigating A→B with a
 *    cache-hit for B must show B's content (or nothing yet), NEVER A's body.
 *  - trap 3 ROUTING: `spaceSlug` comes from the ROUTE (useParams), never the
 *    meta cache (which stores none).
 *  - crit 10 flag OFF: the legacy `page && space` gate, byte-for-behavior.
 */

const fullEditorProps: Record<string, unknown>[] = [];

vi.mock("@/features/editor/full-editor", () => ({
  FullEditor: (props: Record<string, unknown>) => {
    fullEditorProps.push(props);
    return (
      <div
        data-testid="full-editor"
        data-page-id={String(props.pageId)}
        data-content={String(props.content)}
        data-space-slug={String(props.spaceSlug)}
        data-editable={String(props.editable)}
        data-body-pending={String(props.bodyContentPending)}
      />
    );
  },
}));

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

vi.mock("@/features/page-history/components/history-modal", () => ({
  default: ({ pageId }: { pageId: string }) => (
    <div data-testid="history-modal" data-page-id={pageId} />
  ),
}));

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
import { writePageMetaAtom } from "@/features/page/atoms/page-meta-cache-atom";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";

const B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function pageB(overrides: Partial<IPage> = {}): Partial<IPage> {
  return {
    id: B_ID,
    slugId: "slugB",
    title: "Page B",
    icon: null as unknown as string,
    spaceId: "space-1",
    space: { slug: "engineering" } as IPage["space"],
    permissions: { canEdit: true, hasRestriction: false },
    deletedAt: null as unknown as Date,
    ...overrides,
  };
}

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

// Route into page B; useParams (spaceSlug/pageSlug) is REAL via the router.
function renderPageB(store: ReturnType<typeof createStore>) {
  return render(
    <MantineProvider>
      <Provider store={store}>
        <MemoryRouter initialEntries={["/s/engineering/p/page-slugB"]}>
          <Routes>
            <Route path="/s/:spaceSlug/p/:pageSlug" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </Provider>
    </MantineProvider>,
  );
}

function lastProps() {
  return fullEditorProps[fullEditorProps.length - 1];
}

beforeEach(() => {
  localStorage.clear();
  fullEditorProps.length = 0;
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

describe("Ф7 body mount — cross-page body (trap 2 / crit 5)", () => {
  it("A→B with a cache-hit for B shows B's id and NEVER A's content (content from livePage only)", () => {
    // Cache holds B (this route). react-query hands back the PREVIOUS page A
    // (keepPreviousData) whose slugId/id do NOT match the route.
    const store = makeStore(pageB());
    pageQueryState.data = {
      id: A_ID,
      slugId: "slugA",
      title: "Page A (previous)",
      content: "AAA-PAGE-A-BODY",
      space: { slug: "engineering" },
      permissions: { canEdit: true },
    } as unknown as IPage;
    pageQueryState.isLoading = false;
    spaceData = { settings: {} };

    renderPageB(store);

    const props = lastProps();
    // The editor is keyed/identified by B (chromeMeta), never A.
    expect(props.pageId).toBe(B_ID);
    // content is A-free: livePage is undefined (A doesn't match the route), so
    // content is undefined — NEVER A's "AAA-PAGE-A-BODY".
    expect(props.content).toBeUndefined();
    // and the body knows it has no authoritative content yet → skeleton state.
    expect(props.bodyContentPending).toBe(true);
    // fail-closed editability while the live page for B has not resolved.
    expect(props.editable).toBe(false);
  });

  it("once B resolves, content is B's (and body no longer pending)", () => {
    const store = makeStore(pageB());
    pageQueryState.data = { ...pageB(), content: "BBB-PAGE-B-BODY" } as IPage;
    pageQueryState.isLoading = false;
    spaceData = { settings: {} };

    renderPageB(store);

    const props = lastProps();
    expect(props.pageId).toBe(B_ID);
    expect(props.content).toBe("BBB-PAGE-B-BODY");
    expect(props.bodyContentPending).toBe(false);
    expect(props.editable).toBe(true);
    // HistoryModal follows chromeMeta.id too.
    expect(
      screen.getByTestId("history-modal").getAttribute("data-page-id"),
    ).toBe(B_ID);
  });
});

describe("Ф7 body mount — routing (trap 3)", () => {
  it("spaceSlug comes from the ROUTE (useParams), never the meta cache", () => {
    // Cache-only (no live page): the meta cache deliberately stores no spaceSlug,
    // yet the body must still get one — from the route `/s/engineering/...`.
    const store = makeStore(pageB());
    // page query still pending (no live response).
    renderPageB(store);

    const props = lastProps();
    expect(props.pageId).toBe(B_ID);
    expect(props.spaceSlug).toBe("engineering");
    expect(props.bodyContentPending).toBe(true);
  });
});

describe("Ф7 flag OFF — the legacy `page && space` gate (crit 10)", () => {
  beforeEach(() => {
    process.env.LOCAL_FIRST_ENABLED = "false";
  });

  it("mounts the body only when BOTH page and space resolve, keyed by page.id", () => {
    const store = makeStore(); // cache is unusable with the flag off
    pageQueryState.data = { ...pageB(), content: "BBB-BODY" } as IPage;
    pageQueryState.isLoading = false;
    spaceData = { settings: {} };

    renderPageB(store);

    const props = lastProps();
    // Legacy path: content from `page`, spaceSlug from `page.space.slug`, and NO
    // bodyContentPending prop (the skeleton state is a flag-ON concept).
    expect(props.pageId).toBe(B_ID);
    expect(props.content).toBe("BBB-BODY");
    expect(props.spaceSlug).toBe("engineering");
    expect(props.bodyContentPending).toBeUndefined();
  });

  it("with the space NOT resolved, the body stays gated (no FullEditor)", () => {
    const store = makeStore();
    pageQueryState.data = { ...pageB(), content: "BBB-BODY" } as IPage;
    pageQueryState.isLoading = false;
    spaceData = undefined; // space still loading

    renderPageB(store);

    // The legacy gate holds: page without space → skeleton, no body.
    expect(screen.queryByTestId("full-editor")).toBeNull();
  });
});
