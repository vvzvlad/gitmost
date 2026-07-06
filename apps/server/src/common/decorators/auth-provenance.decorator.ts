import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ProvenanceSource } from '../../core/auth/dto/jwt-payload';

/**
 * The agent-edit provenance carried by the request, read from the SIGNED access
 * token (set by `jwt.strategy`). `actor` is 'agent' only for the internal AI
 * agent's minted token; every normal user request resolves to 'user'. Because
 * it comes from the signed claim — never a client body field — a normal user
 * cannot fake an 'agent' marker.
 */
export interface AuthProvenanceData {
  // ProvenanceSource includes 'git-sync' — set by the in-process git-sync data
  // plane (issue #194 §8.1) when it drives PageService writes; never from a request token.
  actor: ProvenanceSource;
  aiChatId: string | null;
  // #559 — the api_key that authenticated this write, when it came in over an
  // api-key principal (an EXTERNAL MCP agent). Non-null ⇒ the write is attributed
  // to the "External MCP" persona named after the key, regardless of aiChatId
  // (which is always null on this path — an api key has no internal ai_chats row).
  // Null for a normal user/session write and for the internal AI agent (whose
  // provenance is carried by aiChatId instead). Optional so the many existing
  // test/manual constructions of this shape stay valid; the decorator and
  // resolveProvenance always populate it (null when absent).
  apiKeyId?: string | null;
}

/**
 * Single source of truth for deriving a write's provenance from the SIGNED
 * server-side identity (#143 review, Arch A). Used by BOTH transport seams — the
 * REST access-token strategy and the collab websocket auth — so they can't drift:
 *
 *   - A `user.isAgent` service account (e.g. the MCP bot) stamps 'agent' on every
 *     write. It has no internal ai_chats row, so aiChatId comes from the claim
 *     (usually null).
 *   - Otherwise honor the actor claim minted into the internal AI agent's token
 *     (actor='agent' + aiChatId); a normal user token carries no claim → 'user'.
 *   - #559 — a write that authenticated over an api-key principal (an EXTERNAL
 *     MCP agent) is ALWAYS 'agent', even for an ordinary (non-is_agent) user's
 *     PERSONAL key. That is intentional and honest: the access was programmatic
 *     via an api_key, so the edit is attributed to the "External MCP" persona
 *     named after the key rather than shown as if the human typed it. The key id
 *     is threaded through as `apiKeyId`; aiChatId stays null on this path.
 *
 * Provenance is NEVER read from a client body field, so a normal user cannot fake
 * an 'agent' marker — `apiKeyId` too is the SERVER-verified key id, not client input.
 */
export function resolveProvenance(
  user: { isAgent?: boolean | null } | null | undefined,
  claim:
    | { actor?: ProvenanceSource; aiChatId?: string | null }
    | null
    | undefined,
  apiKeyId?: string | null,
): AuthProvenanceData {
  const isExternalMcp = apiKeyId != null;
  const actor: ProvenanceSource =
    user?.isAgent || isExternalMcp ? 'agent' : (claim?.actor ?? 'user');
  return {
    actor,
    aiChatId: claim?.aiChatId ?? null,
    apiKeyId: apiKeyId ?? null,
  };
}

/**
 * Agent-edit write-stamp fields for a repository insert/update (#143 review).
 * Spread into the row being written: for an agent it stamps the `*Source`
 * column 'agent' and the AI-chat id; for a normal user it returns `{}` — on an
 * INSERT the omitted column falls back to its DB default ('user'); on an UPDATE
 * the column simply keeps its existing stored value (Kysely only writes the keys
 * present). The only per-table variation is the column names, passed as
 * `sourceKey`/`chatKey`, so the agent-stamp idiom lives in ONE place instead of
 * being hand-reimplemented at every write site (where a wrong literal or a
 * forgotten `aiChatId` could drift).
 *
 *   insertComment({ ..., ...agentSourceFields(p, 'createdSource', 'aiChatId', 'createdApiKeyId') })
 *   updatePage({ ..., ...agentSourceFields(p, 'lastUpdatedSource', 'lastUpdatedAiChatId', 'lastUpdatedApiKeyId') })
 *
 * #559 — the optional `apiKeyKey` names the external-MCP api_key column for this
 * table. When provided, it is ALWAYS written for an agent action (to the verified
 * key id, or null for the internal AI agent, which has none) so the aiChatId /
 * apiKeyId pair is mutually exclusive and internally consistent: an internal
 * agent write carries {aiChatId, api_key_id=null}, an external MCP write carries
 * {aiChatId=null, api_key_id}. Omit `apiKeyKey` for a table without the column.
 *
 * Does NOT cover sites that must CLEAR the source on a non-agent action (e.g.
 * comment un-resolve, which writes an explicit null) — those keep their own
 * conditional; nor the collab persistence path (its own sticky-window logic).
 */
export function agentSourceFields<
  S extends string,
  C extends string,
  K extends string = never,
>(
  provenance: AuthProvenanceData | undefined,
  sourceKey: S,
  chatKey: C,
  apiKeyKey?: K,
): Partial<
  Record<S, ProvenanceSource> &
    Record<C, string | null> &
    Record<K, string | null>
> {
  // git-sync data-plane write (issue #194 §8.1): stamp the source 'git-sync' with NO
  // aiChatId (it has no internal ai_chats row). Mirrors the agent branch; each
  // write has a single actor, so precedence is irrelevant here.
  if (provenance?.actor === 'git-sync') {
    return { [sourceKey]: 'git-sync' } as Partial<
      Record<S, ProvenanceSource> &
        Record<C, string | null> &
        Record<K, string | null>
    >;
  }
  if (provenance?.actor !== 'agent') return {};
  const fields: Record<string, ProvenanceSource | string | null> = {
    [sourceKey]: 'agent',
    [chatKey]: provenance.aiChatId,
  };
  if (apiKeyKey) {
    fields[apiKeyKey] = provenance.apiKeyId ?? null;
  }
  return fields as Partial<
    Record<S, ProvenanceSource> &
      Record<C, string | null> &
      Record<K, string | null>
  >;
}

/**
 * Resolve the request's provenance. Defaults to a 'user' actor when the claim
 * is absent (e.g. an endpoint reached without going through the access-token
 * strategy path), so callers can always set the marker unconditionally.
 */
export const AuthProvenance = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthProvenanceData => {
    const request = ctx.switchToHttp().getRequest();
    const actor = request?.raw?.actor === 'agent' ? 'agent' : 'user';
    const aiChatId = request?.raw?.aiChatId ?? null;
    // #559 — the api-key principal id stamped by jwt.strategy.validateApiKey
    // (null on the normal access-token path); drives the external-MCP persona.
    const apiKeyId = request?.raw?.apiKeyId ?? null;
    return { actor, aiChatId, apiKeyId };
  },
);
