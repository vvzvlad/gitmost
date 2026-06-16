import api from "@/lib/api-client";
import { IPagination } from "@/lib/types.ts";
import {
  IAiChat,
  IAiChatListParams,
  IAiChatMessageRow,
  IAiChatMessagesParams,
} from "@/features/ai-chat/types/ai-chat.types.ts";

/**
 * Per-user AI chat CRUD. The server uses POST for reads (its convention) and
 * wraps every (non-stream) response in `{ data }` via the global transform
 * interceptor, which the axios client unwraps to the body — so we read `.data`
 * (mirroring `comment-service`). The `/ai-chat/stream` endpoint is consumed by
 * the AI SDK `useChat` transport directly, not here.
 */

/** List the current user's chats (most recent first, paginated). */
export async function getAiChats(
  params: IAiChatListParams,
): Promise<IPagination<IAiChat>> {
  const req = await api.post<IPagination<IAiChat>>("/ai-chat/chats", params);
  return req.data;
}

/** Fetch a chat's messages (oldest first, paginated). */
export async function getAiChatMessages(
  params: IAiChatMessagesParams,
): Promise<IPagination<IAiChatMessageRow>> {
  const req = await api.post<IPagination<IAiChatMessageRow>>(
    "/ai-chat/messages",
    params,
  );
  return req.data;
}

/** Rename a chat. */
export async function renameAiChat(data: {
  chatId: string;
  title: string;
}): Promise<void> {
  await api.post("/ai-chat/rename", data);
}

/** Soft-delete a chat. */
export async function deleteAiChat(chatId: string): Promise<void> {
  await api.post("/ai-chat/delete", { chatId });
}
