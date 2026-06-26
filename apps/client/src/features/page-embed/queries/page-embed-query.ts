import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  toggleTemplate,
  toggleTemporary,
} from "@/features/page-embed/services/page-embed-api";
import type {
  ToggleTemplateResponse,
  ToggleTemporaryResponse,
} from "@/features/page-embed/types/page-embed.types";
import { queryClient } from "@/main.tsx";

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
