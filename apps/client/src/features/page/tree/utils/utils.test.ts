import { describe, it, expect } from "vitest";
import {
  buildTree,
  buildTreeWithChildren,
  collectAllIds,
  collectBranchIds,
  openBranches,
  closeIds,
  mergeRootTrees,
  loadedOpenBranchIds,
  sortPositionKeys,
  pageToTreeNode,
} from "./utils";
import type { IPage } from "@/features/page/types/page.types.ts";
import type { SpaceTreeNode } from "@/features/page/tree/types.ts";

function page(id: string, position: string): IPage {
  return {
    id,
    slugId: `slug-${id}`,
    title: id.toUpperCase(),
    icon: "",
    position,
    hasChildren: false,
    spaceId: "space-1",
    parentPageId: null as unknown as string,
  } as IPage;
}

// Flat SpaceTreeNode factory for buildTreeWithChildren (it consumes a flat list
// with parentPageId pointers and nests them).
function flatNode(
  id: string,
  parentPageId: string | null,
  position: string,
): SpaceTreeNode {
  return {
    id,
    slugId: `slug-${id}`,
    name: id.toUpperCase(),
    icon: undefined,
    position,
    spaceId: "space-1",
    parentPageId: parentPageId as unknown as string,
    hasChildren: false,
    children: [],
  };
}

// Nested SpaceTreeNode factory for collectAllIds / collectBranchIds.
function treeNode(id: string, children: SpaceTreeNode[] = []): SpaceTreeNode {
  return {
    id,
    slugId: `slug-${id}`,
    name: id.toUpperCase(),
    icon: undefined,
    position: "a0",
    spaceId: "space-1",
    parentPageId: null as unknown as string,
    hasChildren: children.length > 0,
    children,
  };
}

