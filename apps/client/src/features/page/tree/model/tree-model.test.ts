import { describe, it, expect } from "vitest";
import { treeModel } from "./tree-model";
import type { TreeNode } from "./tree-model.types";

type N = TreeNode<{ name: string }>;

const fixture: N[] = [
  {
    id: "a",
    name: "A",
    children: [
      { id: "a1", name: "A1", children: [{ id: "a1a", name: "A1a" }] },
      { id: "a2", name: "A2" },
    ],
  },
  { id: "b", name: "B" },
];

describe("treeModel.find", () => {
  it("finds a root node", () => {
    expect(treeModel.find(fixture, "a")?.name).toBe("A");
  });
  it("finds a deeply nested node", () => {
    expect(treeModel.find(fixture, "a1a")?.name).toBe("A1a");
  });
  it("returns null for unknown id", () => {
    expect(treeModel.find(fixture, "zzz")).toBeNull();
  });
});

describe("treeModel.path", () => {
  it("returns root-to-leaf path for nested id", () => {
    const p = treeModel.path(fixture, "a1a");
    expect(p?.map((n) => n.id)).toEqual(["a", "a1", "a1a"]);
  });
  it("returns [node] for root-level id", () => {
    expect(treeModel.path(fixture, "b")?.map((n) => n.id)).toEqual(["b"]);
  });
  it("returns null for unknown id", () => {
    expect(treeModel.path(fixture, "zzz")).toBeNull();
  });
});

describe("treeModel.siblingsOf", () => {
  it("returns siblings + parent + index for a child", () => {
    const info = treeModel.siblingsOf(fixture, "a2");
    expect(info?.parentId).toBe("a");
    expect(info?.siblings.map((n) => n.id)).toEqual(["a1", "a2"]);
    expect(info?.index).toBe(1);
  });
  it("returns parentId null + root siblings for a root id", () => {
    const info = treeModel.siblingsOf(fixture, "b");
    expect(info?.parentId).toBeNull();
    expect(info?.siblings.map((n) => n.id)).toEqual(["a", "b"]);
    expect(info?.index).toBe(1);
  });
  it("returns null for unknown id", () => {
    expect(treeModel.siblingsOf(fixture, "zzz")).toBeNull();
  });
});

describe("treeModel.isDescendant", () => {
  it("returns true when descendantId is nested under ancestorId", () => {
    expect(treeModel.isDescendant(fixture, "a", "a1a")).toBe(true);
  });
  it("returns false when ids are siblings", () => {
    expect(treeModel.isDescendant(fixture, "a1", "a2")).toBe(false);
  });
  it("returns false when ancestorId is the same as descendantId", () => {
    expect(treeModel.isDescendant(fixture, "a", "a")).toBe(false);
  });
  it("returns false for unknown ids", () => {
    expect(treeModel.isDescendant(fixture, "zzz", "a")).toBe(false);
  });
});

