import api from "@/lib/api-client";
import { IPagination } from "@/lib/types.ts";
import {
  IAiChat,
  IAiChatListParams,
  IAiChatMessageRow,
  IAiChatMessagesParams,
  IAiRole,
  IAiRoleCreate,
  IAiRoleUpdate,
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

/**
 * Agent roles API (`/ai-chat/roles`). `list` is available to any workspace
 * member (for the chat-creation picker); create/update/delete are admin-only
 * (the server enforces this). Same `{ data }` unwrap convention as above.
 */

/** List the workspace's agent roles. */
export async function getAiRoles(): Promise<IAiRole[]> {
  const req = await api.post<IAiRole[]>("/ai-chat/roles");
  return req.data;
}

/** Create a role (admin). */
export async function createAiRole(data: IAiRoleCreate): Promise<IAiRole> {
  const req = await api.post<IAiRole>("/ai-chat/roles/create", data);
  return req.data;
}

/** Update a role (admin). */
export async function updateAiRole(data: IAiRoleUpdate): Promise<IAiRole> {
  const req = await api.post<IAiRole>("/ai-chat/roles/update", data);
  return req.data;
}

/** Soft-delete a role (admin). */
export async function deleteAiRole(id: string): Promise<{ success: true }> {
  const req = await api.post<{ success: true }>("/ai-chat/roles/delete", { id });
  return req.data;
}
