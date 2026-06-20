import { describe, it, expect } from "vitest";
import { buildTree } from "./utils";
import type { IPage } from "@/features/page/types/page.types.ts";

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
