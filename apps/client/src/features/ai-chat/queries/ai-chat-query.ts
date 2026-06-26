import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import {
  createAiRole,
  deleteAiChat,
  deleteAiRole,
  getAiChatMessages,
  getAiChats,
  getAiRoleCatalog,
  getAiRoleCatalogBundle,
  getAiRoles,
  importAiRolesFromCatalog,
  renameAiChat,
  updateAiRole,
  updateAiRoleFromCatalog,
} from "@/features/ai-chat/services/ai-chat-service.ts";
import {
  IAiChat,
  IAiChatMessageRow,
  IAiRole,
  IAiRoleCatalog,
  IAiRoleCatalogBundle,
  IAiRoleCreate,
  IAiRoleImportPayload,
  IAiRoleImportResult,
  IAiRoleUpdate,
  IAiRoleUpdateFromCatalogResult,
} from "@/features/ai-chat/types/ai-chat.types.ts";
import { IPagination } from "@/lib/types.ts";

export const AI_CHATS_RQ_KEY = ["ai-chats"];
export const AI_ROLES_RQ_KEY = ["ai-roles"];
// Catalog reads resolve bundle names per language, so the language is part of
// the cache key (a language switch refetches rather than reusing stale names).
export const AI_ROLE_CATALOG_RQ_KEY = (language: string) => [
  "ai-role-catalog",
  language,
];
export const AI_ROLE_CATALOG_BUNDLE_RQ_KEY = (
  bundleId: string,
  language: string,
) => ["ai-role-catalog-bundle", bundleId, language];
export const AI_CHAT_MESSAGES_RQ_KEY = (chatId: string) => [
  "ai-chat-messages",
  chatId,
];

/** Paginated list of the current user's chats (auto-loads further pages). */
export function useAiChatsQuery() {
  const query = useInfiniteQuery({
    queryKey: AI_CHATS_RQ_KEY,
    queryFn: ({ pageParam }) =>
      getAiChats({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? (lastPage.meta.nextCursor ?? undefined) : undefined,
  });

  const data = useMemo<IPagination<IAiChat> | undefined>(() => {
    if (!query.data) return undefined;
    return {
      items: query.data.pages.flatMap((p) => p.items),
      meta: query.data.pages[query.data.pages.length - 1].meta,
    };
  }, [query.data]);

  return {
    data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/**
 * Load all persisted messages of a chat (oldest first), flattening the
 * paginated server response. Used to seed `useChat` initial messages.
 */
export function useAiChatMessagesQuery(chatId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: AI_CHAT_MESSAGES_RQ_KEY(chatId ?? ""),
    queryFn: ({ pageParam }) =>
      getAiChatMessages({ chatId: chatId as string, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? (lastPage.meta.nextCursor ?? undefined) : undefined,
    enabled: !!chatId,
  });

  // useInfiniteQuery only fetches the first page on its own. The hook's contract
  // (and both the Markdown export and the model-history seed) require the
  // COMPLETE thread, so keep pulling subsequent pages until the server reports
  // none remain. The isFetchingNextPage guard issues one request at a time;
  // when chatId is undefined the query is disabled and hasNextPage is false, so
  // this is a no-op. The isFetchNextPageError guard is critical: the app sets a
  // global `retry: false`, so a rejected fetchNextPage leaves hasNextPage true
  // and isFetchingNextPage false — without this guard the effect would re-fire
  // immediately and hammer the endpoint in a tight loop. isFetchNextPageError
  // latches the last next-page failure and clears once a fetch succeeds.
  useEffect(() => {
    if (
      query.hasNextPage &&
      !query.isFetchingNextPage &&
      !query.isFetchNextPageError
    ) {
      void query.fetchNextPage();
    }
  }, [
    query.hasNextPage,
    query.isFetchingNextPage,
    query.isFetchNextPageError,
    query.fetchNextPage,
  ]);

  const data = useMemo<IAiChatMessageRow[] | undefined>(() => {
    if (!query.data) return undefined;
    return query.data.pages.flatMap((p) => p.items);
  }, [query.data]);

  return {
    data,
    isLoading: query.isLoading || query.hasNextPage,
    isError: query.isError,
  };
}

export function useRenameAiChatMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<void, Error, { chatId: string; title: string }>({
    mutationFn: (data) => renameAiChat(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY });
    },
    onError: () => {
      notifications.show({
        message: t("Failed to rename chat"),
        color: "red",
      });
    },
  });
}

export function useDeleteAiChatMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<void, Error, string>({
    mutationFn: (chatId) => deleteAiChat(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY });
    },
    onError: () => {
      notifications.show({
        message: t("Failed to delete chat"),
        color: "red",
      });
    },
  });
}

