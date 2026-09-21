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

/**
 * Explicitly STOP the active agent run of a chat (#184). This is the ONLY thing
 * that ends a DETACHED run — a mere browser disconnect (aborting the local SSE)
 * is deliberately ignored server-side, so the client must call this to actually
 * stop an autonomous run. Targeted by `chatId` (the server resolves whatever run
 * is active on it); owner-gated server-side. Returns `{ stopped }` — false when
 * there was nothing active to stop.
 */
export async function stopRun(
  chatId: string,
): Promise<{ stopped: boolean }> {
  const req = await api.post<{ stopped: boolean }>("/ai-chat/stop", { chatId });
  return req.data;
}

/**
 * Delta poll (#491): the chat's message rows changed since `cursor` (a DB-clock
 * timestamp echoed from the previous poll) plus the current run fact, in ONE
 * round-trip — the degraded-poll fallback's payload, replacing the old "refetch
 * ALL infinite-query pages every 2.5s with full parts" poll. Omit `cursor` on the
 * first poll (returns just a fresh cursor, no rows, to start the chain). The
 * overlap window guarantees occasional REPEATS, so the caller MUST merge rows
 * idempotently by id (mergeById). Owner-gated server-side.
 */
export async function getAiChatMessagesDelta(
  chatId: string,
  cursor?: string,
): Promise<{
  rows: IAiChatMessageRow[];
  cursor: string;
  run: { id: string; status: string } | null;
}> {
  const req = await api.post<{
    rows: IAiChatMessageRow[];
    cursor: string;
    run: { id: string; status: string } | null;
  }>("/ai-chat/messages/delta", { chatId, cursor });
  return req.data;
}

/**
 * #488: the run-fact — "is a run active on this chat?" — first-class from the
 * server (POST /ai-chat/run). Called on mount to seed the client FSM's run-fact
 * and to VERIFY after a supersede mismatch (an observer following a superseded
 * run asks for the latest run and follows it). Returns the latest run row (with
 * its `id` and `status`) and its projected assistant message, or `run: null` when
 * the chat has never had a run. Owner-gated server-side.
 */
export async function getRun(chatId: string): Promise<{
  run: { id: string; status: string } | null;
  message: IAiChatMessageRow | null;
}> {
  const req = await api.post<{
    run: { id: string; status: string } | null;
    message: IAiChatMessageRow | null;
  }>("/ai-chat/run", { chatId });
  return req.data;
}

/**
 * Resolve the chat bound to a document (the current user's most-recent chat
 * created on that page), or null when there is none. Drives auto-open-on-page.
 */
export async function getBoundChat(slugId: string): Promise<string | null> {
  // The `pageId` body field accepts a page slugId or a uuid; the server resolves
  // it to the real page uuid (the wire key stays `pageId` for the DTO).
  const req = await api.post<{ chatId: string | null }>("/ai-chat/bound-chat", {
    pageId: slugId,
  });
  return req.data.chatId;
}

/**
 * Move (or clear) the page->chat binding for the current user (#665). Called on a
 * CONSCIOUS open: the history select re-binds the page to the chosen chat; "New
 * chat" clears it (`chatId: null`). Binding is a convenience, not access control,
 * so callers fire this WITHOUT blocking the UI on it (`void bindPage(...).catch`).
 * `pageId` accepts a slugId or a uuid (resolved server-side, #312). The response
 * `chatId` is a debug aid, NOT a postcondition — the requested binding, or null
 * when it was not applied (page/chat unresolved); callers ignore it.
 */
export async function bindPage(
  pageId: string,
  chatId: string | null,
): Promise<{ chatId: string | null }> {
  const req = await api.post<{ chatId: string | null }>("/ai-chat/bind-page", {
    pageId,
    chatId,
  });
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
