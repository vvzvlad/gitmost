import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDefaultStore } from "jotai";

// Mock the app entry so importing the query module doesn't boot the whole app
// (it only needs queryClient's cache methods, which we stub here). The spies are
// declared via vi.hoisted so they exist before the hoisted vi.mock factory runs.
const { setQueryData, getQueryData, invalidateQueries } = vi.hoisted(() => ({
  setQueryData: vi.fn(),
  getQueryData: vi.fn(() => undefined as unknown),
  invalidateQueries: vi.fn(),
}));
vi.mock("@/main.tsx", () => ({
  queryClient: { setQueryData, getQueryData, invalidateQueries },
}));

import { syncTemporaryExpiresInCache } from "./page-embed-query";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";

const mkNode = (id: string, slugId: string): SpaceTreeNode =>
  ({
    id,
    slugId,
    name: id,
    position: "a0",
    spaceId: "space-1",
    parentPageId: null,
    hasChildren: false,
    children: [],
  }) as unknown as SpaceTreeNode;

describe("syncTemporaryExpiresInCache — treeDataAtom patch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getQueryData.mockReturnValue(undefined);
  });

  it("patches the in-tree node's temporaryExpiresAt (sidebar marker updates without reload)", () => {
    const store = getDefaultStore();
    const tree = [mkNode("p1", "slug-1"), mkNode("p2", "slug-2")];
    store.set(treeDataAtom, tree);

    const deadline = "2026-07-01T00:00:00.000Z";
    syncTemporaryExpiresInCache({ id: "p1", slugId: "slug-1" }, deadline);

    const next = store.get(treeDataAtom);
    // A new atom value was written...
    expect(next).not.toBe(tree);
    // ...the matching node gained the deadline...
    expect(next.find((n) => n.id === "p1")?.temporaryExpiresAt).toBe(deadline);
    // ...and the untouched sibling is unchanged.
    expect(next.find((n) => n.id === "p2")?.temporaryExpiresAt).toBeUndefined();
  });

  it("leaves the atom value at the SAME reference when the id is absent from the tree (no write)", () => {
    const store = getDefaultStore();
    const tree = [mkNode("p1", "slug-1")];
    store.set(treeDataAtom, tree);

    syncTemporaryExpiresInCache(
      { id: "not-in-tree", slugId: "missing" },
      "2026-07-01T00:00:00.000Z",
    );

    // treeModel.update is a no-op (same reference) for an unknown id, so the
    // guard skips the store write entirely — same reference back.
    expect(store.get(treeDataAtom)).toBe(tree);
  });
});
