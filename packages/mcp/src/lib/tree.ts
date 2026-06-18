/**
 * Pure tree-builder: turn a flat array of sidebar-style page nodes (as produced
 * by `enumerateSpacePages`) into a nested tree.
 *
 * Input: a flat array of nodes. Each node is expected to carry at least
 *   { id, slugId, title, position, parentPageId } (extra fields are ignored).
 *
 * Output: an array of ROOT nodes, each shaped as
 *   { id, slugId, title, children? }
 * where `children` is the array of child nodes (same shape, recursively). The
 * `children` key is OMITTED entirely when a node has no children — consistent
 * with how `filterPage` omits an empty `subpages` array — to keep the payload
 * lean (nesting alone conveys the structure; parentPageId/position/hasChildren
 * are intentionally dropped from the output).
 *
 * Linking rule: a node is attached as a child of `parentPageId` only when that
 * parent id is actually present in the input. Otherwise — including a null /
 * undefined `parentPageId`, or a parent that was capped out of the bounded walk
 * — the node is promoted to a ROOT. So "orphan whose parent is missing" is the
 * defined behavior: it surfaces at the top level rather than disappearing.
 *
 * Ordering rule: the roots array and every `children` array are sorted ascending
 * by the node's `position` string. The comparator is a plain code-unit (byte)
 * comparison — NOT localeCompare — because the server orders sidebar pages by
 * `collate "C"` (byte order), which a raw `<`/`>` compare approximates for the
 * fractional-index ASCII keys (e.g. "a0", "a1"). Nodes with a missing/undefined
 * `position` sort last.
 *
 * Pure: no I/O, no network, deterministic.
 */
export function buildPageTree(nodes: any[]): any[] {
  type OutputNode = {
    id: string;
    slugId: any;
    title: any;
    children?: OutputNode[];
  };

  // Map id -> output node. Build the lean output shape up front.
  const byId = new Map<string, OutputNode>();
  // Preserve the original position string for sorting (kept off the output).
  const positionById = new Map<string, string | undefined>();

  for (const node of nodes) {
    if (!node || typeof node !== "object" || !node.id) continue;
    // Defensive against duplicate ids: last one wins (overwrites the earlier
    // entry). `enumerateSpacePages` already dedups, so this is belt-and-braces.
    byId.set(node.id, {
      id: node.id,
      slugId: node.slugId,
      title: node.title,
    });
    positionById.set(node.id, node.position);
  }

  // Stable comparator on the position string: code-unit order, missing last.
  const byPosition = (aId: string, bId: string): number => {
    const a = positionById.get(aId);
    const b = positionById.get(bId);
    if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
    if (b === undefined || b === null) return -1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  };

  const roots: string[] = [];
  const childrenIdsByParent = new Map<string, string[]>();

  for (const node of nodes) {
    if (!node || typeof node !== "object" || !node.id) continue;
    const parentId = node.parentPageId;
    // Child only when the parent is actually present in the input; otherwise
    // (null/undefined parent, or parent capped out of the walk) -> root.
    if (parentId && byId.has(parentId)) {
      const list = childrenIdsByParent.get(parentId) ?? [];
      list.push(node.id);
      childrenIdsByParent.set(parentId, list);
    } else {
      roots.push(node.id);
    }
  }

  // Attach sorted children arrays to each parent, omitting empty ones.
  for (const [parentId, childIds] of childrenIdsByParent) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    childIds.sort(byPosition);
    parent.children = childIds.map((id) => byId.get(id)!);
  }

  roots.sort(byPosition);
  return roots.map((id) => byId.get(id)!);
}
