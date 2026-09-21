import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { render, act, waitFor, cleanup } from "@testing-library/react";

// --- Mocks for the heavy / networked module graph ---------------------------
// Same isolation strategy as space-tree.expand-all.test.tsx: everything that
// would otherwise need a real server / router / DnD stack is mocked. Here we
// additionally CAPTURE the DocTree props (onToggle + data) so the test can
// drive a lazy-load expand exactly as a row click would, and we control
// fetchAllAncestorChildren to assert the fresh fetch happens.

const fetchAllAncestorChildrenMock = vi.fn();

// Holder mutated by the DocTree stub each render so the test can read the
// latest tree it was handed and invoke its onToggle callback.
const docTree: {
  onToggle?: (id: string, isOpen: boolean) => void | Promise<void>;
  data: unknown[];
} = { data: [] };

vi.mock("@/features/page/services/page-service.ts", () => ({
  getSpaceTree: vi.fn(),
  getPageBreadcrumbs: vi.fn(),
}));

vi.mock("@/features/page/queries/page-query.ts", () => ({
  // No root pages and no further pages — the server data-load effect stays
  // inert (isDataLoaded never flips), so refreshOpenBranches never runs and the
  // test exercises ONLY the boot-prune + handleToggle lazy-load path against
  // the hydrated cache we seed into the atom below.
  useGetRootSidebarPagesQuery: () => ({
    data: undefined,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetching: false,
  }),
  usePageQuery: () => ({ data: undefined }),
  usePageMetaQuery: () => ({ data: undefined }),
  fetchAllAncestorChildren: (...args: unknown[]) =>
    fetchAllAncestorChildrenMock(...args),
}));

vi.mock("@/features/page/tree/hooks/use-tree-mutation.ts", () => ({
  useTreeMutation: () => ({ handleMove: vi.fn() }),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
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

// Capture the props DocTree is rendered with instead of rendering anything.
// The real module is spread in so the exported layout constants (row heights,
// icon sizes) are never hand-mirrored here and cannot drift.
vi.mock("./doc-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doc-tree")>()),
  DocTree: (props: { onToggle: (id: string, isOpen: boolean) => void; data: unknown[] }) => {
    docTree.onToggle = props.onToggle;
    docTree.data = props.data;
    return null;
  },
}));
vi.mock("./space-tree-row", () => ({
  SpaceTreeRow: () => null,
}));

vi.mock("@mantine/core", () => ({
  Text: ({ children }: { children?: unknown }) => children ?? null,
}));

// In-memory open-map (the real one is localStorage-backed and crashes under the
// jsdom shim). Empty at start of each test -> every branch is COLLAPSED, which
// is exactly the state we need to prove the boot-prune. `scopeKeyAtom` is
// re-exported because the persisted tree-data atom resolves its scope through it.
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
  const scopeKeyAtom = atom(() => "test-workspace:test-user");
  return { openTreeNodesAtom, scopeKeyAtom };
});

import SpaceTree, { SpaceTreeApi } from "./space-tree";
import {
  treeDataAtom,
  flushPendingTreeDataWrites,
} from "@/features/page/tree/atoms/tree-data-atom.ts";
import { createStore, Provider } from "jotai";
import type { SpaceTreeNode } from "@/features/page/tree/types.ts";

// The scopeKeyAtom mock resolves to this fixed scope, so the persisted
// tree-data atom hydrates from exactly this localStorage key at mount
// (getOnInit + atomWithStorage's onMount both read it).
const CACHE_KEY = "treeData:v1:test-workspace:test-user";

function child(
  id: string,
  parentPageId: string,
  hasChildren = false,
): SpaceTreeNode {
  return {
    id,
    slugId: `slug-${id}`,
    name: id,
    position: "a0",
    spaceId: "space-1",
    parentPageId,
    hasChildren,
    children: [],
  };
}

// A hydrated boot cache: a COLLAPSED branch (not in the open-map) that still
// carries a stale cached child — the exact shape a previous session left behind
// after the branch was expanded then collapsed then persisted.
function cachedTreeWithCollapsedBranch(): SpaceTreeNode[] {
  return [
    {
      id: "branch",
      slugId: "slug-branch",
      name: "branch",
      position: "a0",
      spaceId: "space-1",
      parentPageId: null as unknown as string,
      hasChildren: true,
      children: [child("stale", "branch")],
    },
  ];
}

beforeEach(() => {
  fetchAllAncestorChildrenMock.mockReset();
  docTree.onToggle = undefined;
  docTree.data = [];
  // Flush any pending debounced write from a previous test before clearing.
  flushPendingTreeDataWrites();
  try {
    localStorage.clear?.();
  } catch {
    /* fresh store per test isolates state */
  }
});

afterEach(() => {
  cleanup();
});

describe("SpaceTree boot-cache prune (#159 #8 stale collapsed children)", () => {
  it("drops a collapsed cached branch's children on boot and fetches fresh on first expand", async () => {
    // Server returns FRESH children on the lazy-load: the stale cached child is
    // gone, a renamed/new one takes its place.
    fetchAllAncestorChildrenMock.mockResolvedValue([child("fresh", "branch")]);

    // Simulate the localStorage-hydrated boot cache: seed the persisted key
    // BEFORE mount so the atom hydrates it (store.set would be clobbered by
    // atomWithStorage's onMount re-reading storage — this is the real path).
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify(cachedTreeWithCollapsedBranch()),
    );

    const store = createStore();
    const ref = createRef<SpaceTreeApi>();
    render(
      <Provider store={store}>
        <SpaceTree ref={ref} spaceId="space-1" readOnly={false} />
      </Provider>,
    );

    // Boot-prune ran at mount: the COLLAPSED branch's cached children were
    // dropped to the unloaded shape ([]), so the stale child is no longer there.
    const branchAfterBoot = docTree.data.find(
      (n) => (n as SpaceTreeNode).id === "branch",
    ) as SpaceTreeNode;
    expect(branchAfterBoot.children).toEqual([]);
    expect(branchAfterBoot.hasChildren).toBe(true);

    // First expand of the collapsed branch after boot must lazy-load fresh
    // children (before this fix the cached children were kept and the fetch
    // was skipped, showing stale data).
    await act(async () => {
      await docTree.onToggle!("branch", true);
    });

    expect(fetchAllAncestorChildrenMock).toHaveBeenCalledTimes(1);
    expect(fetchAllAncestorChildrenMock).toHaveBeenCalledWith({
      pageId: "branch",
      spaceId: "space-1",
    });

    // The fresh children replaced the stale cache in the live tree.
    await waitFor(() => {
      const branch = store
        .get(treeDataAtom)
        .find((n) => n.id === "branch")!;
      expect(branch.children.map((c) => c.id)).toEqual(["fresh"]);
    });
  });
});
