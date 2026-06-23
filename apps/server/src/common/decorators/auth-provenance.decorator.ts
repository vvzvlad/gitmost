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
