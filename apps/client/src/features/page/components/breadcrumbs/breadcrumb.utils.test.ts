import { describe, it, expect } from "vitest";
import { resolveBreadcrumbNodes } from "./breadcrumb.utils";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { IPage } from "@/features/page/types/page.types.ts";

// Pure selection/mapping behind the breadcrumb (#218): tree-hit prefers the live
// sidebar tree, tree-miss maps the page's own ancestors, and "no data" returns
// null so the component keeps its prior state.

function treeNode(id: string, over?: Partial<SpaceTreeNode>): SpaceTreeNode {
  return {
    id,
    slugId: `slug-${id}`,
    name: `node-${id}`,
    icon: null,
    position: "a",
    hasChildren: false,
    spaceId: "space-1",
    parentPageId: null,
    children: [],
    ...over,
  } as SpaceTreeNode;
}

function ancestorPage(id: string, over?: Partial<IPage>): IPage {
  return {
    id,
    slugId: `slug-${id}`,
    title: `title-${id}`,
    icon: "📄",
    position: "m",
    spaceId: "space-1",
    parentPageId: null,
    hasChildren: true,
    ...over,
  } as IPage;
}

describe("resolveBreadcrumbNodes", () => {
  it("tree-hit: returns the path found in the live sidebar tree", () => {
    const child = treeNode("child");
    const root = treeNode("root", { hasChildren: true, children: [child] });
    // findBreadcrumbPath walks the tree; the chain ends at the target page.
    const result = resolveBreadcrumbNodes([root], [ancestorPage("child")], "child");

    expect(result).not.toBeNull();
    expect(result!.map((n) => n.id)).toEqual(["root", "child"]);
    // Came from the tree, NOT the ancestor mapping (icon stays the tree's null).
    expect(result![result!.length - 1].icon).toBeNull();
  });

  it("tree-miss: maps the page's own ancestors (title->name, hasChildren default)", () => {
    // Tree has no node for the target page -> findBreadcrumbPath misses.
    const unrelated = treeNode("unrelated");
    const ancestors = [
      ancestorPage("a", { hasChildren: true }),
      ancestorPage("b", { hasChildren: undefined as any }),
    ];

    const result = resolveBreadcrumbNodes([unrelated], ancestors, "missing-page");

    expect(result).not.toBeNull();
    expect(result!.map((n) => n.id)).toEqual(["a", "b"]);
    // Non-trivial field transform: title -> name.
    expect(result![0].name).toBe("title-a");
    // hasChildren defaults to false when the ancestor row omits it.
    expect(result![1].hasChildren).toBe(false);
    expect(result![0].hasChildren).toBe(true);
  });

  it("falls back to ancestors when the tree is empty", () => {
    const result = resolveBreadcrumbNodes([], [ancestorPage("a")], "a");
    expect(result!.map((n) => n.id)).toEqual(["a"]);
  });

  it("returns null when there is no tree hit and no ancestor data", () => {
    expect(resolveBreadcrumbNodes([], [], "x")).toBeNull();
    expect(resolveBreadcrumbNodes(undefined, undefined, "x")).toBeNull();
    expect(resolveBreadcrumbNodes(null, null, "x")).toBeNull();
  });
});
