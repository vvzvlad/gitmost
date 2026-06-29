import { describe, it, expect } from "vitest";
import {
  applyAddTreeNode,
  applyMoveTreeNode,
  applyDeleteTreeNode,
  applyUpdateOne,
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

  it("carries temporaryExpiresAt onto the inserted node so the clock marker shows on create (no reload)", () => {
    // A note created as temporary broadcasts addTreeNode with the death-timer
    // deadline in its payload; the receiver's inserted node must keep it so
    // space-tree-row renders the orange clock marker immediately.
    const tree = roots();
    const expiresAt = "2026-06-27T21:00:00.000Z";
    const next = applyAddTreeNode(tree, {
      parentId: null as unknown as string,
      index: 0,
      data: node("temp", { position: "a3", temporaryExpiresAt: expiresAt }),
    });
    expect(treeModel.find(next, "temp")?.temporaryExpiresAt).toBe(expiresAt);
  });
});

describe("applyUpdateOne", () => {
  // A loaded two-level tree so we can patch both a root and a nested node.
  const buildTree = (): SpaceTreeNode[] => [
    node("root", {
      position: "a0",
      name: "Root",
      icon: "📁",
      hasChildren: true,
      children: [node("child", { position: "a1", parentPageId: "root", name: "Child", icon: "📄" })],
    }),
  ];

  // Build the UpdateEvent envelope; only `id`/`payload` matter to the reducer.
  const ev = (id: string, payload: Record<string, unknown>) =>
    ({
      operation: "updateOne",
      spaceId: "space-1",
      entity: ["pages"],
      id,
      payload,
    }) as unknown as Parameters<typeof applyUpdateOne>[1];

  it("applies a title-only update to the node's name (icon untouched)", () => {
    const tree = buildTree();
    const next = applyUpdateOne(tree, ev("child", { title: "Renamed" }));
    const child = treeModel.find(next, "child");
    expect(child?.name).toBe("Renamed");
    // Icon is left as it was.
    expect(child?.icon).toBe("📄");
  });

  it("applies an icon-only update to the node's icon (name untouched)", () => {
    const tree = buildTree();
    const next = applyUpdateOne(tree, ev("root", { icon: "🔥" }));
    const root = treeModel.find(next, "root");
    expect(root?.icon).toBe("🔥");
    expect(root?.name).toBe("Root");
  });

  it("applies a combined title + icon update", () => {
    const tree = buildTree();
    const next = applyUpdateOne(tree, ev("child", { title: "Both", icon: "⭐" }));
    const child = treeModel.find(next, "child");
    expect(child?.name).toBe("Both");
    expect(child?.icon).toBe("⭐");
  });

  it("returns prev UNCHANGED (same reference) when the id is not loaded", () => {
    const tree = buildTree();
    const next = applyUpdateOne(tree, ev("ghost", { title: "Nope" }));
    expect(next).toBe(tree);
  });

  it("returns prev UNCHANGED (same reference) for a no-op payload (no title/icon)", () => {
    // The node exists, but the payload carries neither title nor icon -> nothing
    // to patch, so the reducer must hand back the same array reference.
    const tree = buildTree();
    const next = applyUpdateOne(tree, ev("child", {}));
    expect(next).toBe(tree);
  });

  it("treats an explicit null icon/title as a value to apply (undefined check, not truthiness)", () => {
    // The reducer guards on `!== undefined`, so a clearing null IS applied.
    const tree = buildTree();
    const next = applyUpdateOne(tree, ev("child", { title: "", icon: null }));
    const child = treeModel.find(next, "child");
    expect(child?.name).toBe("");
    expect(child?.icon).toBeNull();
    // And it did change something -> a fresh reference, not prev.
    expect(next).not.toBe(tree);
  });
});
