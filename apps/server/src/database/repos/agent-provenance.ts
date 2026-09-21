/**
 * Server-authoritative "agent avatar stack" provenance (#300).
 *
 * Agent-authored content (comments / page-history snapshots) is displayed as a
 * two-avatar stack: the AGENT in front, and the HUMAN who launched it behind.
 * This module normalizes the two provenance shapes the client can encounter into
 * the SAME pair of sub-objects so the client never has to branch:
 *
 *   agent    — FRONT  (the acting agent identity)
 *   launcher — BEHIND (the human on whose behalf it acted; null when there is none)
 *
 * The discriminator is purely SERVER-SIDE data (createdSource / lastUpdatedSource
 * plus aiChatId) that only the server can set — none of it is read from request
 * input, so an external caller cannot spoof an `agent` badge.
 */

/** Front avatar identity. `avatarUrl`/`emoji` feed the glyph source priority. */
export interface AgentInfo {
  name: string;
  emoji?: string | null;
  avatarUrl?: string | null;
}

/** Behind avatar identity — the human who launched the agent (internal chat). */
export interface LauncherInfo {
  name: string;
  avatarUrl?: string | null;
}

/**
 * Inputs to the resolver, drawn entirely from server-side columns:
 * - `isAgent`  — createdSource/lastUpdatedSource === 'agent'.
 * - `aiChatId` — internal-AI-chat discriminator: non-null => internal chat (the
 *   provenance token was minted for the human, so `creator` is the human and the
 *   agent identity comes from the chat's role); null => external (no internal
 *   chat row).
 * - `api_key_id` — EXTERNAL-MCP discriminator (#559): non-null (with aiChatId
 *   null) => the write authenticated over an api_key, so the persona is the
 *   named key ("External MCP" / <key name>), with no separate human launcher.
 * - `apiKeyName` — the acting key's human-assigned name (e.g. `agent-node-2`),
 *   joined WITHOUT a deletedAt filter so it survives a key REVOKE; null when the
 *   key has no name or was hard-deleted (→ the External-MCP fallback name).
 * - `creator`  — the row's human author (internal chat) OR agent account.
 * - `agentRole`— the chat's bound role (name + optional emoji), resolved WITHOUT
 *   any enabled/deleted filter so historical content keeps its signature even
 *   after the role is disabled or soft-deleted; null when the chat has no role.
 */
export interface AgentProvenanceInput {
  isAgent: boolean;
  aiChatId: string | null | undefined;
  api_key_id?: string | null | undefined;
  apiKeyName?: string | null | undefined;
  creator: { name: string; avatarUrl?: string | null } | null | undefined;
  agentRole: { name: string; emoji?: string | null } | null | undefined;
}

export interface AgentProvenance {
  agent: AgentInfo;
  launcher: LauncherInfo | null;
}

/** Fallback display name for an internal agent edit whose chat has no role. */
export const AGENT_FALLBACK_NAME = 'AI agent';

/**
 * #559 — fallback display name for an EXTERNAL MCP edit whose api_key has no name
 * or was hard-deleted (id nulled by the FK's onDelete). Kept English, matching
 * AGENT_FALLBACK_NAME; the client/i18n layer localizes the display.
 */
export const EXTERNAL_MCP_FALLBACK_NAME = 'External MCP';

/**
 * Resolve the front/behind identities from server-side provenance. Returns
 * `null` for non-agent content so the caller can OMIT both fields (the client
 * then keeps its plain single-human avatar).
 *
 * There are exactly THREE attribution forms (the human `source='user'` case never
 * reaches here — isAgent is false, so we return null):
 *
 *  1. HUMAN — `source='user'`: isAgent false → null (flat human avatar).
 *  2. INTERNAL AGENT — `source='agent'`, aiChatId != null, api_key_id == null:
 *     agent = the chat's role name (or the AI-agent fallback), launcher = the
 *     human chat owner. UNCHANGED by #559.
 *  3. EXTERNAL MCP — `source='agent'`, aiChatId == null, api_key_id != null:
 *     agent = the api_key's name ("External MCP" fallback), launcher = null. The
 *     access was programmatic via an api_key — including an ordinary user's
 *     PERSONAL key, which is INTENTIONALLY attributed here rather than shown as
 *     the human (honest: the edit was made by a program holding the key).
 *
 * The degenerate form `source='agent'` with BOTH aiChatId and api_key_id null
 * (e.g. an is_agent account acting on a plain ACCESS token, no key, no chat)
 * keeps the pre-#559 external branch: the login itself is the agent account, so
 * agent = the creator (AI-agent fallback), launcher = null.
 */
export function resolveAgentProvenance(
  input: AgentProvenanceInput,
): AgentProvenance | null {
  if (!input.isAgent) return null;

  // External (no internal chat row).
  if (input.aiChatId == null) {
    // Form 3 — EXTERNAL MCP via api_key: the persona is the named key.
    if (input.api_key_id != null) {
      return {
        agent: {
          name: input.apiKeyName ?? EXTERNAL_MCP_FALLBACK_NAME,
          avatarUrl: null,
        },
        launcher: null,
      };
    }

    // Degenerate external form (no chat, no key): the login itself is the agent
    // account, so `creator` IS the agent. Preserved from before #559.
    return {
      agent: {
        name: input.creator?.name ?? AGENT_FALLBACK_NAME,
        avatarUrl: input.creator?.avatarUrl ?? null,
      },
      launcher: null,
    };
  }

  // Internal AI chat: the agent identity is the chat's role (or the fallback
  // when the chat has no role), and the launcher is the human chat owner.
  const agent: AgentInfo = input.agentRole
    ? {
        name: input.agentRole.name,
        emoji: input.agentRole.emoji ?? null,
        avatarUrl: null,
      }
    : { name: AGENT_FALLBACK_NAME, avatarUrl: null };

  const launcher: LauncherInfo | null = input.creator
    ? { name: input.creator.name, avatarUrl: input.creator.avatarUrl ?? null }
    : null;

  return { agent, launcher };
}