describe("treeModel.visible", () => {
  it("returns only root nodes when no openIds", () => {
    const v = treeModel.visible(fixture, new Set());
    expect(v.map((n) => n.id)).toEqual(["a", "b"]);
  });
  it("includes children of open ids in DFS order", () => {
    const v = treeModel.visible(fixture, new Set(["a"]));
    expect(v.map((n) => n.id)).toEqual(["a", "a1", "a2", "b"]);
  });
  it("recursively descends through chains of open ids", () => {
    const v = treeModel.visible(fixture, new Set(["a", "a1"]));
    expect(v.map((n) => n.id)).toEqual(["a", "a1", "a1a", "a2", "b"]);
  });
  it("ignores openIds that are not in the tree", () => {
    const v = treeModel.visible(fixture, new Set(["ghost"]));
    expect(v.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("treeModel.insert", () => {
  const leaf = (id: string): N => ({ id, name: id.toUpperCase() });

  it("inserts at end when index is undefined", () => {
    const t = treeModel.insert(fixture, "a", leaf("a3"));
    expect(treeModel.siblingsOf(t, "a3")?.siblings.map((n) => n.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
  });
  it("inserts at index 0", () => {
    const t = treeModel.insert(fixture, "a", leaf("a0"), 0);
    expect(treeModel.siblingsOf(t, "a0")?.siblings.map((n) => n.id)).toEqual([
      "a0",
      "a1",
      "a2",
    ]);
  });
  it("inserts in the middle", () => {
    const t = treeModel.insert(fixture, "a", leaf("a1half"), 1);
    expect(
      treeModel.siblingsOf(t, "a1half")?.siblings.map((n) => n.id),
    ).toEqual(["a1", "a1half", "a2"]);
  });
  it("inserts at root when parentId is null", () => {
    const t = treeModel.insert(fixture, null, leaf("c"));
    expect(t.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
  it("returns same array reference for unknown parentId", () => {
    const t = treeModel.insert(fixture, "ghost", leaf("zz"));
    expect(t).toBe(fixture);
  });
  it("initializes children array when parent had no children", () => {
    const t = treeModel.insert(fixture, "b", leaf("b1"));
    expect(treeModel.find(t, "b")?.children?.map((n) => n.id)).toEqual(["b1"]);
  });
});

describe("treeModel.insertByPosition", () => {
  // Server-authoritative broadcasts ship the node's fractional `position`; the
  // receiver inserts among already-loaded siblings ordered by `position`.
  type P = TreeNode<{ name: string; position?: string }>;

  const roots: P[] = [
    { id: "a", name: "A", position: "a0" },
    { id: "b", name: "B", position: "a2" },
    { id: "c", name: "C", position: "a4" },
  ];

  it("inserts a root node in position order (middle)", () => {
    const node: P = { id: "x", name: "X", position: "a3" };
    const t = treeModel.insertByPosition(roots, null, node);
    expect(t.map((n) => n.id)).toEqual(["a", "b", "x", "c"]);
  });

  it("inserts a root node at the front when its position sorts first", () => {
    const node: P = { id: "x", name: "X", position: "a-" };
    const t = treeModel.insertByPosition(roots, null, node);
    expect(t.map((n) => n.id)).toEqual(["x", "a", "b", "c"]);
  });

  it("appends a root node when its position sorts last", () => {
    const node: P = { id: "x", name: "X", position: "a9" };
    const t = treeModel.insertByPosition(roots, null, node);
    expect(t.map((n) => n.id)).toEqual(["a", "b", "c", "x"]);
  });

  it("produces the same order regardless of which siblings are loaded", () => {
    // Client 1 loaded all siblings; client 2 only loaded a subset. The inserted
    // node lands in a consistent relative position for both.
    const full: P[] = roots;
    const partial: P[] = [roots[0], roots[2]]; // a, c (b not loaded)
    const node: P = { id: "x", name: "X", position: "a3" };

    expect(
      treeModel.insertByPosition(full, null, node).map((n) => n.id),
    ).toEqual(["a", "b", "x", "c"]);
    expect(
      treeModel.insertByPosition(partial, null, node).map((n) => n.id),
    ).toEqual(["a", "x", "c"]);
  });

  it("inserts a child in position order under the parent", () => {
    const tree: P[] = [
      {
        id: "p",
        name: "P",
        position: "a0",
        children: [
          { id: "p1", name: "P1", position: "a0" },
          { id: "p2", name: "P2", position: "a2" },
        ],
      },
    ];
    const node: P = { id: "p15", name: "P1.5", position: "a1" };
    const t = treeModel.insertByPosition(tree, "p", node);
    expect(treeModel.find(t, "p")?.children?.map((n) => n.id)).toEqual([
      "p1",
      "p15",
      "p2",
    ]);
  });

  // #159 #1: inserting/moving a node under a parent whose children are NOT
  // loaded (`children === undefined`, e.g. a collapsed page) must NOT materialize
  // a partial `[node]` list — that would defeat the lazy-load gate and hide the
  // parent's other real children. The node is left to be lazy-loaded; only
  // `hasChildren` is flagged so the chevron appears.
  it("does NOT materialize a child under an UNLOADED parent (children undefined)", () => {
    type PH = TreeNode<{
      name: string;
      position?: string;
      hasChildren?: boolean;
    }>;
    const tree: PH[] = [
      { id: "p", name: "P", position: "a0", hasChildren: false }, // children: undefined
    ];
    const node: PH = { id: "x", name: "X", position: "a1" };
    const t = treeModel.insertByPosition(tree, "p", node);
    const parent = treeModel.find(t, "p");
    // The node was NOT inserted (children stay unloaded -> lazy-load fetches the
    // full set, including this node, on expand).
    expect(parent?.children).toBeUndefined();
    expect(treeModel.find(t, "x")).toBeNull();
    // ...but the chevron is enabled so the user can expand to load it.
    expect((parent as PH).hasChildren).toBe(true);
  });

  it("DOES insert under a LOADED-but-empty parent (children: [])", () => {
    type PH = TreeNode<{
      name: string;
      position?: string;
      hasChildren?: boolean;
    }>;
    const tree: PH[] = [
      { id: "p", name: "P", position: "a0", hasChildren: false, children: [] },
    ];
    const node: PH = { id: "x", name: "X", position: "a1" };
    const t = treeModel.insertByPosition(tree, "p", node);
    // A loaded (empty) child list is complete, so the node IS inserted.
    expect(treeModel.find(t, "p")?.children?.map((n) => n.id)).toEqual(["x"]);
  });

  it("appends when the new node has no position", () => {
    const node: P = { id: "x", name: "X" };
    const t = treeModel.insertByPosition(roots, null, node);
    expect(t.map((n) => n.id)).toEqual(["a", "b", "c", "x"]);
  });

  it("tie-break: a node whose position EQUALS a sibling lands deterministically (strict >)", () => {
    // The insertion index is the first sibling whose position sorts STRICTLY
    // after the new node's. An equal sibling is not strictly after, so it is
    // skipped — the new node lands immediately AFTER every equal-position
    // sibling and before the first strictly-greater one. This is deterministic:
    // a tie always resolves the same way on every client.
    const node: P = { id: "x", name: "X", position: "a2" }; // equals b's position
    const t = treeModel.insertByPosition(roots, null, node);
    expect(t.map((n) => n.id)).toEqual(["a", "b", "x", "c"]);
  });
});

// addTreeNode idempotency: the receiver early-returns when the node id already
// exists, so re-delivery (or the author's optimistic node) is never duplicated.
// This guards the find-then-skip contract insertByPosition relies on.
describe("addTreeNode idempotency (find-then-skip)", () => {
  type P = TreeNode<{ name: string; position?: string }>;

  const applyAddTreeNode = (tree: P[], node: P): P[] => {
    if (treeModel.find(tree, node.id)) return tree;
    return treeModel.insertByPosition(tree, null, node);
  };

  it("does not insert a duplicate when the id already exists", () => {
    const tree: P[] = [{ id: "a", name: "A", position: "a0" }];
    const node: P = { id: "a", name: "A again", position: "a5" };
    const t1 = applyAddTreeNode(tree, node);
    expect(t1).toBe(tree);
    expect(t1.map((n) => n.id)).toEqual(["a"]);
  });

  it("inserts once, then is a no-op on repeat delivery", () => {
    let tree: P[] = [{ id: "a", name: "A", position: "a0" }];
    const node: P = { id: "x", name: "X", position: "a5" };
    tree = applyAddTreeNode(tree, node);
    expect(tree.map((n) => n.id)).toEqual(["a", "x"]);
    const again = applyAddTreeNode(tree, node);
    expect(again).toBe(tree);
    expect(again.filter((n) => n.id === "x")).toHaveLength(1);
  });
});

// handleCreate optimistic-insert idempotency: the author's optimistic insert is
// now guarded by `treeModel.find` (same contract as the addTreeNode socket
// handler) because the server's broadcast can win the race and insert the node
// first. Whichever runs first inserts; the second is a no-op. Exactly one row.
describe("handleCreate optimistic-insert idempotency (find-then-skip)", () => {
  // Mirrors the guarded optimistic insert in use-tree-mutation handleCreate.
  const applyOptimisticInsert = (
    tree: N[],
    parentId: string | null,
    node: N,
    index: number,
  ): N[] => {
    if (treeModel.find(tree, node.id)) return tree;
    return treeModel.insert(tree, parentId, node, index);
  };

  // Mirrors the addTreeNode socket handler guard.
  const applyAddTreeNode = (
    tree: N[],
    parentId: string | null,
    node: N,
  ): N[] => {
    if (treeModel.find(tree, node.id)) return tree;
    return treeModel.insert(tree, parentId, node);
  };

  const created: N = { id: "new", name: "" };

  it("optimistic insert is a no-op when server addTreeNode already inserted it", () => {
    // Reverse-of-reverse race: server wins.
    const afterServer = applyAddTreeNode(fixture, null, created);
    expect(afterServer.filter((n) => n.id === "new")).toHaveLength(1);
    const afterOptimistic = applyOptimisticInsert(
      afterServer,
      null,
      created,
      afterServer.length,
    );
    expect(afterOptimistic).toBe(afterServer); // skipped
    expect(afterOptimistic.filter((n) => n.id === "new")).toHaveLength(1);
  });

  it("server addTreeNode is a no-op when optimistic insert already ran (optimistic-first)", () => {
    const afterOptimistic = applyOptimisticInsert(
      fixture,
      null,
      created,
      fixture.length,
    );
    expect(afterOptimistic.filter((n) => n.id === "new")).toHaveLength(1);
    const afterServer = applyAddTreeNode(afterOptimistic, null, created);
    expect(afterServer).toBe(afterOptimistic); // skipped
    expect(afterServer.filter((n) => n.id === "new")).toHaveLength(1);
  });

  it("inserts exactly once when only the optimistic path runs", () => {
    const t = applyOptimisticInsert(fixture, "a", { id: "a3", name: "" }, 2);
    expect(
      treeModel.find(t, "a")?.children?.filter((n) => n.id === "a3"),
    ).toHaveLength(1);
  });
});

// moveTreeNode socket-handler semantics: the receiver must place the moved node
// by `position` (NOT index 0) and apply the `pageData` the payload carries so a
// moved node's title/icon/chevron stay correct. This mirrors the reducer in
// use-tree-socket.ts so the contract is unit-tested without rendering the hook.
describe("moveTreeNode handler (place by position + apply pageData)", () => {
  type P = TreeNode<{
    name: string;
    position?: string;
    icon?: string;
    hasChildren?: boolean;
    parentPageId?: string | null;
  }>;

  const applyMoveTreeNode = (
    tree: P[],
    payload: {
      id: string;
      parentId: string | null;
      position: string;
      pageData?: {
        title?: string | null;
        icon?: string | null;
        hasChildren?: boolean;
      };
    },
  ): P[] => {
    if (!treeModel.find(tree, payload.id)) return tree;
    const placed = treeModel.placeByPosition(tree, payload.id, {
      parentId: payload.parentId,
      position: payload.position,
    });
    if (placed === tree) return treeModel.remove(tree, payload.id);
    const patch: Partial<P> = {
      position: payload.position,
      parentPageId: payload.parentId,
    } as Partial<P>;
    const pd = payload.pageData;
    if (pd) {
      if (pd.title !== undefined)
        (patch as { name?: string }).name = pd.title ?? "";
      if (pd.icon !== undefined)
        (patch as { icon?: string }).icon = pd.icon ?? undefined;
      if (pd.hasChildren !== undefined)
        (patch as { hasChildren?: boolean }).hasChildren = pd.hasChildren;
    }
    return treeModel.update(placed, payload.id, patch);
  };

  const tree: P[] = [
    {
      id: "dst",
      name: "DST",
      position: "a0",
      children: [
        { id: "c1", name: "C1", position: "a1" },
        { id: "c2", name: "C2", position: "a3" },
        { id: "c3", name: "C3", position: "a5" },
      ],
    },
    { id: "src", name: "SRC", position: "a9" },
  ];

  it("lands the moved node in the correct MIDDLE slot, not at index 0", () => {
    const t = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "dst",
      position: "a4",
    });
    expect(treeModel.find(t, "dst")?.children?.map((n) => n.id)).toEqual([
      "c1",
      "c2",
      "src",
      "c3",
    ]);
  });

  it("lands the moved node at the END when position sorts last", () => {
    const t = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "dst",
      position: "a8",
    });
    expect(treeModel.find(t, "dst")?.children?.map((n) => n.id)).toEqual([
      "c1",
      "c2",
      "c3",
      "src",
    ]);
  });

  it("applies pageData (title/icon/hasChildren) to the moved node", () => {
    const t = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "dst",
      position: "a4",
      pageData: { title: "Renamed", icon: "🔥", hasChildren: true },
    });
    const moved = treeModel.find(t, "src");
    expect(moved?.name).toBe("Renamed");
    expect(moved?.icon).toBe("🔥");
    expect(moved?.hasChildren).toBe(true);
    expect(moved?.position).toBe("a4");
  });

  it("falls back to removing the node when the destination parent is not loaded", () => {
    const t = applyMoveTreeNode(tree, {
      id: "src",
      parentId: "not-loaded",
      position: "a4",
    });
    expect(treeModel.find(t, "src")).toBeNull();
  });
});

describe("treeModel.remove", () => {
  it("removes a leaf", () => {
    const t = treeModel.remove(fixture, "a2");
    expect(treeModel.find(t, "a2")).toBeNull();
  });
  it("removes a subtree", () => {
    const t = treeModel.remove(fixture, "a1");
    expect(treeModel.find(t, "a1")).toBeNull();
    expect(treeModel.find(t, "a1a")).toBeNull();
  });
  it("removes a root node", () => {
    const t = treeModel.remove(fixture, "b");
    expect(t.map((n) => n.id)).toEqual(["a"]);
  });
  it("returns same array reference for unknown id", () => {
    expect(treeModel.remove(fixture, "ghost")).toBe(fixture);
  });
});

describe("treeModel.update", () => {
  it("shallow-merges a patch on the matching node", () => {
    const t = treeModel.update(fixture, "a1", { name: "A1-renamed" });
    expect(treeModel.find(t, "a1")?.name).toBe("A1-renamed");
  });
  it("returns same array reference for unknown id", () => {
    expect(treeModel.update(fixture, "ghost", { name: "x" })).toBe(fixture);
  });
  it("preserves children when patching parent's own fields", () => {
    const t = treeModel.update(fixture, "a", { name: "A-renamed" });
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual([
      "a1",
      "a2",
    ]);
  });
  it("preserves reference identity of unrelated subtrees", () => {
    const t = treeModel.update(fixture, "a1", { name: "X" });
    expect(t[1]).toBe(fixture[1]);
  });
});

describe("treeModel.appendChildren", () => {
  const kid = (id: string): N => ({ id, name: id });

  it("appends to existing children", () => {
    const t = treeModel.appendChildren(fixture, "a", [kid("a3"), kid("a4")]);
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
  });
  it("initializes children when parent had none", () => {
    const t = treeModel.appendChildren(fixture, "b", [kid("b1")]);
    expect(treeModel.find(t, "b")?.children?.map((n) => n.id)).toEqual(["b1"]);
  });
  it("returns same array reference for unknown parentId", () => {
    expect(treeModel.appendChildren(fixture, "ghost", [kid("zz")])).toBe(
      fixture,
    );
  });

  // Regression: lazy-load + auto-expand can race and call appendChildren with
  // children that overlap what's already there. React then crashes on duplicate
  // keys. Defensive dedup at the model level.
  it("dedups against existing children by id", () => {
    const t1 = treeModel.appendChildren(fixture, "a", [kid("a3"), kid("a4")]);
    const t2 = treeModel.appendChildren(t1, "a", [
      kid("a3"),
      kid("a4"),
      kid("a5"),
    ]);
    expect(treeModel.find(t2, "a")?.children?.map((n) => n.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
  });

  it("returns same array reference when every child is a duplicate", () => {
    const t1 = treeModel.appendChildren(fixture, "a", [kid("a3")]);
    const t2 = treeModel.appendChildren(t1, "a", [kid("a3")]);
    expect(t2).toBe(t1);
  });
});

describe("treeModel.place", () => {
  it("moves a node to a new parent at a given index", () => {
    const t = treeModel.place(fixture, "a2", { parentId: "b", index: 0 });
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual(["a1"]);
    expect(treeModel.find(t, "b")?.children?.map((n) => n.id)).toEqual(["a2"]);
  });
  it("moves a node to root", () => {
    const t = treeModel.place(fixture, "a1", { parentId: null, index: 0 });
    expect(t.map((n) => n.id)).toEqual(["a1", "a", "b"]);
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual(["a2"]);
  });
  it("reorders within the same parent", () => {
    const t = treeModel.place(fixture, "a2", { parentId: "a", index: 0 });
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual([
      "a2",
      "a1",
    ]);
  });
  it("returns same array reference for unknown source", () => {
    expect(treeModel.place(fixture, "ghost", { parentId: "a", index: 0 })).toBe(
      fixture,
    );
  });
  it("returns same array reference for unknown destination parent", () => {
    expect(
      treeModel.place(fixture, "a1", { parentId: "ghost", index: 0 }),
    ).toBe(fixture);
  });
});

describe("treeModel.placeByPosition", () => {
  // Server-authoritative `moveTreeNode` ships the moved node's fractional
  // `position`; the receiver must sort it into the correct slot among the new
  // siblings — NOT drop it at index 0.
  type P = TreeNode<{ name: string; position?: string }>;

  const tree: P[] = [
    {
      id: "dst",
      name: "DST",
      position: "a0",
      children: [
        { id: "c1", name: "C1", position: "a1" },
        { id: "c2", name: "C2", position: "a3" },
        { id: "c3", name: "C3", position: "a5" },
      ],
    },
    { id: "src", name: "SRC", position: "a9" },
  ];

  it("places the moved node in the MIDDLE of new siblings by position", () => {
    const t = treeModel.placeByPosition(tree, "src", {
      parentId: "dst",
      position: "a4",
    });
    expect(treeModel.find(t, "dst")?.children?.map((n) => n.id)).toEqual([
      "c1",
      "c2",
      "src",
      "c3",
    ]);
  });

  it("places the moved node at the END when its position sorts last", () => {
    const t = treeModel.placeByPosition(tree, "src", {
      parentId: "dst",
      position: "a8",
    });
    expect(treeModel.find(t, "dst")?.children?.map((n) => n.id)).toEqual([
      "c1",
      "c2",
      "c3",
      "src",
    ]);
  });

  it("places the moved node at the FRONT only when its position sorts first", () => {
    const t = treeModel.placeByPosition(tree, "src", {
      parentId: "dst",
      position: "a0",
    });
    expect(treeModel.find(t, "dst")?.children?.map((n) => n.id)).toEqual([
      "src",
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("stamps the authoritative position onto the moved node", () => {
    const t = treeModel.placeByPosition(tree, "src", {
      parentId: "dst",
      position: "a4",
    });
    expect(treeModel.find(t, "src")?.position).toBe("a4");
  });

  it("reorders within the same parent by position (not to index 0)", () => {
    const same: P[] = [
      {
        id: "p",
        name: "P",
        position: "a0",
        children: [
          { id: "x", name: "X", position: "a1" },
          { id: "y", name: "Y", position: "a2" },
          { id: "z", name: "Z", position: "a3" },
        ],
      },
    ];
    // Move x to between y and z.
    const t = treeModel.placeByPosition(same, "x", {
      parentId: "p",
      position: "a25",
    });
    expect(treeModel.find(t, "p")?.children?.map((n) => n.id)).toEqual([
      "y",
      "x",
      "z",
    ]);
  });

  it("returns same array reference for unknown source", () => {
    expect(
      treeModel.placeByPosition(tree, "ghost", {
        parentId: "dst",
        position: "a4",
      }),
    ).toBe(tree);
  });

  it("returns same array reference when destination parent is not loaded", () => {
    expect(
      treeModel.placeByPosition(tree, "src", {
        parentId: "ghost",
        position: "a4",
      }),
    ).toBe(tree);
  });

  it("moves a node to root by position", () => {
    const roots: P[] = [
      { id: "r1", name: "R1", position: "a1" },
      { id: "r2", name: "R2", position: "a5" },
      {
        id: "rp",
        name: "RP",
        position: "a7",
        children: [{ id: "child", name: "CHILD", position: "a1" }],
      },
    ];
    const t = treeModel.placeByPosition(roots, "child", {
      parentId: null,
      position: "a3",
    });
    expect(t.map((n) => n.id)).toEqual(["r1", "child", "r2", "rp"]);
  });
});

describe("treeModel.move", () => {
  it("reorder-before within same parent: moves source to target index", () => {
    const { tree: t, result } = treeModel.move(fixture, "a2", {
      kind: "reorder-before",
      targetId: "a1",
    });
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual([
      "a2",
      "a1",
    ]);
    expect(result).toEqual({ parentId: "a", index: 0 });
  });
  it("reorder-after within same parent", () => {
    const { tree: t, result } = treeModel.move(fixture, "a1", {
      kind: "reorder-after",
      targetId: "a2",
    });
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual([
      "a2",
      "a1",
    ]);
    expect(result).toEqual({ parentId: "a", index: 1 });
  });
  it("make-child appends at end of target children", () => {
    const { tree: t, result } = treeModel.move(fixture, "b", {
      kind: "make-child",
      targetId: "a",
    });
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual([
      "a1",
      "a2",
      "b",
    ]);
    expect(result).toEqual({ parentId: "a", index: 2 });
  });
  it("make-child initializes children when target had none", () => {
    const { tree: t, result } = treeModel.move(fixture, "a2", {
      kind: "make-child",
      targetId: "b",
    });
    expect(treeModel.find(t, "b")?.children?.map((n) => n.id)).toEqual(["a2"]);
    expect(result).toEqual({ parentId: "b", index: 0 });
  });
  it("reorder-before across parents", () => {
    const { tree: t, result } = treeModel.move(fixture, "b", {
      kind: "reorder-before",
      targetId: "a1",
    });
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual([
      "b",
      "a1",
      "a2",
    ]);
    expect(result).toEqual({ parentId: "a", index: 0 });
  });
  it("reorder-after to root", () => {
    const { tree: t, result } = treeModel.move(fixture, "a1", {
      kind: "reorder-after",
      targetId: "a",
    });
    expect(t.map((n) => n.id)).toEqual(["a", "a1", "b"]);
    expect(treeModel.find(t, "a")?.children?.map((n) => n.id)).toEqual(["a2"]);
    expect(result).toEqual({ parentId: null, index: 1 });
  });
  it("no-op when sourceId === targetId", () => {
    const out = treeModel.move(fixture, "a", {
      kind: "make-child",
      targetId: "a",
    });
    expect(out.tree).toBe(fixture);
  });
  it("no-op when target is descendant of source", () => {
    const out = treeModel.move(fixture, "a", {
      kind: "make-child",
      targetId: "a1a",
    });
    expect(out.tree).toBe(fixture);
  });
  it("no-op when source is unknown", () => {
    const out = treeModel.move(fixture, "ghost", {
      kind: "reorder-before",
      targetId: "a",
    });
    expect(out.tree).toBe(fixture);
  });
  it("no-op when target is unknown", () => {
    const out = treeModel.move(fixture, "a1", {
      kind: "reorder-before",
      targetId: "ghost",
    });
    expect(out.tree).toBe(fixture);
  });

  it("cross-parent move does NOT apply the same-parent adjust (no off-by-one)", () => {
    // Source `x3` sits at index 2 in parent `x`; target `y1` sits at index 0 in
    // parent `y`. sourceInfo.index (2) > info.index (0) AND the parents differ,
    // so the `sameParent && source.index < info.index` adjust must be 0 — the
    // node must land at index 0 in `y`, not at index -1 (which would silently
    // drop it at a wrong slot / off-by-one).
    const crossFixture: N[] = [
      {
        id: "x",
        name: "X",
        children: [
          { id: "x1", name: "X1" },
          { id: "x2", name: "X2" },
          { id: "x3", name: "X3" },
        ],
      },
      {
        id: "y",
        name: "Y",
        children: [
          { id: "y1", name: "Y1" },
          { id: "y2", name: "Y2" },
        ],
      },
    ];
    const { tree: t, result } = treeModel.move(crossFixture, "x3", {
      kind: "reorder-before",
      targetId: "y1",
    });
    expect(result).toEqual({ parentId: "y", index: 0 });
    expect(treeModel.find(t, "y")?.children?.map((n) => n.id)).toEqual([
      "x3",
      "y1",
      "y2",
    ]);
    expect(treeModel.find(t, "x")?.children?.map((n) => n.id)).toEqual([
      "x1",
      "x2",
    ]);
  });
});
