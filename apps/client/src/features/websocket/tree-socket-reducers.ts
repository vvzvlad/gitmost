import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { treeModel } from "@/features/page/tree/model/tree-model";
import type {
  AddTreeNodeEvent,
  MoveTreeNodeEvent,
  DeleteTreeNodeEvent,
  UpdateEvent,
} from "@/features/websocket/types";

// Pure tree transforms for the `useTreeSocket` reducer arms. Extracted from the
// hook so the realtime tree behaviour can be unit-tested without rendering the
// hook, the socket, or jotai. The hook calls these inside its `setData`.
//
// IMPORTANT: these are PURE — no `queryClient`, no notifications, no atoms. The
// delete arm's `queryClient.invalidateQueries` side effect stays in the hook;
// `applyDeleteTreeNode` is a pure tree transform only.

// `updateOne` for a page: patch the in-tree node's name/icon from the payload.
// No-op (returns the same reference) when the node isn't loaded on this client.
export function applyUpdateOne(
  prev: SpaceTreeNode[],
  event: UpdateEvent,
): SpaceTreeNode[] {
  if (!treeModel.find(prev, event.id)) return prev;
  let next = prev;
  if (event.payload?.title !== undefined) {
    next = treeModel.update(next, event.id, {
      name: event.payload.title,
    } as Partial<SpaceTreeNode>);
  }
  if (event.payload?.icon !== undefined) {
    next = treeModel.update(next, event.id, {
      icon: event.payload.icon,
    } as Partial<SpaceTreeNode>);
  }
  return next;
}

// `addTreeNode`: insert the new node by its fractional `position` among the
// already-loaded siblings (not the sender's absolute index). Idempotent — if the
// id already exists (optimistic author insert or re-delivery) returns prev
// unchanged. Flips the new parent's `hasChildren` to true so the chevron renders.
export function applyAddTreeNode(
  prev: SpaceTreeNode[],
  payload: AddTreeNodeEvent["payload"],
): SpaceTreeNode[] {
  // Idempotent: the author already inserted the node optimistically, and a node
  // may be re-delivered — never insert a duplicate id.
  if (treeModel.find(prev, payload.data.id)) return prev;
  const newParentId = payload.parentId as string | null;
  // Insert by `position` among already-loaded siblings (not the sender's
  // absolute index) so order is consistent across clients with different loaded
  // sets.
  let next = treeModel.insertByPosition(prev, newParentId, payload.data);
  // Mirror the emitter: flip new parent's hasChildren to true so the chevron
  // renders on the receiver.
  if (newParentId) {
    next = treeModel.update(next, newParentId, {
      hasChildren: true,
    } as Partial<SpaceTreeNode>);
  }
  return next;
}

// `moveTreeNode`: place the moved node by its fractional `position` among the new
// siblings (NOT the sender's absolute index). If the destination parent isn't
// loaded on this client, fall back to removing the source so the UI stays
// consistent. Applies authoritative `pageData` fields and mirrors the
// `hasChildren` bookkeeping for both the old and the new parent.
export function applyMoveTreeNode(
  prev: SpaceTreeNode[],
  payload: MoveTreeNodeEvent["payload"],
): SpaceTreeNode[] {
  const sourceBefore = treeModel.find(prev, payload.id);
  if (!sourceBefore) return prev;
  const oldParentId = (sourceBefore as SpaceTreeNode).parentPageId ?? null;
  const newParentId = payload.parentId as string | null;

  // Place the node by its fractional `position` among the new siblings — NOT by
  // the sender's absolute `index` (the sender computed that against its own
  // loaded set, which differs from this receiver's). Using the position keeps
  // the visible order correct on every client; placing at `index: 0` would
  // wrongly drop reordered/moved nodes at the top of their new sibling list.
  const placed = treeModel.placeByPosition(prev, payload.id, {
    parentId: newParentId,
    position: payload.position,
  });
  // `placeByPosition` silently returns the same reference if the destination
  // parent isn't loaded on this client. Falling back to removing the source
  // keeps the UI consistent (the source reappears when the user expands the new
  // parent and lazy-load fetches it).
  if (placed === prev) {
    return treeModel.remove(prev, payload.id);
  }

  // Apply the authoritative node fields the move payload carries (`pageData`) so
  // receivers don't keep a stale title/icon/chevron on the moved node.
  // `placeByPosition` already set `position`.
  const pageData = payload.pageData as
    | {
        title?: string | null;
        icon?: string | null;
        hasChildren?: boolean;
      }
    | undefined;
  const patch: Partial<SpaceTreeNode> = {
    position: payload.position,
    // Honest type: a root move has a null parent, so this is `string | null`,
    // not always `string`.
    parentPageId: newParentId as string | null,
  };
  if (pageData) {
    // The tree node stores the title as `name`.
    if (pageData.title !== undefined) patch.name = pageData.title ?? "";
    if (pageData.icon !== undefined) patch.icon = pageData.icon ?? undefined;
    if (pageData.hasChildren !== undefined)
      patch.hasChildren = pageData.hasChildren;
  }
  let next = treeModel.update(placed, payload.id, patch);

  // Mirror the emitter's hasChildren bookkeeping so both clients converge to the
  // same chevron state.
  if (oldParentId) {
    const oldParent = treeModel.find(next, oldParentId);
    if (!oldParent?.children?.length) {
      next = treeModel.update(next, oldParentId, {
        hasChildren: false,
      } as Partial<SpaceTreeNode>);
    }
  }
  if (newParentId) {
    next = treeModel.update(next, newParentId, {
      hasChildren: true,
    } as Partial<SpaceTreeNode>);
  }

  return next;
}

// `deleteTreeNode`: remove the node (and its descendants) from the tree.
// Idempotent — if the node is already gone returns prev unchanged. Mirrors the
// `hasChildren` bookkeeping: a parent left childless flips `hasChildren` false.
//
// PURE: the `queryClient.invalidateQueries` side effect lives in the hook, not
// here.
export function applyDeleteTreeNode(
  prev: SpaceTreeNode[],
  payload: DeleteTreeNodeEvent["payload"],
): SpaceTreeNode[] {
  if (!treeModel.find(prev, payload.node.id)) return prev;
  let next = treeModel.remove(prev, payload.node.id);
  // Mirror the emitter's hasChildren bookkeeping so both clients converge to the
  // same chevron state when the last child is deleted.
  const parentPageId = payload.node.parentPageId;
  if (parentPageId) {
    const parent = treeModel.find(next, parentPageId);
    if (!parent?.children?.length) {
      next = treeModel.update(next, parentPageId, {
        hasChildren: false,
      } as Partial<SpaceTreeNode>);
    }
  }
  return next;
}
