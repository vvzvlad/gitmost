/**
 * Options for `buildPageTree`. Fully OPTIONAL so the existing call form
 * `buildPageTree(nodes)` keeps its historic behaviour (lean `{id, slugId,
 * title, children?}` output, no depth cut) unchanged.
 *
 *  - `shape: "getTree"` — emit the #443 `getTree` output node shape
 *    `{pageId, title, children?, hasChildren?}` instead of the lean
 *    `{id, slugId, title, children?}` shape. `slugId`/`icon`/`position` are
 *    never exposed (INVARIANT: only the UUID `pageId` leaves the MCP layer).
 *  - `maxDepth` — trim the built tree to this many levels (root nodes are
 *    depth 1). Only meaningful together with `shape: "getTree"` (the lean shape
 *    has no `hasChildren` to signal a cut). See the depth logic below.
 */
export interface BuildPageTreeOptions {
  shape?: "lean" | "getTree";
  maxDepth?: number;
}

/**
 * Pure tree-builder: turn a flat array of sidebar-style page nodes (as produced
 * by `enumerateSpacePages`) into a nested tree.
 *
 * Input: a flat array of nodes. Each node is expected to carry at least
 *   { id, slugId, title, position, parentPageId } (extra fields are ignored),
 *   plus a server `hasChildren` boolean used by the `getTree` shape below.
 *
 * Output (default / `shape: "lean"`): an array of ROOT nodes, each shaped as
 *   { id, slugId, title, children? }
 * where `children` is the array of child nodes (same shape, recursively). The
 * `children` key is OMITTED entirely when a node has no children — consistent
 * with how `filterPage` omits an empty `subpages` array — to keep the payload
 * lean (nesting alone conveys the structure; parentPageId/position/hasChildren
 * are intentionally dropped from the output).
 *
 * Output (`shape: "getTree"`, the #443 tool shape): each node is
 *   { pageId, title, children?, hasChildren? }
 * — the server `id` is exposed as `pageId` (never `slugId`/`icon`/`position`).
 * `children` is omitted for leaves and for nodes trimmed by `maxDepth`.
 * `hasChildren: true` is set ONLY on a node whose children exist on the server
 * (per the flat item's `hasChildren`) but were CUT by `maxDepth`; on leaves and
 * on fully-expanded interior nodes the field is omitted (see `maxDepth` below).
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
 * maxDepth (getTree shape only): the tree is built in FULL first, then trimmed
 * on the way out. Root nodes are depth 1. `maxDepth: N` keeps nodes at depth
 * <= N and drops the `children` of any node AT depth N. A node whose children
 * were dropped this way gets `hasChildren: true` when it actually had children
 * in the flat input (source of truth = the server `hasChildren` flag), so the
 * caller knows it can descend further with a follow-up `rootPageId` call. An
 * absent/undefined `maxDepth` means no cut (whole tree). `maxDepth <= 0` is
 * treated as "no cut" (defensive; the tool schema clamps to >= 1).
 *
 * Pure: no I/O, no network, deterministic.
 */
export function buildPageTree(
  nodes: any[],
  options: BuildPageTreeOptions = {},
): any[] {
  const getTreeShape = options.shape === "getTree";
  // A finite, positive cut only; anything else means "no cut".
  const maxDepth =
    typeof options.maxDepth === "number" &&
    Number.isFinite(options.maxDepth) &&
    options.maxDepth > 0
      ? Math.floor(options.maxDepth)
      : undefined;

  type InternalNode = {
    id: string;
    // Retained internally for shaping; never all emitted at once.
    slugId: any;
    title: any;
    hasServerChildren: boolean;
    children?: InternalNode[];
  };

  // Map id -> internal node. Build up front; the output shape is projected at
  // the very end so the maxDepth cut can consult `hasServerChildren`.
  const byId = new Map<string, InternalNode>();
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
      hasServerChildren: node.hasChildren === true,
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
  const rootNodes = roots.map((id) => byId.get(id)!);

  // Project the internal nodes into the requested OUTPUT shape, applying the
  // maxDepth cut for the getTree shape. `depth` is 1-based (roots = depth 1).
  const project = (node: InternalNode, depth: number): any => {
    if (getTreeShape) {
      const out: any = { pageId: node.id, title: node.title };
      const atCut = maxDepth !== undefined && depth >= maxDepth;
      if (!atCut && node.children && node.children.length > 0) {
        out.children = node.children.map((c) => project(c, depth + 1));
      } else if (atCut && node.hasServerChildren) {
        // Children exist on the server but were trimmed by maxDepth: signal it
        // so the caller can descend with a follow-up rootPageId call.
        out.hasChildren = true;
      }
      return out;
    }
    // Lean (historic) shape: cycle-safe, no depth cut, no hasChildren.
    const out: any = { id: node.id, slugId: node.slugId, title: node.title };
    if (node.children && node.children.length > 0) {
      out.children = node.children.map((c) => project(c, depth + 1));
    }
    return out;
  };

  return rootNodes.map((n) => project(n, 1));
}
