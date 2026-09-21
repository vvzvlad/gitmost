import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  JwtApiKeyPayload,
  JwtAttachmentPayload,
  JwtCollabPayload,
  JwtExchangePayload,
  JwtMfaTokenPayload,
  JwtPayload,
  JwtPdfExportDownloadPayload,
  JwtPdfRenderPayload,
  JwtType,
} from '../dto/jwt-payload';
import { User } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../../common/helpers';

@Injectable()
export class TokenService {
  constructor(
    private jwtService: JwtService,
    private environmentService: EnvironmentService,
  ) {}

  async generateAccessToken(
    user: User,
    sessionId: string,
    // Optional agent-edit provenance. When omitted (the normal user path), the
    // token carries no actor/aiChatId and is treated as 'user' downstream. The
    // internal agent passes { actor:'agent', aiChatId } so REST writes record a
    // non-spoofable 'agent' marker off the signed claim (§6.5 / §15 C3 / §14 N2).
    // aiChatId is nullable: an external MCP agent has no internal ai_chats row,
    // so it stamps 'agent' with a null aiChatId.
    provenance?: { actor: 'agent'; aiChatId: string | null },
  ): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      workspaceId: user.workspaceId,
      type: JwtType.ACCESS,
      sessionId,
      ...(provenance
        ? { actor: provenance.actor, aiChatId: provenance.aiChatId }
        : {}),
    };
    return this.jwtService.sign(payload);
  }

  async generateCollabToken(
    user: User,
    workspaceId: string,
    // Optional agent-edit provenance. When omitted (the human collab path), the
    // token carries no actor/aiChatId and is treated as 'user' downstream.
    // aiChatId is nullable for an external agent with no internal ai_chats row.
    provenance?: { actor: 'agent'; aiChatId: string | null },
    // Optional api-key origin (#501). When the collab token is minted by an
    // api-key principal (an external MCP agent), the caller passes the key id so
    // the token carries principal='api_key' + apiKeyId and the collab seam can
    // re-check the key on connect. Absent -> principal='session' (a normal
    // user/session, including the internal session-backed AI agent).
    apiKey?: { apiKeyId: string },
  ): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtCollabPayload = {
      sub: user.id,
      workspaceId,
      type: JwtType.COLLAB,
      // Fail-closed discriminator on EVERY minted token: 'api_key' when minted by
      // an api-key principal, else 'session'.
      principal: apiKey ? 'api_key' : 'session',
      ...(apiKey ? { apiKeyId: apiKey.apiKeyId } : {}),
      ...(provenance
        ? { actor: provenance.actor, aiChatId: provenance.aiChatId }
        : {}),
    };
    const expiresIn = '24h';
    return this.jwtService.sign(payload, { expiresIn });
  }

  async generateExchangeToken(
    userId: string,
    workspaceId: string,
  ): Promise<string> {
    const payload: JwtExchangePayload = {
      sub: userId,
      workspaceId: workspaceId,
      type: JwtType.EXCHANGE,
    };
    return this.jwtService.sign(payload, { expiresIn: '10s' });
  }

  async generateAttachmentToken(opts: {
    attachmentId: string;
    pageId: string;
    workspaceId: string;
  }): Promise<string> {
    const { attachmentId, pageId, workspaceId } = opts;
    const payload: JwtAttachmentPayload = {
      attachmentId: attachmentId,
      pageId: pageId,
      workspaceId: workspaceId,
      type: JwtType.ATTACHMENT,
    };
    return this.jwtService.sign(payload, { expiresIn: '1h' });
  }

  async generateMfaToken(user: User, workspaceId: string): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtMfaTokenPayload = {
      sub: user.id,
      workspaceId,
      type: JwtType.MFA_TOKEN,
    };
    return this.jwtService.sign(payload, { expiresIn: '5m' });
  }

  async generateApiToken(opts: {
    apiKeyId: string;
    user: User;
    workspaceId: string;
  }): Promise<string> {
    const { apiKeyId, user, workspaceId } = opts;
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtApiKeyPayload = {
      sub: user.id,
      apiKeyId: apiKeyId,
      workspaceId,
      type: JwtType.API_KEY,
    };

    // API-key tokens carry NO `exp` claim EVER — the ONLY source of truth for a
    // key's lifetime and revocation is its `api_keys` row (checked on every
    // request), not the JWT. This CANNOT use `this.jwtService`: TokenModule
    // registers it with a global `signOptions.expiresIn` (JWT_TOKEN_EXPIRES_IN,
    // default '90d'), which merges into EVERY sign() call — even `sign(payload,
    // {})` — and `{ expiresIn: undefined }` THROWS rather than stripping it
    // (verified empirically). So an "unlimited" key minted through the shared
    // signer would silently get exp=now+90d and die in 90 days regardless of its
    // row. We mint through a dedicated no-expiry signer, re-stamping only
    // `issuer: 'Docmost'` for claim parity with the shared signer.
    //
    // The dedicated signer ALSO sets `noTimestamp: true`, so the token carries
    // neither `exp` nor `iat`. The payload is a fixed literal { sub, apiKeyId,
    // workspaceId, type } in a stable order, so the HS256 signature is a pure
    // deterministic function of (sub, apiKeyId, workspaceId, APP_SECRET): minting
    // the SAME key twice yields a BYTE-IDENTICAL token. This is what makes the key
    // "copyable" — the reveal endpoint (#557) re-mints the same value under a
    // step-up without ever persisting the token material.
    return this.apiKeyJwtService().sign(payload);
  }

  // Lazily-built JWT signer for API-key tokens: same APP_SECRET, same 'Docmost'
  // issuer, but WITHOUT the global `expiresIn` — so minted API-key tokens have no
  // `exp` claim. `noTimestamp: true` additionally suppresses the default `iat`
  // claim jsonwebtoken would otherwise add, making the minted token a fully
  // deterministic function of its payload + secret (byte-identical re-mints, the
  // basis of the copyable/reveal flow). Built once and cached. Verification still
  // goes through the shared verifier (same secret); `verifyAsync` does not
  // require an `exp` or `iat`.
  private _apiKeyJwtService?: JwtService;
  private apiKeyJwtService(): JwtService {
    if (!this._apiKeyJwtService) {
      this._apiKeyJwtService = new JwtService({
        secret: this.environmentService.getAppSecret(),
        signOptions: { issuer: 'Docmost', noTimestamp: true },
      });
    }
    return this._apiKeyJwtService;
  }

  async generatePdfRenderToken(
    pageId: string,
    workspaceId: string,
  ): Promise<string> {
    const payload: JwtPdfRenderPayload = {
      pageId,
      workspaceId,
      type: JwtType.PDF_RENDER,
    };
    return this.jwtService.sign(payload, { expiresIn: '60s' });
  }

  async generatePdfExportDownloadToken(
    fileTaskId: string,
    workspaceId: string,
  ): Promise<string> {
    const payload: JwtPdfExportDownloadPayload = {
      fileTaskId,
      workspaceId,
      type: JwtType.PDF_EXPORT_DOWNLOAD,
    };
    return this.jwtService.sign(payload, { expiresIn: '1h' });
  }

  async verifyJwt(token: string, tokenType: string) {
    const payload = await this.jwtService.verifyAsync(token, {
      secret: this.environmentService.getAppSecret(),
    });

    if (payload.type !== tokenType) {
      throw new UnauthorizedException(
        'Invalid JWT token. Token type does not match.',
      );
    }

    return payload;
  }

  /**
   * Verify a token's signature ONCE and assert its `type` is one of `allowed`.
   *
   * This is the type-routing primitive for surfaces that pin the Bearer slot to
   * an explicit token-type allowlist. The /mcp Bearer path pins that allowlist to
   * `[API_KEY]` only (#558 — /mcp no longer accepts a human-session ACCESS token
   * or any other type). It is deliberately NOT a
   * "verify-and-return-whatever-type" helper — that would be a reusable
   * confused-deputy footgun (any caller could then feed an attachment/collab
   * token where an access token is expected). An explicit allowlist preserves
   * the type-pinning property of `verifyJwt`: a token whose `type` is not in the
   * allowlist is rejected with the SAME generic error as a type mismatch, and
   * the signature is verified exactly once (no double-verify).
   */
  async verifyJwtOneOf(token: string, allowed: JwtType[]) {
    const payload = await this.jwtService.verifyAsync(token, {
      secret: this.environmentService.getAppSecret(),
    });

    if (!allowed.includes(payload.type)) {
      throw new UnauthorizedException(
        'Invalid JWT token. Token type does not match.',
      );
    }

    return payload;
  }
}