describe("sortPositionKeys", () => {
  it("orders items ascending by their fractional `position` string", () => {
    const items = [
      { id: "c", position: "a5" },
      { id: "a", position: "a1" },
      { id: "b", position: "a3" },
    ];
    expect(sortPositionKeys(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("is a stable sort: equal positions keep their input order", () => {
    const items = [
      { id: "x", position: "a1" },
      { id: "y", position: "a1" },
      { id: "z", position: "a1" },
    ];
    expect(sortPositionKeys(items).map((i) => i.id)).toEqual(["x", "y", "z"]);
  });
});

describe("pageToTreeNode", () => {
  function pageRow(over: Partial<IPage> = {}): IPage {
    return {
      id: "p1",
      slugId: "slug-p1",
      title: "My Page",
      icon: "📄",
      position: "a1",
      hasChildren: true,
      spaceId: "space-1",
      parentPageId: null as unknown as string,
      ...over,
    } as IPage;
  }

  it("maps page.title -> node.name and copies the core fields", () => {
    const node = pageToTreeNode(pageRow());
    // The non-trivial transform: a page's `title` becomes the tree node's `name`.
    expect(node.name).toBe("My Page");
    expect(node.id).toBe("p1");
    expect(node.slugId).toBe("slug-p1");
    expect(node.icon).toBe("📄");
    expect(node.position).toBe("a1");
    expect(node.spaceId).toBe("space-1");
    expect(node.hasChildren).toBe(true);
    // Always materialized with an empty children array.
    expect(node.children).toEqual([]);
  });

  it("derives canEdit from page.permissions.canEdit when the flat field is absent", () => {
    const node = pageToTreeNode(
      pageRow({ canEdit: undefined, permissions: { canEdit: true } } as Partial<IPage>),
    );
    expect(node.canEdit).toBe(true);
  });

  it("prefers the flat page.canEdit over permissions.canEdit", () => {
    const node = pageToTreeNode(
      pageRow({ canEdit: false, permissions: { canEdit: true } } as Partial<IPage>),
    );
    expect(node.canEdit).toBe(false);
  });

  it("carries temporaryExpiresAt straight off the page", () => {
    const expiresAt = "2026-06-27T21:00:00.000Z";
    expect(pageToTreeNode(pageRow({ temporaryExpiresAt: expiresAt })).temporaryExpiresAt).toBe(
      expiresAt,
    );
  });

  it("applies overrides on top of the mapped fields (e.g. optimistic blank name)", () => {
    const node = pageToTreeNode(pageRow(), { name: "" });
    expect(node.name).toBe("");
  });
});

describe("buildTree", () => {
  it("builds one node per unique page", () => {
    const tree = buildTree([page("a", "a1"), page("b", "a2")]);
    expect(tree.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("dedups a duplicate id so the tree has no duplicate node", () => {
    // A realtime cache write could append a page twice; buildTree must not emit
    // two references to the same node (which would crash the sidebar render with
    // a duplicate React key).
    const tree = buildTree([
      page("a", "a1"),
      page("b", "a2"),
      page("a", "a1"), // duplicate id
    ]);

    expect(tree).toHaveLength(2);
    expect(tree.map((n) => n.id).sort()).toEqual(["a", "b"]);
    // No id appears more than once.
    const ids = tree.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("collectBranchIds", () => {
  it("returns every node-with-children id in a multi-level tree", () => {
    const tree = [
      treeNode("root", [
        treeNode("branch1", [treeNode("leaf1")]),
        treeNode("leaf2"),
      ]),
      treeNode("root2", [treeNode("leaf3")]),
    ];
    expect(collectBranchIds(tree).sort()).toEqual(["branch1", "root", "root2"]);
  });

  it("returns [] for a leaf-only tree", () => {
    const tree = [treeNode("a"), treeNode("b"), treeNode("c")];
    expect(collectBranchIds(tree)).toEqual([]);
  });

  it("does NOT include a node whose children is an empty array", () => {
    // hasChildren-less / empty-children nodes are leaves for expansion purposes.
    const tree = [treeNode("a", [])];
    expect(collectBranchIds(tree)).toEqual([]);
  });

  it("returns every ancestor id in a deep single chain", () => {
    const chain = treeNode("a", [
      treeNode("b", [treeNode("c", [treeNode("d")])]),
    ]);
    // a, b, c are branches; d is the leaf.
    expect(collectBranchIds([chain])).toEqual(["a", "b", "c"]);
  });

  it("returns [] for an empty tree", () => {
    expect(collectBranchIds([])).toEqual([]);
  });
});

describe("collectAllIds", () => {
  it("returns every id (roots, branches, leaves)", () => {
    const tree = [
      treeNode("root", [
        treeNode("branch1", [treeNode("leaf1")]),
        treeNode("leaf2"),
      ]),
      treeNode("root2"),
    ];
    expect(collectAllIds(tree).sort()).toEqual([
      "branch1",
      "leaf1",
      "leaf2",
      "root",
      "root2",
    ]);
  });

  it("returns every id in a deep chain", () => {
    const chain = treeNode("a", [
      treeNode("b", [treeNode("c", [treeNode("d")])]),
    ]);
    expect(collectAllIds([chain])).toEqual(["a", "b", "c", "d"]);
  });

  it("returns [] for an empty tree", () => {
    expect(collectAllIds([])).toEqual([]);
  });

  it("is a superset of collectBranchIds for the same tree (property)", () => {
    const tree = [
      treeNode("root", [
        treeNode("branch1", [treeNode("leaf1"), treeNode("leaf2")]),
        treeNode("branch2", [treeNode("leaf3")]),
        treeNode("leaf4"),
      ]),
      treeNode("root2", [treeNode("leaf5")]),
    ];
    const all = new Set(collectAllIds(tree));
    const branches = collectBranchIds(tree);
    for (const id of branches) {
      expect(all.has(id)).toBe(true);
    }
    // And the superset is strictly larger (it also has the leaves).
    expect(all.size).toBeGreaterThan(branches.length);
  });
});

describe("buildTreeWithChildren", () => {
  it("nests a flat list and sorts siblings by position", () => {
    // Provided out of position order to prove the sort.
    const flat = [
      flatNode("root", null, "a0"),
      flatNode("c2", "root", "a4"),
      flatNode("c1", "root", "a1"),
    ];
    const tree = buildTreeWithChildren(flat);
    expect(tree.map((n) => n.id)).toEqual(["root"]);
    expect(tree[0].children.map((n) => n.id)).toEqual(["c1", "c2"]);
  });

  it("recomputes hasChildren to true for nodes that gain children", () => {
    // Parent ships with hasChildren=false; building must flip it true.
    const flat = [
      flatNode("root", null, "a0"),
      flatNode("child", "root", "a1"),
    ];
    expect(flat[0].hasChildren).toBe(false);
    const tree = buildTreeWithChildren(flat);
    expect(tree[0].hasChildren).toBe(true);
  });

  it("treats a node whose parentPageId is ABSENT from the list as a root (no crash)", () => {
    // Permission-trimmed response: `orphan`'s parent `missing` was filtered out
    // server-side. The function must not throw and must surface the orphan as a
    // root rather than dropping or crashing on it.
    const flat = [
      flatNode("root", null, "a0"),
      flatNode("orphan", "missing", "a2"),
    ];
    let tree: SpaceTreeNode[] = [];
    expect(() => {
      tree = buildTreeWithChildren(flat);
    }).not.toThrow();
    expect(tree.map((n) => n.id).sort()).toEqual(["orphan", "root"]);
  });
});

describe("openBranches", () => {
  it("sets all given ids to true", () => {
    const next = openBranches({}, ["a", "b", "c"]);
    expect(next).toEqual({ a: true, b: true, c: true });
  });

  it("preserves pre-existing open ids and other-space ids", () => {
    const prev = { existing: true, "other-space": true, closed: false };
    const next = openBranches(prev, ["a"]);
    expect(next).toEqual({
      existing: true,
      "other-space": true,
      closed: false,
      a: true,
    });
  });

  it("does not mutate the input map", () => {
    const prev = { a: false };
    const next = openBranches(prev, ["a"]);
    expect(prev).toEqual({ a: false });
    expect(next).not.toBe(prev);
  });

  it("is idempotent", () => {
    const once = openBranches({ z: true }, ["a", "b"]);
    const twice = openBranches(once, ["a", "b"]);
    expect(twice).toEqual(once);
  });
});

describe("closeIds", () => {
  it("flips current-space ids to false while leaving OTHER-space ids untouched", () => {
    const prev = {
      "current-1": true,
      "current-2": true,
      "other-space": true,
    };
    const next = closeIds(prev, ["current-1", "current-2"]);
    expect(next).toEqual({
      "current-1": false,
      "current-2": false,
      "other-space": true, // untouched
    });
  });

  it("does not mutate the input map", () => {
    const prev = { a: true };
    const next = closeIds(prev, ["a"]);
    expect(prev).toEqual({ a: true });
    expect(next).not.toBe(prev);
  });

  it("is idempotent", () => {
    const once = closeIds({ keep: true }, ["a", "b"]);
    const twice = closeIds(once, ["a", "b"]);
    expect(twice).toEqual(once);
    expect(twice).toEqual({ keep: true, a: false, b: false });
  });
});

describe("mergeRootTrees (#159 #2 reconnect reconcile)", () => {
  // Root node with a position and optional already-loaded children.
  function root(
    id: string,
    position: string,
    children?: SpaceTreeNode[],
  ): SpaceTreeNode {
    return {
      id,
      slugId: `slug-${id}`,
      name: id.toUpperCase(),
      icon: undefined,
      position,
      spaceId: "space-1",
      parentPageId: null as unknown as string,
      hasChildren: !!children?.length,
      children: children as SpaceTreeNode[],
    };
  }

  it("DROPS a stale root that is absent from the incoming (authoritative) set", () => {
    // 'ghost' was a root before the gap; the server's current roots no longer
    // include it (deleted / moved under another page). It must not linger.
    const prev = [root("a", "a0"), root("ghost", "a2"), root("b", "a4")];
    const incoming = [root("a", "a0"), root("b", "a4")];
    const merged = mergeRootTrees(prev, incoming);
    expect(merged.map((n) => n.id)).toEqual(["a", "b"]);
    expect(merged.find((n) => n.id === "ghost")).toBeUndefined();
  });

  it("PRESERVES a surviving root's lazy-loaded children (subtree not lost on refetch)", () => {
    const loadedChild = root("a1", "a0");
    const prev = [root("a", "a0", [loadedChild])];
    // The root query returns only top-level roots (no children).
    const incoming = [root("a", "a0")];
    const merged = mergeRootTrees(prev, incoming);
    expect(merged[0].children?.map((c) => c.id)).toEqual(["a1"]);
  });

  it("ADDS a new incoming root", () => {
    const prev = [root("a", "a0")];
    const incoming = [root("a", "a0"), root("new", "a2")];
    const merged = mergeRootTrees(prev, incoming);
    expect(merged.map((n) => n.id)).toEqual(["a", "new"]);
  });

  it("REFRESHES a surviving root's own fields from the incoming copy (e.g. rename)", () => {
    const prev = [{ ...root("a", "a0"), name: "OLD" }];
    const incoming = [{ ...root("a", "a0"), name: "NEW" }];
    const merged = mergeRootTrees(prev, incoming);
    expect(merged[0].name).toBe("NEW");
  });
});

describe("loadedOpenBranchIds (#159 #8 reconnect refresh targets)", () => {
  function n(id: string, children?: SpaceTreeNode[]): SpaceTreeNode {
    return {
      id,
      slugId: `slug-${id}`,
      name: id.toUpperCase(),
      icon: undefined,
      position: "a0",
      spaceId: "space-1",
      parentPageId: null as unknown as string,
      hasChildren: !!children,
      children: children as SpaceTreeNode[],
    };
  }

  it("returns OPEN branches whose children are loaded (array)", () => {
    const tree = [n("a", [n("a1")]), n("b", [n("b1")])];
    const ids = loadedOpenBranchIds(tree, new Set(["a"]));
    expect(ids).toEqual(["a"]); // b is closed; a is open+loaded
  });

  it("skips an open branch whose children are NOT loaded (undefined)", () => {
    const tree = [n("a")]; // children undefined
    expect(loadedOpenBranchIds(tree, new Set(["a"]))).toEqual([]);
  });

  it("includes a loaded-but-empty open branch (a child may have been added during the gap)", () => {
    const tree = [n("a", [])];
    expect(loadedOpenBranchIds(tree, new Set(["a"]))).toEqual(["a"]);
  });

  it("walks nested open+loaded branches (deep chain refreshes every level)", () => {
    const tree = [n("a", [n("a1", [n("a1a")])])];
    const ids = loadedOpenBranchIds(tree, new Set(["a", "a1"]));
    expect(ids.sort()).toEqual(["a", "a1"]);
  });
});
