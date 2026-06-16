import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import {
  deleteAiChat,
  getAiChatMessages,
  getAiChats,
  renameAiChat,
} from "@/features/ai-chat/services/ai-chat-service.ts";
import {
  IAiChat,
  IAiChatMessageRow,
} from "@/features/ai-chat/types/ai-chat.types.ts";
import { IPagination } from "@/lib/types.ts";

export const AI_CHATS_RQ_KEY = ["ai-chats"];
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