/**
 * List the workspace's agent roles. Available to any workspace member (used by
 * the chat-creation role picker and the admin management section). `enabled`
 * lets callers gate the fetch (e.g. only fetch in the settings section).
 */
export function useAiRolesQuery(enabled: boolean = true) {
  return useQuery<IAiRole[], Error>({
    queryKey: AI_ROLES_RQ_KEY,
    queryFn: () => getAiRoles(),
    enabled,
  });
}

export function useCreateAiRoleMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IAiRole, Error, IAiRoleCreate>({
    mutationFn: (data) => createAiRole(data),
    onSuccess: () => {
      notifications.show({ message: t("Created successfully") });
      queryClient.invalidateQueries({ queryKey: AI_ROLES_RQ_KEY });
    },
    onError: (error) => {
      const message = error["response"]?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

export function useUpdateAiRoleMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IAiRole, Error, IAiRoleUpdate>({
    mutationFn: (data) => updateAiRole(data),
    onSuccess: () => {
      notifications.show({ message: t("Updated successfully") });
      queryClient.invalidateQueries({ queryKey: AI_ROLES_RQ_KEY });
      // The role badge denormalized onto the chat list may have changed.
      queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY });
    },
    onError: (error) => {
      const message = error["response"]?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

export function useDeleteAiRoleMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<{ success: true }, Error, string>({
    mutationFn: (id) => deleteAiRole(id),
    onSuccess: () => {
      notifications.show({ message: t("Deleted successfully") });
      queryClient.invalidateQueries({ queryKey: AI_ROLES_RQ_KEY });
      queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY });
    },
    onError: (error) => {
      const message = error["response"]?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

/**
 * Browse the role catalog for a language. Gated by `enabled` so the (admin-only)
 * fetch runs only when the catalog modal is open. The catalog can 502 when the
 * curated source is unreachable; callers handle the error state in the UI.
 */
export function useAiRoleCatalogQuery(language: string, enabled: boolean) {
  return useQuery<IAiRoleCatalog, Error>({
    queryKey: AI_ROLE_CATALOG_RQ_KEY(language),
    queryFn: () => getAiRoleCatalog(language),
    enabled,
  });
}

/**
 * Open one catalog bundle (role content + versions). Gated by `enabled` so the
 * fetch only runs when a bundle is actually expanded.
 */
export function useAiRoleCatalogBundleQuery(
  bundleId: string,
  language: string,
  enabled: boolean,
) {
  return useQuery<IAiRoleCatalogBundle, Error>({
    queryKey: AI_ROLE_CATALOG_BUNDLE_RQ_KEY(bundleId, language),
    queryFn: () => getAiRoleCatalogBundle(bundleId, language),
    enabled,
  });
}

export function useImportAiRolesFromCatalogMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IAiRoleImportResult, Error, IAiRoleImportPayload>({
    mutationFn: (payload) => importAiRolesFromCatalog(payload),
    onSuccess: (result) => {
      notifications.show({
        message: t("Imported {{created}}, renamed {{renamed}}, skipped {{skipped}}", {
          created: result.created,
          renamed: result.renamed,
          skipped: result.skipped,
        }),
      });
      // Surface partial failures (e.g. unique-name races) as a red warning.
      if (result.errors.length > 0) {
        notifications.show({
          color: "red",
          message: t("Failed to import {{count}} role(s)", {
            count: result.errors.length,
          }),
        });
      }
      queryClient.invalidateQueries({ queryKey: AI_ROLES_RQ_KEY });
      // Imported roles can appear in the chat picker / badges.
      queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY });
    },
    onError: (error) => {
      const message = error["response"]?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

export function useUpdateAiRoleFromCatalogMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IAiRoleUpdateFromCatalogResult, Error, string>({
    mutationFn: (id) => updateAiRoleFromCatalog(id),
    onSuccess: (result) => {
      // The server returns updated:false with a reason for a no-op (already
      // up to date / removed from catalog / language no longer offered). Map
      // each reason to a specific message instead of a generic "up to date".
      let message: string;
      if (result.updated) {
        message = t("Updated to the latest version");
      } else if (result.reason === "not-in-catalog") {
        message = t("This role is no longer in the catalog");
      } else if (result.reason === "language-unavailable") {
        message = t("This language is no longer available in the catalog");
      } else {
        // "up-to-date" and any unexpected reason.
        message = t("Already up to date");
      }
      notifications.show({ message });
      queryClient.invalidateQueries({ queryKey: AI_ROLES_RQ_KEY });
      // The role badge denormalized onto the chat list may have changed.
      queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY });
    },
    onError: (error) => {
      const message = error["response"]?.data?.message;
      notifications.show({
        message: message ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}
