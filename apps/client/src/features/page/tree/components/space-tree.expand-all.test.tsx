import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { render, waitFor, cleanup } from "@testing-library/react";

// --- Mocks for the heavy / networked module graph ---------------------------
// SpaceTree pulls in query hooks, page services, i18n, notifications and two
// child render components. The expandAll contract is exercised purely through
// the imperative ref, so we mock everything that would otherwise need a real
// server / router and stub the visual children to empty renders.

const getSpaceTreeMock = vi.fn();
const notificationsShowMock = vi.fn();

vi.mock("@/features/page/services/page-service.ts", () => ({
  getSpaceTree: (...args: unknown[]) => getSpaceTreeMock(...args),
  getPageBreadcrumbs: vi.fn(),
}));

vi.mock("@/features/page/queries/page-query.ts", () => ({
  // No root pages and no further pages — the data-load effect is inert so the
  // test fully controls the tree through expandAll.
  useGetRootSidebarPagesQuery: () => ({
    data: undefined,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetching: false,
  }),
  usePageQuery: () => ({ data: undefined }),
  fetchAllAncestorChildren: vi.fn(),
}));

vi.mock("@/features/page/tree/hooks/use-tree-mutation.ts", () => ({
  useTreeMutation: () => ({ handleMove: vi.fn() }),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...args: unknown[]) => notificationsShowMock(...args) },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ pageSlug: undefined }),
}));

vi.mock("@/lib", () => ({
  extractPageSlugId: () => undefined,
}));

vi.mock("@/lib/config.ts", () => ({
  isCompactPageTreeEnabled: () => false,
}));

// Stub the visual children so we don't drag in the full DnD / Mantine stack.
vi.mock("./doc-tree", () => ({
  DocTree: () => null,
  ROW_HEIGHT_COMPACT: 28,
  ROW_HEIGHT_STANDARD: 32,
}));
vi.mock("./space-tree-row", () => ({
  SpaceTreeRow: () => null,
}));

vi.mock("@mantine/core", () => ({
  Text: ({ children }: { children?: unknown }) => children ?? null,
}));

// The real openTreeNodesAtom is localStorage-backed (atomWithStorage +
// getOnInit), which crashes under jsdom's localStorage shim here. Swap in a
// plain in-memory atom with the same read value (OpenMap) and the same setter
// shape (value OR functional updater) so the component's open-state logic runs
// unchanged while staying inside the test store.
vi.mock("@/features/page/tree/atoms/open-tree-nodes-atom.ts", async () => {
  const { atom } = await import("jotai");
  type OpenMap = Record<string, boolean>;
  const base = atom<OpenMap>({});
  const openTreeNodesAtom = atom(
    (get) => get(base),
    (get, set, update: OpenMap | ((prev: OpenMap) => OpenMap)) => {
      const next =
        typeof update === "function"
          ? (update as (prev: OpenMap) => OpenMap)(get(base))
          : update;
      set(base, next);
    },
  );
  return { openTreeNodesAtom };
});

import SpaceTree, { SpaceTreeApi } from "./space-tree";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { openTreeNodesAtom } from "@/features/page/tree/atoms/open-tree-nodes-atom.ts";
import { createStore, Provider } from "jotai";
import type { SpaceTreeNode } from "@/features/page/tree/types.ts";

// A flat space-tree response (parentPageId pointers) that buildTree +
// buildTreeWithChildren nest into a multi-level tree. Depth > 1 lets us assert
// expandAll never fans out into per-branch fetches (no N+1).
function spaceTreeItems(): SpaceTreeNode[] {
  const n = (
    id: string,
    parentPageId: string | null,
    position: string,
  ): SpaceTreeNode => ({
    id,
    slugId: `slug-${id}`,
    name: id,
    icon: undefined,
    position,
    spaceId: "space-1",
    parentPageId: parentPageId as unknown as string,
    hasChildren: false,
    children: [],
  });
  return [
    n("root", null, "a0"),
    n("branch", "root", "a1"),
    n("leaf", "branch", "a1"),
  ];
}

function renderTree(store: ReturnType<typeof createStore>) {
  const ref = createRef<SpaceTreeApi>();
  render(
    <Provider store={store}>
      <SpaceTree ref={ref} spaceId="space-1" readOnly={false} />
    </Provider>,
  );
  return ref;
}

beforeEach(() => {
  getSpaceTreeMock.mockReset();
  notificationsShowMock.mockReset();
  // jsdom's localStorage shim here lacks `clear`; guard it. Each test uses a
  // fresh jotai store anyway, so cross-test open-state never leaks.
  try {
    localStorage.clear?.();
  } catch {
    /* ignore — fresh store per test isolates state */
  }
});

afterEach(() => {
  cleanup();
});

describe("SpaceTree.expandAll (integration via ref)", () => {
  it("makes exactly ONE getSpaceTree call regardless of depth (no N+1)", async () => {
    getSpaceTreeMock.mockResolvedValue(spaceTreeItems());
    const store = createStore();
    const ref = renderTree(store);

    await ref.current!.expandAll();

    expect(getSpaceTreeMock).toHaveBeenCalledTimes(1);
    expect(getSpaceTreeMock).toHaveBeenCalledWith({ spaceId: "space-1" });

    // Every branch node (root, branch) is opened; the leaf needs no entry.
    const openMap = store.get(openTreeNodesAtom);
    expect(openMap["root"]).toBe(true);
    expect(openMap["branch"]).toBe(true);
    expect(openMap["leaf"]).toBeUndefined();

    // The full tree replaced the current-space nodes.
    const data = store.get(treeDataAtom);
    expect(data.map((d) => d.id)).toEqual(["root"]);
  });

  it("shows a notification and still resets isExpanding when getSpaceTree rejects", async () => {
    getSpaceTreeMock.mockRejectedValue(new Error("boom"));
    const store = createStore();
    const ref = renderTree(store);

    await ref.current!.expandAll();

    expect(notificationsShowMock).toHaveBeenCalledTimes(1);
    expect(notificationsShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: "red" }),
    );

    // isExpanding must be reset in the finally block even on failure.
    await waitFor(() => {
      expect(ref.current!.isExpanding).toBe(false);
    });
  });

  it("aborts the merge when the space switches mid-flight", async () => {
    // getSpaceTree resolves only after we flip the tree to a different space,
    // simulating the user navigating away while the request is in flight.
    let resolveTree: (v: SpaceTreeNode[]) => void = () => {};
    getSpaceTreeMock.mockImplementation(
      () =>
        new Promise<SpaceTreeNode[]>((resolve) => {
          resolveTree = resolve;
        }),
    );

    const store = createStore();
    const ref = createRef<SpaceTreeApi>();
    const { rerender } = render(
      <Provider store={store}>
        <SpaceTree ref={ref} spaceId="space-1" readOnly={false} />
      </Provider>,
    );

    const promise = ref.current!.expandAll();

    // Switch the space mid-flight: spaceIdRef.current becomes "space-2".
    rerender(
      <Provider store={store}>
        <SpaceTree ref={ref} spaceId="space-2" readOnly={false} />
      </Provider>,
    );

    // Now resolve the in-flight request for the OLD space.
    resolveTree(spaceTreeItems());
    await promise;

    // The merge must have been aborted: no tree data written, no branches opened.
    expect(store.get(treeDataAtom)).toEqual([]);
    const openMap = store.get(openTreeNodesAtom);
    expect(openMap["root"]).toBeUndefined();
    expect(openMap["branch"]).toBeUndefined();
  });
});
