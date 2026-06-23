import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
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
  ): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtCollabPayload = {
      sub: user.id,
      workspaceId,
      type: JwtType.COLLAB,
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
    expiresIn?: StringValue | number;
  }): Promise<string> {
    const { apiKeyId, user, workspaceId, expiresIn } = opts;
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtApiKeyPayload = {
      sub: user.id,
      apiKeyId: apiKeyId,
      workspaceId,
      type: JwtType.API_KEY,
    };

    return this.jwtService.sign(payload, expiresIn ? { expiresIn } : {});
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
}
