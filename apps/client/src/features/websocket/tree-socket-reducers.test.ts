import { describe, it, expect } from "vitest";
import {
  applyAddTreeNode,
  applyMoveTreeNode,
  applyDeleteTreeNode,
} from "./tree-socket-reducers";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";

// Minimal node factory — fills the SpaceTreeNode shape required fields while
// letting tests override the bits that matter (position, parentPageId, etc).
function node(
  id: string,
  overrides: Partial<SpaceTreeNode> = {},
): SpaceTreeNode {
  return {
    id,
    slugId: `slug-${id}`,
    name: id.toUpperCase(),
    icon: undefined,
    position: "a0",
    spaceId: "space-1",
    parentPageId: null as unknown as string,
    hasChildren: false,
    children: [],
    ...overrides,
  };
}

describe("applyMoveTreeNode", () => {
  // Destination parent `dst` is loaded with three positioned children; the moved
  // node `src` is a sibling at root with a later position.
  const buildTree = (): SpaceTreeNode[] => [
    node("dst", {
      position: "a0",
      hasChildren: true,
      children: [
        node("c1", { position: "a1", parentPageId: "dst" }),
        node("c2", { position: "a3", parentPageId: "dst" }),
        node("c3", { position: "a5", parentPageId: "dst" }),
      ],
    }),
    node("src", { position: "a9" }),
  ];

  it("places the node by position in the MIDDLE slot of the destination", () => {
    const tree = buildTree();
    const next = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "dst",
      oldParentId: null,
      index: 0,
      position: "a4",
      pageData: {},
    });
    expect(treeModel.find(next, "dst")?.children?.map((n) => n.id)).toEqual([
      "c1",
      "c2",
      "src",
      "c3",
    ]);
  });

  it("falls back to REMOVING the node when destination parent is not loaded (no leak)", () => {
    const tree = buildTree();
    const next = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "not-loaded",
      oldParentId: null,
      index: 0,
      position: "a4",
      pageData: {},
    });
    // The source must not linger at its old place — it is removed entirely.
    expect(treeModel.find(next, "src")).toBeNull();
    // Destination children are untouched.
    expect(treeModel.find(next, "dst")?.children?.map((n) => n.id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("does NOT create a partial child list when the destination is loaded-but-collapsed (children unloaded) — keeps it lazy-loadable (#159)", () => {
    // `dstCollapsed` is in the tree but its children were never lazy-loaded
    // (children === undefined). The OLD behavior inserted `src` as the ONLY
    // child ([src]), which defeated the lazy-load gate and HID the parent's
    // other real children. Now the move leaves children unloaded (so expanding
    // fetches the FULL set, including src) and just flags hasChildren.
    const tree: SpaceTreeNode[] = [
      node("dstCollapsed", {
        position: "a0",
        hasChildren: false,
        children: undefined as unknown as SpaceTreeNode[],
      }),
      node("src", { position: "a9" }),
    ];
    const next = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "dstCollapsed",
      oldParentId: null,
      index: 0,
      position: "a4",
      pageData: {},
    });
    const dst = treeModel.find(next, "dstCollapsed");
    // Children stay unloaded -> the lazy-load gate fetches the FULL set (incl.
    // src) on expand, rather than showing a misleading partial [src] list.
    expect(dst?.children).toBeUndefined();
    expect(dst?.hasChildren).toBe(true);
    // src moved away from its old root slot (it lives under dstCollapsed
    // server-side and reappears when the parent is expanded/loaded).
    expect(next.map((n) => n.id)).not.toContain("src");
  });

  it("flips the OLD parent's hasChildren to false when it is left childless", () => {
    // src is the only child of `old`; moving it to `dst` empties `old`.
    const tree: SpaceTreeNode[] = [
      node("old", {
        position: "a0",
        hasChildren: true,
        children: [node("src", { position: "a1", parentPageId: "old" })],
      }),
      node("dst", { position: "a2", hasChildren: false }),
    ];
    const next = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "dst",
      oldParentId: "old",
      index: 0,
      position: "a1",
      pageData: {},
    });
    expect(treeModel.find(next, "old")?.hasChildren).toBe(false);
  });

  it("flips the NEW parent's hasChildren to true", () => {
    // dst starts as a childless leaf; moving src into it must flip the chevron.
    const tree: SpaceTreeNode[] = [
      node("dst", { position: "a0", hasChildren: false }),
      node("src", { position: "a9" }),
    ];
    const next = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "dst",
      oldParentId: null,
      index: 0,
      position: "a1",
      pageData: {},
    });
    expect(treeModel.find(next, "dst")?.hasChildren).toBe(true);
    expect(treeModel.find(next, "dst")?.children?.map((n) => n.id)).toEqual([
      "src",
    ]);
  });

  it("returns prev unchanged when the source node is not found", () => {
    const tree = buildTree();
    const next = applyMoveTreeNode(tree, {
      id: "ghost",
      parentId: "dst",
      oldParentId: null,
      index: 0,
      position: "a4",
      pageData: {},
    });
    expect(next).toBe(tree);
  });

  it("applies authoritative pageData (title/icon/hasChildren) to the moved node", () => {
    const tree = buildTree();
    const next = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "dst",
      oldParentId: null,
      index: 0,
      position: "a4",
      pageData: { title: "Renamed", icon: "fire", hasChildren: true },
    });
    const moved = treeModel.find(next, "src");
    expect(moved?.name).toBe("Renamed");
    expect(moved?.icon).toBe("fire");
    expect(moved?.hasChildren).toBe(true);
    expect(moved?.position).toBe("a4");
  });

  it("does NOT drop a subtree on a cyclic/out-of-order move (parent inside source) (#206 ui-state-races-1)", () => {
    // Locally `b` is still nested inside `a` (an earlier "a under b" echo hasn't
    // applied yet). An out-of-order "move a under b" event now arrives — b is a
    // descendant of a, so re-parenting would make placeByPosition remove a (and
    // its whole subtree, incl. b) and fail to re-insert. Before the fix BOTH a
    // and b silently vanished; now the reducer leaves the tree untouched.
    const tree: SpaceTreeNode[] = [
      node("a", {
        position: "a0",
        hasChildren: true,
        children: [node("b", { position: "a1", parentPageId: "a" })],
      }),
    ];
    const next = applyMoveTreeNode(tree, {
      id: "a",
      parentId: "b",
      oldParentId: null,
      index: 0,
      position: "a4",
      pageData: {},
    });
    // No silent data loss: both nodes survive.
    expect(treeModel.find(next, "a")).not.toBeNull();
    expect(treeModel.find(next, "b")).not.toBeNull();
    // The cyclic move is refused as a no-op (same reference) pending reconcile.
    expect(next).toBe(tree);
  });
});

