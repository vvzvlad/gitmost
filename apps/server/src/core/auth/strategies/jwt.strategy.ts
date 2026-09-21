import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { JwtApiKeyPayload, JwtPayload, JwtType } from '../dto/jwt-payload';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { SessionActivityService } from '../../session/session-activity.service';
import { FastifyRequest } from 'fastify';
import {
  extractBearerTokenFromHeader,
  isUserDisabled,
} from '../../../common/helpers';
import { resolveProvenance } from '../../../common/decorators/auth-provenance.decorator';
import { ApiKeyService } from '../../api-key/api-key.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private userRepo: UserRepo,
    private workspaceRepo: WorkspaceRepo,
    private userSessionRepo: UserSessionRepo,
    private sessionActivityService: SessionActivityService,
    private readonly environmentService: EnvironmentService,
    private readonly apiKeyService: ApiKeyService,
  ) {
    super({
      jwtFromRequest: (req: FastifyRequest) => {
        return req.cookies?.authToken || extractBearerTokenFromHeader(req);
      },
      ignoreExpiration: false,
      secretOrKey: environmentService.getAppSecret(),
      passReqToCallback: true,
    });
  }

  async validate(req: any, payload: JwtPayload | JwtApiKeyPayload) {
    if (!payload.workspaceId) {
      throw new UnauthorizedException();
    }

    if (req.raw.workspaceId && req.raw.workspaceId !== payload.workspaceId) {
      throw new UnauthorizedException('Workspace does not match');
    }

    if (payload.type === JwtType.API_KEY) {
      return this.validateApiKey(req, payload as JwtApiKeyPayload);
    }

    if (payload.type !== JwtType.ACCESS) {
      throw new UnauthorizedException();
    }

    // #348 — reuse the workspace DomainMiddleware already loaded for this request
    // instead of re-querying it. `validate()` above has confirmed
    // `req.raw.workspaceId === payload.workspaceId` (or that it is unset), and the
    // middleware sets `req.raw.workspace` alongside `req.raw.workspaceId` from the
    // SAME workspace row, so when the ids match this is that row. NOTE it is the
    // middleware's `selectAll` object (a superset of the fallback `findById` base
    // fields — it also carries licenseKey/auditRetentionDays); that is harmless
    // here because every consumer reads this workspace via the AuthWorkspace
    // decorator, which already preferred `req.raw.workspace` (the selectAll object)
    // over `req.user.workspace` before this change. Fall back to the query if the
    // middleware did not populate it (a path that bypasses DomainMiddleware).
    const workspace =
      req.raw.workspace && req.raw.workspaceId === payload.workspaceId
        ? req.raw.workspace
        : await this.workspaceRepo.findById(payload.workspaceId);

    if (!workspace) {
      throw new UnauthorizedException();
    }
    const user = await this.userRepo.findById(
      payload.sub,
      payload.workspaceId,
      {
        includeIsAgent: true,
      },
    );

    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    if ((payload as JwtPayload).sessionId) {
      const sessionId = (payload as JwtPayload).sessionId;
      const session = await this.userSessionRepo.findActiveById(sessionId);
      if (
        !session ||
        session.userId !== payload.sub ||
        session.workspaceId !== payload.workspaceId
      ) {
        throw new UnauthorizedException();
      }
      req.raw.sessionId = sessionId;
      this.sessionActivityService.trackActivity(
        sessionId,
        payload.sub,
        payload.workspaceId,
      );
    }

    // Propagate the agent-edit provenance onto the request so REST
    // services/controllers can set the 'agent' marker off it. Derived from the
    // SIGNED server-side identity via the shared resolver (also used by the
    // collab seam, so the two never drift), never from a client body field — so
    // an is_agent service account stamps every REST write made with an access
    // token, and a normal user cannot fake an 'agent' badge.
    const provenance = resolveProvenance(user, payload as JwtPayload);
    req.raw.actor = provenance.actor;
    req.raw.aiChatId = provenance.aiChatId;

    return { user, workspace };
  }

  private async validateApiKey(req: any, payload: JwtApiKeyPayload) {
    // The fork ships the core `ApiKeyService` (the EE `ee/api-key` module is
    // absent). `validate` throws a bare UnauthorizedException on any definite
    // deny (missing/revoked/expired row, disabled user, kill-switch off) and
    // propagates infra errors (→ 5xx) rather than masking them as a 401.
    const result = await this.apiKeyService.validate(payload);

    // Stamp the principal kind + key id so the /api-keys management surface can
    // enforce "a token cannot manage tokens". Done in this branch because it
    // returns before the shared ACCESS-path stamping below.
    req.raw.authType = 'api_key';
    req.raw.apiKeyId = payload.apiKeyId;

    // Stamp the agent-edit provenance for the API-KEY path too (#486, #559).
    // Unlike the access-token path above, it CANNOT be resolved before this point:
    // the API-key payload carries no signed actor/aiChatId claim, and the user is
    // unknown until the key is validated. #559 — EVERY api-key write is now an
    // EXTERNAL MCP write: passing the verified `payload.apiKeyId` makes
    // resolveProvenance stamp actor='agent' even for an ordinary user's PERSONAL
    // key (intentional — the access is programmatic via api_key, so it is
    // attributed to the "External MCP" persona named after the key, not shown as
    // the human). An API key has no internal ai_chats row, so aiChatId stays null;
    // the key id is what distinguishes the persona. Derived from the SERVER-side
    // identity + the verified key id (never a client field), so unspoofable.
    const provenance = resolveProvenance(result.user, null, payload.apiKeyId);
    req.raw.actor = provenance.actor;
    req.raw.aiChatId = provenance.aiChatId;

    return result;
  }
}
