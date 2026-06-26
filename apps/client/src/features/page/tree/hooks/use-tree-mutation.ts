import { useCallback } from "react";
import { useAtom, useStore } from "jotai";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { treeModel } from "@/features/page/tree/model/tree-model";
import type { DropOp } from "@/features/page/tree/model/tree-model.types";
import { dropOpToMovePayload } from "./drop-op-to-move-payload";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
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
  const [, setData] = useAtom(treeDataAtom);
  // `store` reads the *current* treeDataAtom imperatively in handlers — avoids
  // stale-closure issues when the caller updates the tree (e.g. lazy-load
  // children) and then immediately invokes a handler.
  const store = useStore();
  const createPageMutation = useCreatePageMutation();
  const updatePageMutation = useUpdatePageMutation();
  const removePageMutation = useRemovePageMutation();
  const movePageMutation = useMovePageMutation();
  const navigate = useNavigate();
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

      // optimistic apply with the new position from the payload
      let optimistic = treeModel.update(after, sourceId, {
        position: payload.position,
        parentPageId: payload.parentPageId,
      } as Partial<SpaceTreeNode>);

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

      // For make-child onto a previously-childless target: flip hasChildren on
      // so the new parent shows its chevron.
      if (op.kind === "make-child") {
        optimistic = treeModel.update(optimistic, op.targetId, {
          hasChildren: true,
        } as Partial<SpaceTreeNode>);
      }

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

      const newNode: SpaceTreeNode = {
        id: createdPage.id,
        slugId: createdPage.slugId,
        name: "",
        position: createdPage.position,
        spaceId: createdPage.spaceId,
        parentPageId: createdPage.parentPageId,
        hasChildren: false,
        // Show the temporary-note icon immediately on optimistic insert.
        temporaryExpiresAt: createdPage.temporaryExpiresAt,
        children: [],
      };

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
        if (treeModel.find(prev, newNode.id)) return prev;
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
    },
    [spaceId, createPageMutation, setData, store, navigate, spaceSlug],
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
