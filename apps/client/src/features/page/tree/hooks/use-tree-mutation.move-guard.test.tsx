import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { treeModel } from "@/features/page/tree/model/tree-model";
import type { SpaceTreeNode } from "@/features/page/tree/types";

// --- Boundary mocks: only the network/query + router/i18n surfaces the hook
// touches. The tree math (treeModel, dropOpToMovePayload) runs for real so the
// child-loss guard is exercised end-to-end.
const moveMutate = vi.fn().mockResolvedValue({});
const updateCacheOnMovePageMock = vi.fn();
vi.mock("@/features/page/queries/page-query.ts", () => ({
  useCreatePageMutation: () => ({ mutateAsync: vi.fn() }),
  useUpdatePageMutation: () => ({ mutateAsync: vi.fn() }),
  useRemovePageMutation: () => ({ mutateAsync: vi.fn() }),
  useMovePageMutation: () => ({ mutateAsync: moveMutate }),
  updateCacheOnMovePage: (...args: unknown[]) =>
    updateCacheOnMovePageMock(...args),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ spaceSlug: "space", pageSlug: undefined }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

// Import AFTER mocks so the hook binds to them.
import { useTreeMutation } from "./use-tree-mutation";

function node(
  id: string,
  over: Partial<SpaceTreeNode> = {},
): SpaceTreeNode {
  return {
    id,
    slugId: `slug-${id}`,
    name: id.toUpperCase(),
    position: "a0",
    spaceId: "space-1",
    parentPageId: null as unknown as string,
    hasChildren: false,
    children: [],
    ...over,
  };
}

function setup(before: SpaceTreeNode[]) {
  const store = createStore();
  store.set(treeDataAtom, before);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  const { result } = renderHook(() => useTreeMutation("space-1"), { wrapper });
  return { store, result };
}

describe("useTreeMutation.handleMove — child-loss guard (#523)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moveMutate.mockResolvedValue({});
  });

  it("make-child into an UNLOADED folder does NOT materialize [source] — keeps it lazy-loadable", async () => {
    // F has children on the server but none are loaded here (canonical unloaded
    // form: hasChildren + children:[]). X sits at root.
    const before = [
      node("F", { position: "a0", hasChildren: true, children: [] }),
      node("X", { position: "a5" }),
    ];
    const { store, result } = setup(before);

    await act(async () => {
      await result.current.handleMove("X", {
        kind: "make-child",
        targetId: "F",
      });
    });

    const tree = store.get(treeDataAtom);
    const f = treeModel.find(tree, "F");
    // The guard leaves F unloaded (children stay []), so a later expand fetches
    // the FULL server set (incl. X) instead of showing a misleading partial [X].
    // MUTATION: dropping the guard (using the `move` result) would put children
    // === [X] here and redden this.
    expect(f?.children).toEqual([]);
    expect(f?.hasChildren).toBe(true);
    // X is removed from its old (root) slot; it reappears on expand/load of F.
    expect(treeModel.find(tree, "X")).toBeNull();
    // The server move is still persisted.
    expect(moveMutate).toHaveBeenCalledTimes(1);
  });

  it("make-child into a LOADED folder appends source and KEEPS the existing children", async () => {
    // F is loaded with one child c1; moving X in must preserve c1 (no loss) and
    // append X — this path does NOT hit the guard.
    const before = [
      node("F", {
        position: "a0",
        hasChildren: true,
        children: [node("c1", { position: "a1", parentPageId: "F" })],
      }),
      node("X", { position: "a5" }),
    ];
    const { store, result } = setup(before);

    await act(async () => {
      await result.current.handleMove("X", {
        kind: "make-child",
        targetId: "F",
      });
    });

    const tree = store.get(treeDataAtom);
    const f = treeModel.find(tree, "F");
    expect(f?.children?.map((n) => n.id)).toEqual(["c1", "X"]);
    expect(f?.hasChildren).toBe(true);
    // X now lives under F.
    expect(treeModel.find(tree, "X")?.parentPageId).toBe("F");
  });

  it("make-child into a genuinely-empty leaf materializes the child (nothing to lose)", async () => {
    // Leaf L has no server children (hasChildren:false). Dropping X in should
    // show X immediately — the guard must NOT fire here.
    const before = [
      node("L", { position: "a0", hasChildren: false, children: [] }),
      node("X", { position: "a5" }),
    ];
    const { store, result } = setup(before);

    await act(async () => {
      await result.current.handleMove("X", {
        kind: "make-child",
        targetId: "L",
      });
    });

    const tree = store.get(treeDataAtom);
    const l = treeModel.find(tree, "L");
    expect(l?.children?.map((n) => n.id)).toEqual(["X"]);
    expect(l?.hasChildren).toBe(true);
  });
});
