import { QueryParams } from "@/lib/types.ts";
import type { UIMessage } from "@ai-sdk/react";

/**
 * A persisted chat row (mirrors the server `ai_chats` selectAll shape returned
 * by `POST /ai-chat/chats`). Only the fields the UI reads are typed.
 */
export interface IAiChat {
  id: string;
  title: string | null;
  creatorId: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/**
 * A persisted message row (mirrors the server `ai_chat_messages` baseFields
 * returned by `POST /ai-chat/messages`, oldest first). `metadata.parts` holds
 * the reconstructable AI SDK UIMessage parts; `content` is the plain-text
 * fallback. `tsv` is never selected server-side, so it is not present here.
 */
export interface IAiChatMessageRow {
  id: string;
  role: "user" | "assistant" | string;
  content: string | null;
  toolCalls?: unknown;
  metadata?: {
    parts?: UIMessage["parts"];
    // AI SDK v6 `totalUsage` persisted on assistant rows. Legacy cumulative
    // figure (sum of every step's usage for the turn); kept for back-compat and
    // as the fallback for older rows that have no `contextTokens`.
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    // Current context size for the turn = final-step (input+output) tokens, i.e.
    // how much the conversation occupies in the model's context window after this
    // turn. Distinct from `usage` (legacy cumulative totalUsage). Shown in the
    // floating window's header badge.
    contextTokens?: number;
    // Set on an assistant row whose turn ended in a provider/stream error; the
    // raw provider error text (e.g. "402: ...") for inline display in the thread.
    error?: string;
  } | null;
  createdAt: string;
}

export interface IAiChatListParams extends QueryParams {}

export interface IAiChatMessagesParams {
  chatId: string;
  cursor?: string;
}
