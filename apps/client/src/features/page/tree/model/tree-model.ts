import type { TreeNode, SiblingsInfo } from "./tree-model.types";

function findInternal<T extends object>(
  nodes: TreeNode<T>[],
  id: string,
): { parents: TreeNode<T>[]; node: TreeNode<T> } | null {
  for (const node of nodes) {
    if (node.id === id) return { parents: [], node };
    if (node.children) {
      const inner = findInternal(node.children, id);
      if (inner) return { parents: [node, ...inner.parents], node: inner.node };
    }
  }
  return null;
}

export const treeModel = {
  find<T extends object>(tree: TreeNode<T>[], id: string): TreeNode<T> | null {
    return findInternal(tree, id)?.node ?? null;
  },

  path<T extends object>(
    tree: TreeNode<T>[],
    id: string,
  ): TreeNode<T>[] | null {
    const found = findInternal(tree, id);
    if (!found) return null;
    return [...found.parents, found.node];
  },

  siblingsOf<T extends object>(
    tree: TreeNode<T>[],
    id: string,
  ): SiblingsInfo<T> | null {
    const found = findInternal(tree, id);
    if (!found) return null;
    const parent = found.parents[found.parents.length - 1];
    const siblings = parent ? parent.children! : tree;
    return {
      parentId: parent?.id ?? null,
      siblings,
      index: siblings.findIndex((n) => n.id === id),
    };
  },

  isDescendant<T extends object>(
    tree: TreeNode<T>[],
    ancestorId: string,
    descendantId: string,
  ): boolean {
    if (ancestorId === descendantId) return false;
    const ancestor = treeModel.find(tree, ancestorId);
    if (!ancestor?.children) return false;
    return findInternal(ancestor.children, descendantId) !== null;
  },

  visible<T extends object>(
    tree: TreeNode<T>[],
    openIds: ReadonlySet<string>,
  ): TreeNode<T>[] {
    const out: TreeNode<T>[] = [];
    const walk = (nodes: TreeNode<T>[]) => {
      for (const node of nodes) {
        out.push(node);
        if (openIds.has(node.id) && node.children?.length) walk(node.children);
      }
    };
    walk(tree);
    return out;
  },

  insert<T extends object>(
    tree: TreeNode<T>[],
    parentId: string | null,
    node: TreeNode<T>,
    index?: number,
  ): TreeNode<T>[] {
    if (parentId === null) {
      const idx = index ?? tree.length;
      return [...tree.slice(0, idx), node, ...tree.slice(idx)];
    }
    let touched = false;
    const walk = (nodes: TreeNode<T>[]): TreeNode<T>[] =>
      nodes.map((n) => {
        if (n.id === parentId) {
          touched = true;
          const kids = n.children ?? [];
          const idx = index ?? kids.length;
          return {
            ...n,
            children: [...kids.slice(0, idx), node, ...kids.slice(idx)],
          };
        }
        if (n.children) {
          const next = walk(n.children);
          if (next !== n.children) return { ...n, children: next };
        }
        return n;
      });
    const out = walk(tree);
    return touched ? out : tree;
  },

  // Position-aware insert for server-authoritative broadcasts. The server does
  // not know each receiver's local index (clients have different loaded sets and
  // the root list is paginated), so it sends the node's fractional `position`.
  // We insert among the already-loaded siblings ordered by `position` so the
  // order is consistent across clients regardless of which nodes they loaded.
  // Falls back to appending when `position` is missing.
  insertByPosition<T extends { position?: string }>(
    tree: TreeNode<T>[],
    parentId: string | null,
    node: TreeNode<T>,
  ): TreeNode<T>[] {
    const index = (siblings: TreeNode<T>[]): number => {
      const pos = node.position;
      if (pos == null) return siblings.length;
      // First sibling whose position sorts after the new node's position.
      const at = siblings.findIndex(
        (s) => s.position != null && s.position > pos,
      );
      return at === -1 ? siblings.length : at;
    };

    if (parentId === null) {
      return treeModel.insert(tree, null, node, index(tree));
    }
    const parent = treeModel.find(tree, parentId);
    // The parent is in the tree but its children have NOT been lazy-loaded yet
    // (`children === undefined`, distinct from a loaded-but-empty `[]`). Inserting
    // here would MATERIALIZE a misleading partial child list (`[node]`) that
    // defeats the lazy-load gate — which fetches only when children are
    // absent/empty — so the parent's OTHER real children would never load and the
    // moved/added node would be the only one shown (a silent data loss, #159 #1).
    // Instead, leave the children unloaded and just flag `hasChildren` so the
    // chevron appears; expanding fetches the FULL set (including this node).
    if (parent && parent.children === undefined) {
      return treeModel.update(
        tree,
        parentId,
        // hasChildren is not part of the generic T constraint; tree nodes carry
        // it. Cast narrowly so this stays a single, well-understood exception.
        { hasChildren: true } as unknown as Omit<Partial<T>, "id" | "children">,
      );
    }
    const kids = (parent?.children as TreeNode<T>[] | undefined) ?? [];
    return treeModel.insert(tree, parentId, node, index(kids));
  },

  remove<T extends object>(tree: TreeNode<T>[], id: string): TreeNode<T>[] {
    let touched = false;
    const walk = (nodes: TreeNode<T>[]): TreeNode<T>[] => {
      const filtered = nodes.filter((n) => {
        if (n.id === id) {
          touched = true;
          return false;
        }
        return true;
      });
      return filtered.map((n) => {
        if (n.children) {
          const next = walk(n.children);
          if (next !== n.children) return { ...n, children: next };
        }
        return n;
      });
    };
    const out = walk(tree);
    return touched ? out : tree;
  },

  // `patch` excludes `id` (immutable) and `children` (use insert / remove /
  // appendChildren for structural changes — otherwise referential identity of
  // unrelated subtrees gets blown away).
  update<T extends object>(
    tree: TreeNode<T>[],
    id: string,
    patch: Omit<Partial<T>, "id" | "children">,
  ): TreeNode<T>[] {
    let touched = false;
    const walk = (nodes: TreeNode<T>[]): TreeNode<T>[] =>
      nodes.map((n) => {
        if (n.id === id) {
          touched = true;
          return { ...n, ...patch };
        }
        if (n.children) {
          const next = walk(n.children);
          if (next !== n.children) return { ...n, children: next };
        }
        return n;
      });
    const out = walk(tree);
    return touched ? out : tree;
  },

  appendChildren<T extends object>(
    tree: TreeNode<T>[],
    parentId: string,
    children: TreeNode<T>[],
  ): TreeNode<T>[] {
    let touched = false;
    const walk = (nodes: TreeNode<T>[]): TreeNode<T>[] =>
      nodes.map((n) => {
        if (n.id === parentId) {
          const existing = n.children ?? [];
          // Dedup against existing ids — auto-expand + manual toggle can race
          // and produce overlapping fetches; we don't want React to see two
          // children with the same key.
          const existingIds = new Set(existing.map((c) => c.id));
          const fresh = children.filter((c) => !existingIds.has(c.id));
          if (fresh.length === 0) return n;
          touched = true;
          return { ...n, children: [...existing, ...fresh] };
        }
        if (n.children) {
          const next = walk(n.children);
          if (next !== n.children) return { ...n, children: next };
        }
        return n;
      });
    const out = walk(tree);
    return touched ? out : tree;
  },

  // Replace a parent's DIRECT children with the authoritative `fresh` set while
  // PRESERVING each surviving child's already-loaded grandchildren (deeper
  // expansion). Unlike `appendChildren` (add-only), this DROPS children that are
  // no longer present and reorders to `fresh` — so a move/delete/rename that
  // happened inside a loaded branch while events were missed (a socket reconnect
  // gap) is reflected, not left stale (#159 #8). Only used to reconcile an
  // already-loaded branch against a fresh fetch; a parent with no loaded children
  // (`children === undefined`) is left untouched (lazy-load handles it).
  reconcileChildren<T extends object>(
    tree: TreeNode<T>[],
    parentId: string,
    fresh: TreeNode<T>[],
  ): TreeNode<T>[] {
    let touched = false;
    const walk = (nodes: TreeNode<T>[]): TreeNode<T>[] =>
      nodes.map((n) => {
        if (n.id === parentId) {
          // Only reconcile a branch whose children were actually loaded; an
          // unloaded parent stays unloaded (lazy-load fetches it fresh later).
          if (n.children === undefined) return n;
          const prevById = new Map(n.children.map((c) => [c.id, c]));
          const merged = fresh.map((f) => {
            const prev = prevById.get(f.id);
            // Preserve the surviving child's previously loaded grandchildren so
            // deeper expansion is not collapsed by the reconcile.
            return prev?.children !== undefined
              ? { ...f, children: prev.children }
              : f;
          });
          touched = true;
          return { ...n, children: merged };
        }
        if (n.children) {
          const next = walk(n.children);
          if (next !== n.children) return { ...n, children: next };
        }
        return n;
      });
    const out = walk(tree);
    return touched ? out : tree;
  },

  place<T extends object>(
    tree: TreeNode<T>[],
    sourceId: string,
    to: { parentId: string | null; index: number },
  ): TreeNode<T>[] {
    const source = treeModel.find(tree, sourceId);
    if (!source) return tree;
    if (to.parentId !== null && !treeModel.find(tree, to.parentId)) return tree;
    const removed = treeModel.remove(tree, sourceId);
    return treeModel.insert(removed, to.parentId, source, to.index);
  },

  // Position-aware move for server-authoritative `moveTreeNode` broadcasts. Like
  // `place`, but instead of an absolute index (which the sender computed against
  // its own loaded set), it inserts the moved node among the destination's
  // already-loaded siblings ordered by the node's fractional `position`. This
  // keeps the visible order correct for every receiver — `place(..., index: 0)`
  // would wrongly drop the node at the TOP of its new sibling list.
  // Returns the same array reference (like `place`) when the source is missing
  // or the destination parent isn't loaded on this client, so callers can detect
  // that and fall back to removing the node.
  placeByPosition<T extends { position?: string }>(
    tree: TreeNode<T>[],
    sourceId: string,
    to: { parentId: string | null; position?: string },
  ): TreeNode<T>[] {
    const source = treeModel.find(tree, sourceId);
    if (!source) return tree;
    if (to.parentId !== null && !treeModel.find(tree, to.parentId)) return tree;
    // Cycle guard, mirroring `move`'s `isDescendant` check (#206 ui-state-races-1).
    // If the destination parent is INSIDE the moved node's own subtree (reachable
    // when server-authoritative move events arrive out of order — e.g. X moved
    // under Y, then Y under X, but on this receiver Y is still inside X), then
    // `remove(sourceId)` would drop the future parent along with the whole subtree
    // and `insertByPosition` could not find it again — the node and ALL its
    // descendants would silently vanish. Refuse the move and return the same
    // reference so callers can detect the no-op and reconcile (refetch) instead.
    if (
      to.parentId !== null &&
      treeModel.isDescendant(tree, sourceId, to.parentId)
    ) {
      return tree;
    }
    const removed = treeModel.remove(tree, sourceId);
    // Reuse the same position-ordered insertion as `insertByPosition` by
    // stamping the authoritative position onto the moved node first.
    const positioned = { ...source, position: to.position } as TreeNode<T>;
    return treeModel.insertByPosition(removed, to.parentId, positioned);
  },

  move<T extends object>(
    tree: TreeNode<T>[],
    sourceId: string,
    op: import("./tree-model.types").DropOp,
  ): { tree: TreeNode<T>[]; result: import("./tree-model.types").DropResult } {
    if (sourceId === op.targetId)
      return { tree, result: { parentId: null, index: 0 } };
    if (!treeModel.find(tree, sourceId) || !treeModel.find(tree, op.targetId)) {
      return { tree, result: { parentId: null, index: 0 } };
    }
    if (treeModel.isDescendant(tree, sourceId, op.targetId)) {
      return { tree, result: { parentId: null, index: 0 } };
    }

    let parentId: string | null;
    let index: number;

    if (op.kind === "make-child") {
      parentId = op.targetId;
      const target = treeModel.find(tree, op.targetId)!;
      index = target.children?.length ?? 0;
    } else {
      const info = treeModel.siblingsOf(tree, op.targetId)!;
      parentId = info.parentId;
      const sourceInfo = treeModel.siblingsOf(tree, sourceId)!;
      const sameParent = sourceInfo.parentId === parentId;
      const adjust = sameParent && sourceInfo.index < info.index ? -1 : 0;
      index = info.index + adjust + (op.kind === "reorder-after" ? 1 : 0);
    }

    const next = treeModel.place(tree, sourceId, { parentId, index });
    return { tree: next, result: { parentId, index } };
  },
};
