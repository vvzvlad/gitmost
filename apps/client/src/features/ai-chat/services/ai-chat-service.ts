import api from "@/lib/api-client";
import { IPagination } from "@/lib/types.ts";
import {
  IAiChat,
  IAiChatListParams,
  IAiChatMessageRow,
  IAiChatMessagesParams,
  IAiRole,
  IAiRoleCatalog,
  IAiRoleCatalogBundle,
  IAiRoleCreate,
  IAiRoleImportPayload,
  IAiRoleImportResult,
  IAiRoleUpdate,
  IAiRoleUpdateFromCatalogResult,
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
 * Export a chat to Markdown (#183). The server renders the transcript from the
 * persisted rows (the DB is the single source of truth — including an
 * interrupted turn's in-progress row, persisted upfront + per step), so the
 * client just copies the returned string. `lang` localizes the few fixed
 * role/tool labels; defaults to English server-side when omitted.
 */
export async function exportAiChat(
  chatId: string,
  lang?: string,
): Promise<string> {
  const req = await api.post<{ markdown: string }>("/ai-chat/export", {
    chatId,
    lang,
  });
  return req.data.markdown;
}

/**
 * Generate a page title from note content (markdown). One-shot, non-streaming
 * (#199): the server only summarizes the supplied text and returns a suggestion;
 * it never writes the page. The caller applies the title via /pages/update.
 */
export async function generatePageTitle(content: string): Promise<string> {
  const req = await api.post<{ title: string }>(
    "/ai-chat/generate-page-title",
    { content },
  );
  return req.data.title;
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
  const req = await api.post<{ success: true }>("/ai-chat/roles/delete", {
    id,
  });
  return req.data;
}

/**
 * Role catalog API (`/ai-chat/roles/*`, admin-only — the server enforces this).
 * Browse a curated catalog, import roles/bundles into the workspace, and update
 * an imported role when the catalog ships a newer version. Same `{ data }`
 * unwrap convention as above.
 */

/** Browse the catalog, optionally localized to `language`. */
export async function getAiRoleCatalog(
  language?: string,
): Promise<IAiRoleCatalog> {
  const req = await api.post<IAiRoleCatalog>("/ai-chat/roles/catalog", {
    language,
  });
  return req.data;
}

/** Open one catalog bundle in a language (role content + versions). */
export async function getAiRoleCatalogBundle(
  bundleId: string,
  language: string,
): Promise<IAiRoleCatalogBundle> {
  const req = await api.post<IAiRoleCatalogBundle>(
    "/ai-chat/roles/catalog/bundle",
    { bundleId, language },
  );
  return req.data;
}

/** Import roles from a catalog bundle into the workspace (admin). */
export async function importAiRolesFromCatalog(
  payload: IAiRoleImportPayload,
): Promise<IAiRoleImportResult> {
  const req = await api.post<IAiRoleImportResult>(
    "/ai-chat/roles/import",
    payload,
  );
  return req.data;
}

/** Update an already-imported role from its catalog source (admin). */
export async function updateAiRoleFromCatalog(
  id: string,
): Promise<IAiRoleUpdateFromCatalogResult> {
  const req = await api.post<IAiRoleUpdateFromCatalogResult>(
    "/ai-chat/roles/update-from-catalog",
    { id },
  );
  return req.data;
}