describe("applyDeleteTreeNode", () => {
  it("removes the node together with its descendants", () => {
    const tree: SpaceTreeNode[] = [
      node("p", {
        position: "a0",
        hasChildren: true,
        children: [
          node("child", {
            position: "a1",
            parentPageId: "p",
            hasChildren: true,
            children: [
              node("grandchild", { position: "a1", parentPageId: "child" }),
            ],
          }),
        ],
      }),
    ];
    const next = applyDeleteTreeNode(tree, {
      node: node("child", { parentPageId: "p" }),
    });
    expect(treeModel.find(next, "child")).toBeNull();
    expect(treeModel.find(next, "grandchild")).toBeNull();
    expect(treeModel.find(next, "p")).not.toBeNull();
  });

  it("returns prev unchanged when the node is already gone (idempotent)", () => {
    const tree: SpaceTreeNode[] = [node("a", { position: "a0" })];
    const next = applyDeleteTreeNode(tree, {
      node: node("ghost"),
    });
    expect(next).toBe(tree);
  });

  it("flips the parent's hasChildren to false when it is left childless", () => {
    const tree: SpaceTreeNode[] = [
      node("p", {
        position: "a0",
        hasChildren: true,
        children: [node("only", { position: "a1", parentPageId: "p" })],
      }),
    ];
    const next = applyDeleteTreeNode(tree, {
      node: node("only", { parentPageId: "p" }),
    });
    expect(treeModel.find(next, "p")?.hasChildren).toBe(false);
    expect(treeModel.find(next, "p")?.children).toEqual([]);
  });

  it("leaves the parent's hasChildren true when other children remain", () => {
    const tree: SpaceTreeNode[] = [
      node("p", {
        position: "a0",
        hasChildren: true,
        children: [
          node("c1", { position: "a1", parentPageId: "p" }),
          node("c2", { position: "a2", parentPageId: "p" }),
        ],
      }),
    ];
    const next = applyDeleteTreeNode(tree, {
      node: node("c1", { parentPageId: "p" }),
    });
    expect(treeModel.find(next, "p")?.hasChildren).toBe(true);
  });
});

describe("applyAddTreeNode", () => {
  const roots = (): SpaceTreeNode[] => [
    node("a", { position: "a0" }),
    node("b", { position: "a2" }),
    node("c", { position: "a4" }),
  ];

  it("inserts the new node by position among siblings", () => {
    const tree = roots();
    const next = applyAddTreeNode(tree, {
      parentId: null as unknown as string,
      index: 0,
      data: node("x", { position: "a3" }),
    });
    expect(next.map((n) => n.id)).toEqual(["a", "b", "x", "c"]);
  });

  it("returns prev unchanged when the id is already present (idempotent)", () => {
    const tree = roots();
    const next = applyAddTreeNode(tree, {
      parentId: null as unknown as string,
      index: 0,
      data: node("b", { position: "a9" }),
    });
    expect(next).toBe(tree);
    expect(next.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("flips the new parent's hasChildren to true", () => {
    // Parent `p` is a childless leaf; adding a child must flip its chevron.
    const tree: SpaceTreeNode[] = [
      node("p", { position: "a0", hasChildren: false }),
    ];
    const next = applyAddTreeNode(tree, {
      parentId: "p",
      index: 0,
      data: node("child", { position: "a1", parentPageId: "p" }),
    });
    expect(treeModel.find(next, "p")?.hasChildren).toBe(true);
    expect(treeModel.find(next, "p")?.children?.map((n) => n.id)).toEqual([
      "child",
    ]);
  });
});
