import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { getDefaultStore } from "jotai";
import {
  toggleTemplate,
  toggleTemporary,
} from "@/features/page-embed/services/page-embed-api";
import type {
  ToggleTemplateResponse,
  ToggleTemporaryResponse,
} from "@/features/page-embed/types/page-embed.types";
import { queryClient } from "@/main.tsx";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";

/**
 * After toggling a note's temporary state, mirror the new deadline into the
 * shared page cache (keyed by both slugId and id) and refresh the sidebar so the
 * menu label, the in-page banner, and the tree icon all reflect the change.
 * Centralised here so the header menu and the banner can't drift apart on the
 * cache-key plumbing.
 */
export function syncTemporaryExpiresInCache(
  page: { id: string; slugId: string },
  temporaryExpiresAt: string | null,
) {
  for (const key of [page.slugId, page.id]) {
    const cached = queryClient.getQueryData<any>(["pages", key]);
    if (cached) {
      queryClient.setQueryData(["pages", key], {
        ...cached,
        temporaryExpiresAt,
      });
    }
  }
  // Patch the in-memory sidebar tree node so its temporary clock marker
  // appears/disappears immediately — WITHOUT a reload. The page cache update
  // above only drives the in-page banner/menu; the sidebar reads
  // `temporaryExpiresAt` straight off the `treeDataAtom` node. The app uses
  // jotai's default store (no <Provider>), so `getDefaultStore()` is the same
  // store the sidebar's hooks read from. `treeModel.update` returns the same
  // reference (a no-op) when the page isn't in the currently loaded tree.
  const store = getDefaultStore();
  const prevTree = store.get(treeDataAtom);
  const nextTree = treeModel.update(prevTree, page.id, {
    temporaryExpiresAt,
  } as Partial<SpaceTreeNode>);
  if (nextTree !== prevTree) store.set(treeDataAtom, nextTree);
  queryClient.invalidateQueries({
    predicate: (item) =>
      ["sidebar-pages"].includes(item.queryKey[0] as string),
  });
}

export function useToggleTemplateMutation() {
  return useMutation<
    ToggleTemplateResponse,
    Error,
    { pageId: string; isTemplate?: boolean }
  >({
    mutationFn: (data) => toggleTemplate(data),
    onError: (err: any) => {
      notifications.show({
        message: err?.response?.data?.message || "Failed to update template",
        color: "red",
      });
    },
  });
}

export function useToggleTemporaryMutation() {
  return useMutation<
    ToggleTemporaryResponse,
    Error,
    { pageId: string; temporary?: boolean }
  >({
    mutationFn: (data) => toggleTemporary(data),
    onError: (err: any) => {
      notifications.show({
        message:
          err?.response?.data?.message || "Failed to update temporary note",
        color: "red",
      });
    },
  });
}
