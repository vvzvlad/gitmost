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
  actor: ProvenanceSource;
  aiChatId: string | null;
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
 *
 * Provenance is NEVER read from a client body field, so a normal user cannot fake
 * an 'agent' marker.
 */
export function resolveProvenance(
  user: { isAgent?: boolean | null } | null | undefined,
  claim: { actor?: ProvenanceSource; aiChatId?: string | null } | null | undefined,
): AuthProvenanceData {
  const actor: ProvenanceSource = user?.isAgent
    ? 'agent'
    : (claim?.actor ?? 'user');
  return { actor, aiChatId: claim?.aiChatId ?? null };
}

/**
 * Agent-edit write-stamp fields for a repository insert/update (#143 review).
 * Spread into the row being written: for an agent it stamps the `*Source`
 * column 'agent' and the AI-chat id; for a normal user it returns `{}` so the
 * column keeps its default ('user'). The only per-table variation is the column
 * names, passed as `sourceKey`/`chatKey`, so the agent-stamp idiom lives in ONE
 * place instead of being hand-reimplemented at every write site (where a wrong
 * literal or a forgotten `aiChatId` could drift).
 *
 *   insertComment({ ..., ...agentSourceFields(p, 'createdSource', 'aiChatId') })
 *   updatePage({ ..., ...agentSourceFields(p, 'lastUpdatedSource', 'lastUpdatedAiChatId') })
 *
 * Does NOT cover sites that must CLEAR the source on a non-agent action (e.g.
 * comment un-resolve, which writes an explicit null) — those keep their own
 * conditional; nor the collab persistence path (its own sticky-window logic).
 */
export function agentSourceFields<S extends string, C extends string>(
  provenance: AuthProvenanceData | undefined,
  sourceKey: S,
  chatKey: C,
): Partial<Record<S, ProvenanceSource> & Record<C, string | null>> {
  if (provenance?.actor !== 'agent') return {};
  return {
    [sourceKey]: 'agent',
    [chatKey]: provenance.aiChatId,
  } as Partial<Record<S, ProvenanceSource> & Record<C, string | null>>;
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
    return { actor, aiChatId };
  },
);
