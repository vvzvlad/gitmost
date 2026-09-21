import { useCallback } from "react";
import { useSetAtom, useStore } from "jotai";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { treeModel } from "@/features/page/tree/model/tree-model";
import type { DropOp } from "@/features/page/tree/model/tree-model.types";
import { dropOpToMovePayload } from "./drop-op-to-move-payload";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { pageToTreeNode } from "@/features/page/tree/utils";
import { IPage } from "@/features/page/types/page.types.ts";
import {
  useCreatePageMutation,
  useRemovePageMutation,
  useMovePageMutation,
  useUpdatePageMutation,
  updateCacheOnMovePage,
} from "@/features/page/queries/page-query.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { getSpaceUrl } from "@/lib/config.ts";
import {
  markOperationStart,
  measureOperation,
} from "@/lib/telemetry/vitals";
import { mobileSidebarAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";

export type UseTreeMutation = {
  handleMove: (sourceId: string, op: DropOp) => Promise<void>;
  handleCreate: (
    parentId: string | null,
    opts?: { temporary?: boolean },
  ) => Promise<void>;
  handleRename: (id: string, name: string) => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
};

export function useTreeMutation(spaceId: string): UseTreeMutation {
  const { t } = useTranslation();
  // Setter-only: this hook never reads the tree reactively (handlers read the
  // live value imperatively via `store` below), so useSetAtom avoids
  // re-rendering SpaceSidebar on every tree event.
  const setData = useSetAtom(treeDataAtom);
  // `store` reads the *current* treeDataAtom imperatively in handlers — avoids
  // stale-closure issues when the caller updates the tree (e.g. lazy-load
  // children) and then immediately invokes a handler.
  const store = useStore();
  const createPageMutation = useCreatePageMutation();
  const updatePageMutation = useUpdatePageMutation();
  const removePageMutation = useRemovePageMutation();
  const movePageMutation = useMovePageMutation();
  const navigate = useNavigate();
  const setMobileSidebar = useSetAtom(mobileSidebarAtom);
  const { spaceSlug, pageSlug } = useParams();

  const handleMove = useCallback(
    async (sourceId: string, op: DropOp) => {
      const before = store.get(treeDataAtom);
      const { tree: after } = treeModel.move(before, sourceId, op);
      if (after === before) return;

      const payload = dropOpToMovePayload(before, sourceId, op);
      const source = treeModel.find(before, sourceId) as SpaceTreeNode | null;
      if (!source) return;
      const oldParentId = source.parentPageId ?? null;

      // Child-loss guard (#523, twin of #525's realtime `insertByPosition` fix).
      // We no longer auto-expand the make-child target on drop, so the old
      // `onToggle(target, true)` — which was ALSO the only trigger of the
      // corrective lazy-load — is gone. `treeModel.move` materialized
      // `target.children = [source]` (only the moved node); if the target is an
      // UNLOADED branch (server has children but none are loaded here), keeping
      // that partial `[source]` list would defeat the lazy-load gate and hide the
      // target's OTHER server children (the #159 #1 data-loss class). So for an
      // unloaded make-child target, build the optimistic tree WITHOUT
      // materializing source under it: just remove source from its old parent and
      // flag the target `hasChildren`. The gate stays armed and a later manual
      // expand fetches the FULL set (incl. the moved page, which the awaited
      // server move persists). Predicate is the gate's (`isUnloadedBranch`), NOT
      // `insertByPosition`'s old `=== undefined` (canonical unloaded is `[]`).
      const target =
        op.kind === "make-child"
          ? (treeModel.find(before, op.targetId) as SpaceTreeNode | null)
          : null;
      const unloadedMakeChild =
        op.kind === "make-child" && treeModel.isUnloadedBranch(target);

      let optimistic: SpaceTreeNode[];
      if (unloadedMakeChild) {
        // Do NOT materialize [source] into the unloaded target.
        optimistic = treeModel.remove(before, sourceId);
        optimistic = treeModel.update(optimistic, op.targetId, {
          hasChildren: true,
        } as Partial<SpaceTreeNode>);
      } else {
        // optimistic apply with the new position from the payload
        optimistic = treeModel.update(after, sourceId, {
          position: payload.position,
          parentPageId: payload.parentPageId,
        } as Partial<SpaceTreeNode>);
        // For make-child onto a previously-childless (loaded) target: flip
        // hasChildren on so the new parent shows its chevron.
        if (op.kind === "make-child") {
          optimistic = treeModel.update(optimistic, op.targetId, {
            hasChildren: true,
          } as Partial<SpaceTreeNode>);
        }
      }

      // If the old parent has no children left, mark hasChildren: false so the
      // chevron disappears. Without this, the empty parent keeps rendering an
      // expand toggle that fetches zero rows on click.
      if (oldParentId) {
        const oldParent = treeModel.find(optimistic, oldParentId);
        if (!oldParent?.children?.length) {
          optimistic = treeModel.update(optimistic, oldParentId, {
            hasChildren: false,
          } as Partial<SpaceTreeNode>);
        }
      }

      // #683 `tree_dragdrop` — mark at the committed drop (this centralizes the
      // start for every drag-drop source, since all rows route their onDrop
      // through handleMove). Measured on success only, after the server move
      // settles and the cache is reconciled; the failure path below rolls back
      // and returns without measuring, so its mark expires.
      markOperationStart("tree_dragdrop");

      setData(optimistic);

      try {
        await movePageMutation.mutateAsync(payload);
      } catch {
        setData(before);
        notifications.show({
          message: t("Failed to move page"),
          color: "red",
        });
        return;
      }

      const pageData: Partial<IPage> = {
        id: source.id,
        slugId: source.slugId,
        title: source.name,
        icon: source.icon,
        position: payload.position,
        spaceId: source.spaceId,
        parentPageId: payload.parentPageId,
        hasChildren: source.hasChildren,
      };

      updateCacheOnMovePage(
        spaceId,
        sourceId,
        oldParentId,
        payload.parentPageId,
        pageData,
      );

      // #683 `tree_dragdrop` measure — the move persisted and the tree cache is
      // reconciled (the optimistic re-render already happened above). Success
      // path only.
      measureOperation("tree_dragdrop");

      // Realtime broadcast is now server-authoritative: the server emits
      // `moveTreeNode` to the space room on PAGE_MOVED. The old client relay
      // (emit + setTimeout(50)) was removed; the optimistic local update above
      // stays for instant feedback to the author.
    },
    [setData, store, movePageMutation, spaceId, t],
  );

  const handleCreate = useCallback(
    async (parentId: string | null, opts?: { temporary?: boolean }) => {
      const payload: {
        spaceId: string;
        parentPageId?: string;
        temporary?: boolean;
      } = { spaceId };
      if (parentId) payload.parentPageId = parentId;
      // Ask the server to arm the death timer for a "temporary note".
      if (opts?.temporary) payload.temporary = true;

      let createdPage: IPage;
      try {
        createdPage = await createPageMutation.mutateAsync(payload);
      } catch {
        throw new Error("Failed to create page");
      }

      // Route through the canonical mapper so the field copy (esp.
      // `temporaryExpiresAt`, which shows the temporary-note clock marker on
      // optimistic insert) can't drift from buildTree. `name: ""` because a
      // freshly created page is untitled; `hasChildren: false` because it has no
      // children yet.
      const newNode: SpaceTreeNode = pageToTreeNode(createdPage, {
        name: "",
        hasChildren: false,
      });

      // Read latest tree at call time. Without this, callers that mutate the
      // tree (e.g. lazy-load children on expand) immediately before calling
      // handleCreate hit a stale closure and compute lastIndex against the
      // pre-load tree, requiring a setTimeout-based wait at the call site.
      const current = store.get(treeDataAtom);
      let lastIndex: number;
      if (parentId === null) {
        lastIndex = current.length;
      } else {
        const parent = treeModel.find(current, parentId);
        lastIndex = parent?.children?.length ?? 0;
      }

      // Idempotent by id: the tree is server-authoritative and the server's
      // `addTreeNode` broadcast (now ~ms over same-origin) can win the race and
      // insert this node before this optimistic update runs. Inserting again
      // un-guarded would duplicate the row in the author's sidebar. Mirror the
      // `addTreeNode` socket guard: skip when the node already exists. The
      // optimistic node's id IS the real created page id (createdPage.id), so
      // the ids match exactly regardless of which path runs first.
      setData((prev) => {
        const existing = treeModel.find(prev, newNode.id);
        if (existing) {
          // The server `addTreeNode` broadcast won the race and already inserted
          // this node. Older broadcasts could omit `temporaryExpiresAt`, leaving
          // a temporary note WITHOUT its clock marker until reload; patch it on
          // from the authoritative create response so the marker shows now.
          if (
            newNode.temporaryExpiresAt &&
            !(existing as SpaceTreeNode).temporaryExpiresAt
          ) {
            return treeModel.update(prev, newNode.id, {
              temporaryExpiresAt: newNode.temporaryExpiresAt,
            } as Partial<SpaceTreeNode>);
          }
          return prev;
        }
        return treeModel.insert(prev, parentId, newNode, lastIndex);
      });

      // Realtime broadcast is now server-authoritative: the server emits
      // `addTreeNode` to the space room on PAGE_CREATED. The old client relay
      // (emit + setTimeout(50)) was removed; the optimistic insert above stays
      // for instant feedback to the author (the server event is idempotent and
      // a no-op for the author whose node already exists).
      const pageUrl = buildPageUrl(
        spaceSlug,
        createdPage.slugId,
        createdPage.title,
      );
      navigate(pageUrl);
      // On mobile the create action is triggered from inside the off-canvas
      // sidebar drawer (space sidebar "+", tree-row "add subpage"). Navigating
      // alone leaves that drawer open on top of the freshly created page, so the
      // editor stays hidden behind the tree. Close it here so the new page opens
      // in the editor — mirrors the row-click drawer-close in space-tree-row.
      // No-op on desktop, where the mobile drawer atom is already false.
      setMobileSidebar(false);
    },
    [
      spaceId,
      createPageMutation,
      setData,
      store,
      navigate,
      spaceSlug,
      setMobileSidebar,
    ],
  );

  const handleRename = useCallback(
    async (id: string, name: string) => {
      setData((prev) =>
        treeModel.update(prev, id, { name } as Partial<SpaceTreeNode>),
      );
      try {
        await updatePageMutation.mutateAsync({ pageId: id, title: name });
      } catch (error) {
        console.error("Error updating page title:", error);
      }
    },
    [updatePageMutation, setData],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const node = treeModel.find(
        store.get(treeDataAtom),
        id,
      ) as SpaceTreeNode | null;
      const parentPageId = node?.parentPageId ?? null;
      try {
        await removePageMutation.mutateAsync(id);
        setData((prev) => {
          let next = treeModel.remove(prev, id);
          // If the parent has no children left, mark hasChildren: false so the
          // chevron disappears. Without this, the empty parent keeps rendering an
          // expand toggle that fetches zero rows on click.
          if (parentPageId) {
            const parent = treeModel.find(next, parentPageId);
            if (!parent?.children?.length) {
              next = treeModel.update(next, parentPageId, {
                hasChildren: false,
              } as Partial<SpaceTreeNode>);
            }
          }
          return next;
        });

        if (
          node &&
          pageSlug &&
          (node.slugId === pageSlug.split("-")[1] ||
            isPageInNode(node, pageSlug.split("-")[1]))
        ) {
          navigate(getSpaceUrl(spaceSlug));
        }

        // Realtime broadcast is now server-authoritative: the server emits
        // `deleteTreeNode` to the space room on PAGE_SOFT_DELETED. The old
        // client relay (emit + setTimeout(50)) was removed; the optimistic
        // removal above stays for instant feedback to the author.
      } catch (error) {
        console.error("Failed to delete page:", error);
      }
    },
    [removePageMutation, setData, store, pageSlug, navigate, spaceSlug],
  );

  return { handleMove, handleCreate, handleRename, handleDelete };
}

function isPageInNode(node: SpaceTreeNode, pageSlug: string): boolean {
  if (node.slugId === pageSlug) return true;
  if (!node.children) return false;
  for (const child of node.children) {
    if (isPageInNode(child, pageSlug)) return true;
  }
  return false;
}
