import { IPage } from "@/features/page/types/page.types.ts";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";

export function sortPositionKeys(keys: any[]) {
  return keys.sort((a, b) => {
    if (a.position < b.position) return -1;
    if (a.position > b.position) return 1;
    return 0;
  });
}

export function buildTree(pages: IPage[]): SpaceTreeNode[] {
  const pageMap: Record<string, SpaceTreeNode> = {};

  const tree: SpaceTreeNode[] = [];

  pages.forEach((page) => {
    pageMap[page.id] = {
      id: page.id,
      slugId: page.slugId,
      name: page.title,
      icon: page.icon,
      position: page.position,
      hasChildren: page.hasChildren,
      spaceId: page.spaceId,
      parentPageId: page.parentPageId,
      canEdit: page.canEdit ?? page.permissions?.canEdit,
      isTemplate: page.isTemplate,
      children: [],
    };
  });

  // Defense-in-depth: a duplicate id in `pages` would push two references to the
  // same node, producing a duplicate React key that crashes the sidebar render.
  // Track ids we've already pushed and skip repeats so a stray duplicate from a
  // realtime cache write can never break the tree.
  const seen = new Set<string>();
  pages.forEach((page) => {
    if (seen.has(page.id)) return;
    seen.add(page.id);
    tree.push(pageMap[page.id]);
  });

  return sortPositionKeys(tree);
}

export function findBreadcrumbPath(
  tree: SpaceTreeNode[],
  pageId: string,
  path: SpaceTreeNode[] = [],
): SpaceTreeNode[] | null {
  for (const node of tree) {
    if (!node.name || node.name.trim() === "") {
      node.name = "untitled";
    }

    if (node.id === pageId) {
      return [...path, node];
    }

    if (node.children) {
      const newPath = findBreadcrumbPath(node.children, pageId, [
        ...path,
        node,
      ]);
      if (newPath) {
        return newPath;
      }
    }
  }
  return null;
}

export const updateTreeNodeName = (
  nodes: SpaceTreeNode[],
  nodeId: string,
  newName: string,
): SpaceTreeNode[] => {
  return nodes.map((node) => {
    if (node.id === nodeId) {
      return { ...node, name: newName };
    }
    if (node.children && node.children.length > 0) {
      return {
        ...node,
        children: updateTreeNodeName(node.children, nodeId, newName),
      };
    }
    return node;
  });
};

export const updateTreeNodeIcon = (
  nodes: SpaceTreeNode[],
  nodeId: string,
  newIcon: string,
): SpaceTreeNode[] => {
  return nodes.map((node) => {
    if (node.id === nodeId) {
      return { ...node, icon: newIcon };
    }
    if (node.children && node.children.length > 0) {
      return {
        ...node,
        children: updateTreeNodeIcon(node.children, nodeId, newIcon),
      };
    }
    return node;
  });
};

export const deleteTreeNode = (
  nodes: SpaceTreeNode[],
  nodeId: string,
): SpaceTreeNode[] => {
  return nodes
    .map((node) => {
      if (node.id === nodeId) {
        return null;
      }

      if (node.children && node.children.length > 0) {
        return {
          ...node,
          children: deleteTreeNode(node.children, nodeId),
        };
      }
      return node;
    })
    .filter((node) => node !== null);
};

export function buildTreeWithChildren(items: SpaceTreeNode[]): SpaceTreeNode[] {
  const nodeMap = {};
  let result: SpaceTreeNode[] = [];

  // Create a reference object for each item with the specified structure
  items.forEach((item) => {
    nodeMap[item.id] = { ...item, children: [] };
  });

  // Build the tree array
  items.forEach((item) => {
    const node = nodeMap[item.id];
    // A permission-trimmed response can include a node whose `parentPageId` is
    // not in the list (the parent was filtered out server-side). Treat such an
    // orphan as a root instead of dereferencing an absent parent and throwing
    // "Cannot read properties of undefined". Happy-path behaviour is unchanged:
    // a node whose parent IS present still nests under it.
    if (item.parentPageId !== null && nodeMap[item.parentPageId]) {
      // Find the parent node and add the current node to its children
      nodeMap[item.parentPageId].children.push(node);
    } else {
      // If the item has no parent (or its parent isn't loaded), it's a root
      // node, so add it to the result array.
      result.push(node);
    }
  });

  result = sortPositionKeys(result);

  // Recursively sort the children of each node
  function sortChildren(node: SpaceTreeNode) {
    if (node.children.length > 0) {
      node.hasChildren = true;
      node.children = sortPositionKeys(node.children);
      node.children.forEach(sortChildren);
    }
  }

  result.forEach(sortChildren);

  return result;
}

export function appendNodeChildren(
  treeItems: SpaceTreeNode[],
  nodeId: string,
  children: SpaceTreeNode[],
) {
  // Preserve deeper children if they exist and remove node if deleted
  return treeItems.map((node) => {
    if (node.id === nodeId) {
      const newIds = new Set(children.map((c) => c.id));

      const existingMap = new Map(
        (node.children ?? [])
          .filter((c) => newIds.has(c.id))
          .map((c) => [c.id, c]),
      );

      const merged = children.map((newChild) => {
        const existing = existingMap.get(newChild.id);
        return existing && existing.children
          ? { ...newChild, children: existing.children }
          : newChild;
      });

      return {
        ...node,
        children: merged,
      };
    }

    if (node.children) {
      return {
        ...node,
        children: appendNodeChildren(node.children, nodeId, children),
      };
    }

    return node;
  });
}

/**
 * Merge root nodes; keep existing ones intact, append new ones,
 */
export function mergeRootTrees(
  prevRoots: SpaceTreeNode[],
  incomingRoots: SpaceTreeNode[],
): SpaceTreeNode[] {
  const seen = new Set(prevRoots.map((r) => r.id));

  // add new roots that were not present before
  const merged = [...prevRoots];
  incomingRoots.forEach((node) => {
    if (!seen.has(node.id)) merged.push(node);
  });

  return sortPositionKeys(merged);
}

// Collect every node id in the tree (roots, branches, leaves). Used by
// collapseAll to clear the open-state map for all current-space nodes.
export function collectAllIds(nodes: SpaceTreeNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: SpaceTreeNode[]) => {
    for (const n of list) {
      ids.push(n.id);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

// Collect ids of branch nodes (nodes that have children). Used by expandAll to
// open every branch in the open-state map; leaves need no entry.
export function collectBranchIds(nodes: SpaceTreeNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: SpaceTreeNode[]) => {
    for (const n of list) {
      if (n.children?.length) {
        ids.push(n.id);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return ids;
}

// The open-state map (`openTreeNodesAtom`) is shared across spaces. Pure
// next-map helpers for expand/collapse so the merge logic can be unit-tested
// without rendering SpaceTree. Both return a fresh map and never mutate the
// input — ids not in `ids` (e.g. other spaces) are carried over untouched.

// Set each id in `ids` to true (open). Pre-existing entries (including other
// spaces' open state) are preserved.
export function openBranches(
  prevMap: Record<string, boolean>,
  ids: string[],
): Record<string, boolean> {
  const next = { ...prevMap };
  for (const id of ids) next[id] = true;
  return next;
}

// Set each id in `ids` to false (closed). Entries not listed (e.g. other
// spaces' ids) are left exactly as they were.
export function closeIds(
  prevMap: Record<string, boolean>,
  ids: string[],
): Record<string, boolean> {
  const next = { ...prevMap };
  for (const id of ids) next[id] = false;
  return next;
}
