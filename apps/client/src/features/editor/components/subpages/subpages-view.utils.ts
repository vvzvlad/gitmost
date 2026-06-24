import { sortPositionKeys } from "@/features/page/tree/utils/utils";
import { IPage } from "@/features/page/types/page.types";
import { SharedPageTreeNode } from "@/features/share/utils";

// Normalized node shared by the flat and recursive subpages renderers so the
// same link/icon markup works for both API pages and shared-tree nodes.
export interface SubpageNode {
  id: string;
  slugId: string;
  title: string;
  icon?: string;
  children: SubpageNode[];
}

// Subpage node carrying `position` so each level can be sorted in place.
export type SubpageNodeWithPos = SubpageNode & {
  position: string;
  children: SubpageNodeWithPos[];
};

/**
 * Build a nested subtree (the current page's descendants) from the flat `IPage[]`
 * the `/pages/tree` endpoint returns. Attaches each node to its parent by
 * `parentPageId`, drops the root itself, and sorts every level by `position`.
 *
 * Guards only against SELF-PARENTING and attaching the root (`p.id !== rootId`) —
 * NOT against multi-node `parentPageId` cycles. Those cannot occur here: the
 * server rejects cyclic moves, and the recursive `getPageAndDescendants` CTE that
 * produces this list would itself loop before reaching the client, so the flat
 * input is acyclic by construction. A node whose `parentPageId` points outside
 * the result set (an unreachable parent) is silently dropped — it is, by
 * definition, not a descendant of the root being rendered.
 */
export function buildSubtree(pages: IPage[], rootId: string): SubpageNode[] {
  const byId = new Map<string, SubpageNodeWithPos>(
    pages.map((p) => [
      p.id,
      {
        id: p.id,
        slugId: p.slugId,
        title: p.title,
        icon: p.icon,
        position: p.position,
        children: [],
      },
    ]),
  );

  for (const p of pages) {
    const node = byId.get(p.id);
    const parent = p.parentPageId ? byId.get(p.parentPageId) : undefined;
    if (node && parent && p.id !== rootId) {
      parent.children.push(node);
    }
  }

  const sortRecursive = (
    nodes: SubpageNodeWithPos[],
  ): SubpageNodeWithPos[] => {
    const sorted = sortPositionKeys(nodes) as SubpageNodeWithPos[];
    sorted.forEach((n) => sortRecursive(n.children));
    return sorted;
  };

  const root = byId.get(rootId);
  return root ? sortRecursive(root.children) : [];
}

// Map shared-tree nodes (already nested) onto the normalized SubpageNode shape.
export function mapSharedNodes(nodes: SharedPageTreeNode[]): SubpageNode[] {
  return nodes.map((node) => ({
    id: node.value,
    slugId: node.slugId,
    title: node.name,
    icon: node.icon,
    children: node.children ? mapSharedNodes(node.children) : [],
  }));
}

// Count every descendant in a normalized subtree.
export function countNodes(nodes: SubpageNode[]): number {
  return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children), 0);
}
