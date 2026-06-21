import { describe, it, expect } from "vitest";
import {
  buildSharedPageTree,
  isPageInTree,
  type SharedPageTreeNode,
} from "@/features/share/utils.ts";
import type { IPage } from "@/features/page/types/page.types.ts";

/**
 * `buildSharedPageTree` nests pages by `parentPageId` (keyed on `page.id`),
 * promotes orphans (parent absent) to top level, marks `hasChildren`, and sorts
 * siblings recursively by `position`. `isPageInTree` walks the tree matching on
 * `slugId`. We build minimal page records (only the fields the builder reads).
 */
function page(p: Partial<IPage> & { id: string }): IPage {
  return {
    id: p.id,
    slugId: p.slugId ?? `slug-${p.id}`,
    title: p.title ?? p.id,
    icon: p.icon ?? "",
    position: p.position ?? "a0",
    spaceId: p.spaceId ?? "space-1",
    parentPageId: p.parentPageId ?? (null as unknown as string),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("buildSharedPageTree — nesting & sorting", () => {
  it("nests children under their parent and sorts siblings by position", () => {
    const tree = buildSharedPageTree([
      page({ id: "root", slugId: "root-s", position: "a0" }),
      page({ id: "c2", slugId: "c2-s", parentPageId: "root", position: "a2" }),
      page({ id: "c1", slugId: "c1-s", parentPageId: "root", position: "a1" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root.slugId).toBe("root-s");
    expect(root.hasChildren).toBe(true);
    expect(root.children.map((c) => c.slugId)).toEqual(["c1-s", "c2-s"]);
  });

  it("sorts top-level siblings by position", () => {
    // Positions: a-s=a1, c-s=a2, b-s=a3 -> sorted order is a1, a2, a3.
    const tree = buildSharedPageTree([
      page({ id: "b", slugId: "b-s", position: "a3" }),
      page({ id: "a", slugId: "a-s", position: "a1" }),
      page({ id: "c", slugId: "c-s", position: "a2" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    expect(tree.map((n) => n.slugId)).toEqual(["a-s", "c-s", "b-s"]);
  });

  it("sorts recursively at depth", () => {
    const tree = buildSharedPageTree([
      page({ id: "root", slugId: "root-s", position: "a0" }),
      page({ id: "mid", slugId: "mid-s", parentPageId: "root", position: "a0" }),
      page({ id: "g2", slugId: "g2-s", parentPageId: "mid", position: "a5" }),
      page({ id: "g1", slugId: "g1-s", parentPageId: "mid", position: "a1" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    const mid = tree[0].children[0];
    expect(mid.slugId).toBe("mid-s");
    expect(mid.hasChildren).toBe(true);
    expect(mid.children.map((c) => c.slugId)).toEqual(["g1-s", "g2-s"]);
  });
});

describe("buildSharedPageTree — orphans & flags", () => {
  it("promotes a page whose parent is absent to a top-level node (no crash)", () => {
    const tree = buildSharedPageTree([
      page({ id: "x", slugId: "x-s", parentPageId: "missing-parent" }),
      page({ id: "y", slugId: "y-s" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    const slugs = tree.map((n) => n.slugId).sort();
    expect(slugs).toEqual(["x-s", "y-s"]);
  });

  it("leaves hasChildren false for leaf nodes", () => {
    const tree = buildSharedPageTree([
      page({ id: "leaf", slugId: "leaf-s" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    expect(tree[0].hasChildren).toBe(false);
    expect(tree[0].children).toEqual([]);
  });

  it("uses 'untitled' as the label for an empty title", () => {
    const tree = buildSharedPageTree([
      page({ id: "z", slugId: "z-s", title: "" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    expect(tree[0].label).toBe("untitled");
  });
});

describe("isPageInTree", () => {
  const tree: SharedPageTreeNode[] = buildSharedPageTree([
    page({ id: "root", slugId: "root-s", position: "a0" }),
    page({ id: "child", slugId: "child-s", parentPageId: "root", position: "a1" }),
    page({ id: "grand", slugId: "grand-s", parentPageId: "child", position: "a1" }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any);

  it("returns true for a top-level slugId", () => {
    expect(isPageInTree(tree, "root-s")).toBe(true);
  });

  it("returns true for a deeply nested slugId", () => {
    expect(isPageInTree(tree, "grand-s")).toBe(true);
  });

  it("returns false for an unknown slugId", () => {
    expect(isPageInTree(tree, "does-not-exist")).toBe(false);
  });

  it("returns false for an empty tree", () => {
    expect(isPageInTree([], "root-s")).toBe(false);
  });
});
