import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import { AI_CHAT_THROTTLER } from '../../integrations/throttle/throttler-names';
import { AiChatService, AiChatStreamBody } from './ai-chat.service';
import {
  ChatIdDto,
  GetChatMessagesDto,
  RenameChatDto,
} from './dto/ai-chat.dto';

/**
 * Per-user AI chat API (§6.1). Routes are POST to match this codebase's
 * convention (it uses POST for reads too). Everything is workspace-scoped and
 * limited to chats the requesting user created.
 */
@UseGuards(JwtAuthGuard)
@Controller('ai-chat')
export class AiChatController {
  private readonly logger = new Logger(AiChatController.name);

  constructor(
    private readonly aiChatService: AiChatService,
    private readonly aiChatRepo: AiChatRepo,
    private readonly aiChatMessageRepo: AiChatMessageRepo,
  ) {}

  /** List the requesting user's chats in this workspace (paginated). */
  @HttpCode(HttpStatus.OK)
  @Post('chats')
  async listChats(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatRepo.findByCreator(user.id, workspace.id, pagination);
  }

  /** Fetch the messages of a chat (oldest first, paginated). */
  @HttpCode(HttpStatus.OK)
  @Post('messages')
  async getMessages(
    @Body() dto: GetChatMessagesDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertOwnedChat(dto.chatId, user, workspace);
    return this.aiChatMessageRepo.findByChat(
      dto.chatId,
      workspace.id,
      pagination,
    );
  }

  /** Rename a chat. */
  @HttpCode(HttpStatus.OK)
  @Post('rename')
  async rename(
    @Body() dto: RenameChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertOwnedChat(dto.chatId, user, workspace);
    await this.aiChatRepo.update(dto.chatId, { title: dto.title }, workspace.id);
    return { success: true };
  }

  /** Soft-delete a chat. */
  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async remove(
    @Body() dto: ChatIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertOwnedChat(dto.chatId, user, workspace);
    await this.aiChatRepo.softDelete(dto.chatId, workspace.id);
    return { success: true };
  }

  /**
   * Stream an agent turn. The useChat payload is read straight off `req.body`
   * (binding a strict DTO would let the global ValidationPipe whitelist strip
   * useChat fields).
   *
   * Ordering matters: feature gating (A7) and model resolution happen BEFORE
   * `res.hijack()`, so a disabled feature (403) or an unconfigured provider
   * (503) returns clean JSON. Only once we are committed to streaming do we
   * hijack and hand off to the service.
   */
  @SkipTransform()
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [AI_CHAT_THROTTLER]: { limit: 25, ttl: 60000 } })
  @Post('stream')
  async stream(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    // A7 gate: the workspace must have AI chat explicitly enabled.
    const settings = (workspace.settings ?? {}) as { ai?: { chat?: boolean } };
    if (settings.ai?.chat !== true) {
      throw new ForbiddenException('AI chat is disabled');
    }

    const sessionId = (req.raw as { sessionId?: string }).sessionId;
    if (!sessionId) {
      // The chat requires an interactive session to mint loopback tokens
      // (§15[C1]); Bearer/API-key requests without a session are rejected.
      throw new ForbiddenException('AI chat requires an interactive session');
    }

    const body = (req.body ?? {}) as AiChatStreamBody;

    // Resolve the model BEFORE hijack so an unconfigured provider returns a
    // clean JSON 503 (AiNotConfiguredException is a 503 HttpException; letting
    // it propagate here yields a normal response, not a broken stream).
    const model = await this.aiChatService.getChatModel(workspace.id);

    // Abort the agent loop when the client disconnects. `close` also fires on
    // normal completion, so only abort when the response has not finished
    // writing (a genuine disconnect). `once` fires at most once and self-removes;
    // we also drop it on response `finish` so it never lingers after the stream
    // completes normally (the AI SDK pipes the response fire-and-forget, so we
    // cannot simply remove it once `stream()` returns).
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.raw.writableEnded) controller.abort();
    };
    req.raw.once('close', onClose);
    res.raw.once('finish', () => req.raw.off('close', onClose));

    // Commit to streaming: hijack so Fastify stops managing the response and
    // the AI SDK can write the UI-message stream directly to the Node socket.
    res.hijack();

    try {
      await this.aiChatService.stream({
        user,
        workspace,
        sessionId,
        body,
        res,
        signal: controller.signal,
        model,
      });
    } catch (err) {
      // Any failure AFTER hijack can no longer send a clean JSON error, so emit
      // a minimal error on the raw socket if nothing has been written yet.
      this.logger.error('AI chat stream failed', err as Error);
      if (!res.raw.headersSent) {
        res.raw.statusCode = 500;
        res.raw.setHeader('Content-Type', 'application/json');
        res.raw.end(JSON.stringify({ error: 'Internal server error' }));
      } else if (!res.raw.writableEnded) {
        res.raw.end();
      }
    }
  }

  /**
   * Ensure the chat exists, belongs to this workspace, AND was created by the
   * requesting user (per-user isolation). Throws ForbiddenException otherwise.
   */
  private async assertOwnedChat(
    chatId: string,
    user: User,
    workspace: Workspace,
  ): Promise<void> {
    const chat = await this.aiChatRepo.findById(chatId, workspace.id);
    if (!chat || chat.creatorId !== user.id) {
      throw new ForbiddenException();
    }
  }
}
