import { describe, it, expect } from "vitest";
import {
  buildSubtree,
  countNodes,
  mapSharedNodes,
  SubpageNode,
} from "./subpages-view.utils";
import { IPage } from "@/features/page/types/page.types";

// Minimal IPage fixture — buildSubtree only reads id/slugId/title/icon/position/
// parentPageId. `position` keys are fractional-indexing strings (lexicographic).
const page = (p: Partial<IPage> & { id: string }): IPage =>
  ({
    slugId: `slug-${p.id}`,
    title: `Title ${p.id}`,
    icon: undefined,
    position: "a0",
    parentPageId: null,
    ...p,
  }) as IPage;

const ids = (nodes: SubpageNode[]): string[] => nodes.map((n) => n.id);

describe("buildSubtree", () => {
  it("nests children under the root and excludes the root itself", () => {
    const pages = [
      page({ id: "root" }),
      page({ id: "a", parentPageId: "root", position: "a0" }),
      page({ id: "b", parentPageId: "root", position: "a1" }),
      page({ id: "a1", parentPageId: "a", position: "a0" }),
    ];
    const tree = buildSubtree(pages, "root");
    // Root is not rendered; only its descendants.
    expect(ids(tree)).toEqual(["a", "b"]);
    expect(ids(tree[0].children)).toEqual(["a1"]);
    expect(tree[1].children).toEqual([]);
  });

  it("sorts each level by position", () => {
    const pages = [
      page({ id: "root" }),
      page({ id: "z", parentPageId: "root", position: "a2" }),
      page({ id: "x", parentPageId: "root", position: "a0" }),
      page({ id: "y", parentPageId: "root", position: "a1" }),
    ];
    expect(ids(buildSubtree(pages, "root"))).toEqual(["x", "y", "z"]);
  });

  it("returns [] when the root is absent from the page set", () => {
    const pages = [page({ id: "a", parentPageId: "missing-root" })];
    expect(buildSubtree(pages, "missing-root")).toEqual([]);
  });

  it("silently drops a node whose parent is absent (unreachable parent)", () => {
    const pages = [
      page({ id: "root" }),
      page({ id: "ok", parentPageId: "root" }),
      page({ id: "orphan", parentPageId: "ghost" }), // parent not in the set
    ];
    expect(ids(buildSubtree(pages, "root"))).toEqual(["ok"]);
  });

  it("guards against self-parenting / attaching the root", () => {
    const pages = [
      // A (defensive) self-parented root must not attach to itself.
      page({ id: "root", parentPageId: "root" }),
      page({ id: "a", parentPageId: "root" }),
    ];
    const tree = buildSubtree(pages, "root");
    expect(ids(tree)).toEqual(["a"]);
  });

  it("returns [] for empty input", () => {
    expect(buildSubtree([], "root")).toEqual([]);
  });
});

describe("countNodes", () => {
  it("counts every descendant across all levels", () => {
    const tree: SubpageNode[] = [
      {
        id: "a",
        slugId: "s",
        title: "A",
        children: [
          { id: "a1", slugId: "s", title: "A1", children: [] },
          { id: "a2", slugId: "s", title: "A2", children: [] },
        ],
      },
      { id: "b", slugId: "s", title: "B", children: [] },
    ];
    expect(countNodes(tree)).toBe(4);
    expect(countNodes([])).toBe(0);
  });
});

describe("mapSharedNodes", () => {
  it("remaps value->id / name->title and keeps nested children", () => {
    const shared = [
      {
        value: "p1",
        slugId: "s1",
        name: "Parent",
        icon: "📁",
        children: [
          { value: "c1", slugId: "sc1", name: "Child", children: [] },
        ],
      },
    ] as any;
    const mapped = mapSharedNodes(shared);
    expect(mapped[0]).toMatchObject({ id: "p1", slugId: "s1", title: "Parent", icon: "📁" });
    expect(mapped[0].children[0]).toMatchObject({ id: "c1", title: "Child" });
  });
});
