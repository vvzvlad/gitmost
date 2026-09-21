import { Extension, onAuthenticatePayload } from '@hocuspocus/server';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import { SpaceRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { getPageId } from '../collaboration.util';
import {
  JwtApiKeyPayload,
  JwtCollabPayload,
  JwtType,
} from '../../core/auth/dto/jwt-payload';
import { resolveProvenance } from '../../common/decorators/auth-provenance.decorator';
import { observeCollabAuth } from '../../integrations/metrics/metrics.registry';
import { ApiKeyService } from '../../core/api-key/api-key.service';

// Max lifetime of a collab token (generateCollabToken uses expiresIn '24h'). Used
// as the rollout grace window below: once this long has elapsed since this
// process started serving the #501 code, every STILL-VALID collab token was
// necessarily minted post-rollout and MUST carry the `principal` discriminator,
// so a claimless one is a bug and is rejected (fail-closed) rather than trusted.
const COLLAB_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthenticationExtension implements Extension {
  private readonly logger = new Logger(AuthenticationExtension.name);

  // Reference instant for the claimless-rejection grace window. Overridable so a
  // unit test can drive the pre-/post-grace boundary without wall-clock waits.
  protected rolloutAt = Date.now();

  constructor(
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  async onAuthenticate(data: onAuthenticatePayload) {
    // #402 — time the whole auth (verify + user/page/permission lookups) into
    // collab_auth_duration_seconds. finally so failed auths are timed too.
    // No-op when METRICS_PORT is unset. Behavior unchanged.
    const start = performance.now();
    try {
      return await this.doAuthenticate(data);
    } finally {
      observeCollabAuth((performance.now() - start) / 1000);
    }
  }

  private async doAuthenticate(data: onAuthenticatePayload) {
    const { documentName, token } = data;
    const pageId = getPageId(documentName);

    let jwtPayload: JwtCollabPayload;

    try {
      jwtPayload = await this.tokenService.verifyJwt(token, JwtType.COLLAB);
    } catch (error) {
      throw new UnauthorizedException('Invalid collab token');
    }

    // #501 — fail-closed api-key laundering guard. A collab token minted by an
    // api-key principal carries principal='api_key' + apiKeyId; re-check the key
    // on connect so a REVOKED key gets NO new collab connections (a collab token
    // outlives its 24h, but a revoked key can no longer open fresh ones). An
    // api-key token missing its apiKeyId is malformed → reject. A claimless token
    // (no recognized principal) is trusted only DURING the rollout grace window
    // (a legacy pre-rollout session token, which api keys could never mint);
    // once the grace has elapsed every valid token must carry the discriminator,
    // so a claimless one is a bug and is rejected (not silently trusted for 24h).
    const principal = jwtPayload.principal;
    if (principal === 'api_key') {
      if (!jwtPayload.apiKeyId) {
        throw new UnauthorizedException();
      }
      // Row-check via the SHARED validator: throws Unauthorized on a revoked/
      // expired/disabled key; an infra error propagates (not masked). No new
      // connection for a dead key.
      await this.apiKeyService.validate({
        sub: jwtPayload.sub,
        workspaceId: jwtPayload.workspaceId,
        apiKeyId: jwtPayload.apiKeyId,
        type: JwtType.API_KEY,
      } as JwtApiKeyPayload);
    } else if (principal !== 'session') {
      // Unrecognized/absent discriminator: reject once past the grace window.
      if (Date.now() - this.rolloutAt >= COLLAB_TOKEN_GRACE_MS) {
        throw new UnauthorizedException();
      }
    }

    const userId = jwtPayload.sub;
    const workspaceId = jwtPayload.workspaceId;

    const user = await this.userRepo.findById(userId, workspaceId, {
      includeIsAgent: true,
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    if (isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      this.logger.debug(`Page not found: ${pageId}`);
      throw new NotFoundException('Page not found');
    }

    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      user.id,
      page.spaceId,
    );

    const userSpaceRole = findHighestUserSpaceRole(userSpaceRoles);

    if (!userSpaceRole) {
      this.logger.warn(`User not authorized to access page: ${pageId}`);
      throw new UnauthorizedException();
    }

    // Check page-level permissions
    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction) {
      if (!canAccess) {
        this.logger.warn(
          `User ${user.id} denied page-level access to page: ${pageId}`,
        );
        throw new UnauthorizedException();
      }

      if (!canEdit) {
        data.connectionConfig.readOnly = true;
        this.logger.debug(
          `User ${user.id} granted readonly access to restricted page: ${pageId}`,
        );
      }
    } else {
      // No restrictions - use space-level permissions
      if (userSpaceRole === SpaceRole.READER) {
        data.connectionConfig.readOnly = true;
        this.logger.debug(`User granted readonly access to page: ${pageId}`);
      }
    }

    if (page.deletedAt) {
      data.connectionConfig.readOnly = true;
    }

    this.logger.debug(`Authenticated user ${user.id} on page ${pageId}`);

    // Carry the agent-edit provenance into the hocuspocus connection context
    // (§6.6 / §15 C2), derived via the SAME resolver as the REST seam so the two
    // can't drift. An is_agent service account (e.g. the MCP bot) is attributed
    // 'agent' here too, so its page-content edits over collab persist as
    // lastUpdatedSource='agent' (#143 review Arch A) — not just its REST writes.
    // #559 — a collab token minted by an api-key principal (an EXTERNAL MCP agent)
    // carries principal='api_key' + apiKeyId (verified above) but no actor claim;
    // threading `jwtPayload.apiKeyId` makes resolveProvenance stamp actor='agent'
    // (even for an ordinary user's personal key) and carries the key id into the
    // context so persistence.extension can persist last_updated_api_key_id and
    // the page shows the "External MCP" persona named after the key.
    // The human collab path carries no claim and is not flagged → actor='user'.
    const provenance = resolveProvenance(user, jwtPayload, jwtPayload.apiKeyId);
    return {
      user,
      actor: provenance.actor,
      aiChatId: provenance.aiChatId,
      apiKeyId: provenance.apiKeyId,
    };
  }
}
