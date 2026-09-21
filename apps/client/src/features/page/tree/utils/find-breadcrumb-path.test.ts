import { describe, it, expect } from "vitest";
import { findBreadcrumbPath } from "./utils";
import type { SpaceTreeNode } from "@/features/page/tree/types.ts";

// findBreadcrumbPath walks the live, SHARED sidebar tree. The high-value
// invariant: when a node has no usable name it must surface "Untitled" ONLY on
// the returned breadcrumb chain via a shallow copy — never by mutating the input
// node (which would silently rename the node in the sidebar). Also covers normal
// ancestor-chain resolution, the not-found case, and nested children.

function node(id: string, over: Partial<SpaceTreeNode> = {}): SpaceTreeNode {
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
    ...over,
  };
}

describe("findBreadcrumbPath", () => {
  it("does NOT mutate the input tree when a node has an empty/whitespace name", () => {
    // A whitespace-only-named node nested under a blank-named root.
    const target = node("target", { name: "   " });
    const root = node("root", { name: "", hasChildren: true, children: [target] });
    const tree = [root];

    const result = findBreadcrumbPath(tree, "target");

    expect(result).not.toBeNull();
    // The RETURNED chain shows "Untitled" for both blank nodes.
    expect(result!.map((n) => n.name)).toEqual(["Untitled", "Untitled"]);
    // The original input nodes are untouched (still blank).
    expect(root.name).toBe("");
    expect(target.name).toBe("   ");
    // The renamed breadcrumb entries are fresh copies, not the input objects.
    expect(result![0]).not.toBe(root);
    expect(result![1]).not.toBe(target);
  });

  it("returns the SAME node reference (no copy) when the name is non-empty", () => {
    // No rename needed -> the node is passed through by reference (cheap path).
    const target = node("target", { name: "Real Title" });
    const result = findBreadcrumbPath([target], "target");
    expect(result![0]).toBe(target);
    expect(result![0].name).toBe("Real Title");
  });

  it("resolves the full ancestor chain ending at the target", () => {
    const target = node("c");
    const mid = node("b", { hasChildren: true, children: [target] });
    const root = node("a", { hasChildren: true, children: [mid] });
    const result = findBreadcrumbPath([root], "c");
    expect(result!.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("finds a target nested under a deeper sibling branch", () => {
    // Two root branches; the target lives inside the second branch's child.
    const target = node("deep");
    const branch2 = node("r2", {
      hasChildren: true,
      children: [node("x"), node("y", { hasChildren: true, children: [target] })],
    });
    const branch1 = node("r1", { hasChildren: true, children: [node("z")] });
    const result = findBreadcrumbPath([branch1, branch2], "deep");
    expect(result!.map((n) => n.id)).toEqual(["r2", "y", "deep"]);
  });

  it("returns null when the page id is not present in the tree", () => {
    const root = node("root", { hasChildren: true, children: [node("child")] });
    expect(findBreadcrumbPath([root], "missing")).toBeNull();
    expect(findBreadcrumbPath([], "anything")).toBeNull();
  });
});
