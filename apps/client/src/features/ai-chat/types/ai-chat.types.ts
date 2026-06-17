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
    // AI SDK v6 `totalUsage` persisted on assistant rows. Used to sum the token
    // count shown in the floating window's header badge.
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  } | null;
  createdAt: string;
}

export interface IAiChatListParams extends QueryParams {}

export interface IAiChatMessagesParams {
  chatId: string;
  cursor?: string;
}
