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
  // The agent role bound to this chat, if any (immutable after creation).
  roleId?: string | null;
  // Denormalized via a JOIN in the chat list response (the bound role's badge).
  // Null when the chat has no role or the role was soft-deleted.
  roleName?: string | null;
  roleEmoji?: string | null;
  // The document the chat was created in (ai_chats.page_id). Null when started
  // outside any document.
  pageId?: string | null;
  // Denormalized via a JOIN in the chat list response: the origin page's title.
  // Null when there is no origin page (or it was hard-deleted).
  pageTitle?: string | null;
}

/** Supported model drivers (mirrors the server `AI_DRIVERS`). */
export type AiRoleDriver = "openai" | "gemini" | "ollama";

/** Optional per-role model override (mirrors `model_config`). */
export interface IAiRoleModelConfig {
  driver?: AiRoleDriver;
  chatModel?: string;
}

/**
 * An agent role (mirrors the server role views). A role replaces the agent's
 * persona (instructions) and may optionally override the model. The safety
 * framework is always still applied server-side.
 *
 * The list endpoint returns the FULL view to admins and a reduced picker view to
 * ordinary members, so the admin-only fields (`instructions`, `modelConfig`,
 * `createdAt`, `updatedAt`) are optional here — present only for admins.
 */
export interface IAiRole {
  id: string;
  name: string;
  emoji: string | null;
  description: string | null;
  instructions?: string;
  modelConfig?: IAiRoleModelConfig | null;
  enabled: boolean;
  // Whether picking the role auto-sends a launch message and starts the chat.
  autoStart: boolean;
  // Custom auto-start text; null/empty => the default launch message is sent.
  launchMessage: string | null;
  // Catalog origin of an imported role, or null for a manually-created one.
  // Admin-only (present only in the admin list view); the picker view omits it.
  // The admin UI compares `version` against the catalog to offer an update.
  source?: { slug: string; language: string; version: number } | null;
  createdAt?: string;
  updatedAt?: string;
}

/** One bundle's summary in the catalog index (mirrors `getCatalog().bundles[]`). */
export interface IAiRoleCatalogBundleSummary {
  id: string;
  name: string;
  description: string | null;
  languages: string[];
  roles: { slug: string; version: number }[];
}

/** The browsable catalog index (mirrors `getCatalog()`). */
export interface IAiRoleCatalog {
  languages: string[];
  bundles: IAiRoleCatalogBundleSummary[];
}

/** A single role inside an opened catalog bundle (localized content + version). */
export interface IAiRoleCatalogRole {
  slug: string;
  emoji: string | null;
  name: string;
  description: string | null;
  instructions: string;
  autoStart: boolean;
  launchMessage: string | null;
  version: number;
}

/** An opened catalog bundle (mirrors `getCatalogBundle()`). */
export interface IAiRoleCatalogBundle {
  bundleId: string;
  language: string;
  roles: IAiRoleCatalogRole[];
}

/** Import payload (mirrors the server `ImportFromCatalogDto`). */
export interface IAiRoleImportPayload {
  bundleId: string;
  language: string;
  // Omitted => import the whole bundle; otherwise only these slugs.
  slugs?: string[];
  conflict: "skip" | "rename";
}

/** Import result counts (mirrors `importFromCatalog()`). */
export interface IAiRoleImportResult {
  created: number;
  skipped: number;
  renamed: number;
  errors: { slug: string; message: string }[];
}

/**
 * Update-from-catalog result (mirrors the server `updateFromCatalog()`). A
 * discriminated union on `updated`: a no-op carries a typed `reason` the UI maps
 * to a specific message; a successful update carries the version bump + new role.
 * Keeping the union (not a widened `reason?: string`) lets the consumer's literal
 * comparisons be compiler-checked.
 */
export type IAiRoleUpdateFromCatalogResult =
  | {
      updated: false;
      reason: "not-in-catalog" | "up-to-date" | "language-unavailable";
    }
  | { updated: true; fromVersion: number; toVersion: number; role: IAiRole };

/** Admin create payload for a role. */
export interface IAiRoleCreate {
  name: string;
  emoji?: string;
  description?: string;
  instructions: string;
  modelConfig?: IAiRoleModelConfig | null;
  enabled?: boolean;
  autoStart?: boolean;
  launchMessage?: string;
}

/** Admin update payload for a role (partial). */
export interface IAiRoleUpdate {
  id: string;
  name?: string;
  emoji?: string;
  description?: string;
  instructions?: string;
  modelConfig?: IAiRoleModelConfig | null;
  enabled?: boolean;
  autoStart?: boolean;
  launchMessage?: string;
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
      // Reasoning (thinking) tokens, when the provider reports them. Optional so
      // old history rows (recorded before this shipped) stay valid. Included in
      // `outputTokens` per the AI SDK usage shape.
      reasoningTokens?: number;
    };
    // Current context size for the turn = final-step (input+output) tokens, i.e.
    // how much the conversation occupies in the model's context window after this
    // turn. Distinct from `usage` (legacy cumulative totalUsage). Shown in the
    // floating window's header badge.
    contextTokens?: number;
    // The model's max context window (denominator for the header badge); set
    // alongside contextTokens on a completed turn; absent on older rows.
    maxContextTokens?: number;
    // Set on an assistant row whose turn ended in a provider/stream error; the
    // raw provider error text (e.g. "402: ...") for inline display in the thread.
    error?: string;
    // Terminal outcome of the assistant turn: 'error' (provider/stream error,
    // paired with `error`), 'aborted' (client disconnect — a manual Stop or a
    // dropped connection), or the SDK's finish reason on a clean turn. The UI
    // renders a "stopped" marker on interrupted turns.
    finishReason?: string;
  } | null;
  createdAt: string;
}

export interface IAiChatListParams extends QueryParams {}

export interface IAiChatMessagesParams {
  chatId: string;
  cursor?: string;
}
