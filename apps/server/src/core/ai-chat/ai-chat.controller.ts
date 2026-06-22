import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
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
import { FileInterceptor } from '../../common/interceptors/file.interceptor';
import { AiChatService, AiChatStreamBody } from './ai-chat.service';
import { AiTranscriptionService } from './ai-transcription.service';
import {
  ChatIdDto,
  GetChatMessagesDto,
  RenameChatDto,
} from './dto/ai-chat.dto';
import { describeProviderError } from '../../integrations/ai/ai-error.util';

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
    private readonly aiTranscription: AiTranscriptionService,
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

    // Resolve the agent role for this turn BEFORE hijack: existing chats read it
    // from ai_chats.role_id (authoritative), a new chat from body.roleId. The
    // role drives both the persona and the optional model override below.
    const role = await this.aiChatService.resolveRoleForRequest(workspace, body);

    // Resolve the model (applying the role's optional override) BEFORE hijack so
    // an unconfigured provider — including a role pointing at an unconfigured
    // driver — returns a clean JSON 503 (AiNotConfiguredException is a 503
    // HttpException) instead of breaking mid-stream.
    const model = await this.aiChatService.getChatModel(workspace.id, role);

    // Abort the agent loop when the client disconnects. `close` also fires on
    // normal completion, so only abort when the response has not finished
    // writing (a genuine disconnect). `once` fires at most once and self-removes;
    // we also drop it on response `finish` so it never lingers after the stream
    // completes normally (the AI SDK pipes the response fire-and-forget, so we
    // cannot simply remove it once `stream()` returns).
    const controller = new AbortController();
    const onClose = (): void => {
      // A genuine disconnect leaves the response unfinished (unlike a normal
      // completion, which also fires `close`). Such a drop — e.g. a reverse
      // proxy cutting the SSE mid-answer — is otherwise invisible server-side,
      // so log it here before aborting the agent loop.
      if (!res.raw.writableEnded) {
        this.logger.warn(
          'AI chat stream: client disconnected before completion; aborting turn',
        );
        controller.abort();
      }
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
        role,
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
   * Transcribe an uploaded audio clip to text using the workspace STT model.
   * Gated by settings.ai.dictation (403 when disabled). Returns { text }.
   */
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [AI_CHAT_THROTTLER]: { limit: 20, ttl: 60000 } })
  @Post('transcribe')
  @UseInterceptors(FileInterceptor)
  async transcribe(
    @Req() req: any,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ text: string }> {
    // Gate: dictation must be explicitly enabled for the workspace.
    const settings = (workspace.settings ?? {}) as {
      ai?: { dictation?: boolean };
    };
    if (settings.ai?.dictation !== true) {
      throw new ForbiddenException('Dictation is disabled');
    }

    let file = null;
    try {
      // Whisper hard-caps uploads at 25MB; allow a single file.
      file = await req.file({ limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
    } catch (err: any) {
      if (err?.statusCode === 413) {
        throw new BadRequestException('Audio file too large (max 25MB)');
      }
      throw err;
    }
    if (!file) throw new BadRequestException('No audio uploaded');

    // Resolve + whitelist the upload's container type (MediaRecorder mimetypes
    // carry parameters, e.g. "audio/webm;codecs=opus"). A non-whitelisted type
    // is rejected; an allowed one yields the STT container-format hint.
    const resolved = resolveAudioFormat(file.mimetype);
    if (!resolved.ok) {
      throw new BadRequestException('Unsupported audio format');
    }
    const { format } = resolved;

    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch (err: any) {
      // With @fastify/multipart throwFileSizeLimit:true, the 25MB cap is enforced
      // when the stream is consumed (here), not at req.file().
      if (err?.statusCode === 413) {
        throw new BadRequestException('Audio file too large (max 25MB)');
      }
      throw err;
    }
    let text: string;
    try {
      text = await this.aiTranscription.transcribe(workspace.id, buf, format);
    } catch (err) {
      // Preserve meaningful HTTP errors (e.g. AiSttNotConfiguredException -> 503).
      if (err instanceof HttpException) throw err;
      // Log the full error and surface the real provider/transport reason instead
      // of an opaque 500 (e.g. "the STT endpoint returned 404 ...").
      this.logger.error('AI transcription failed', err as Error);
      throw new ServiceUnavailableException(describeProviderError(err));
    }
    return { text };
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

/**
 * Whitelist audio container types produced by browser MediaRecorder (Chrome/FF:
 * webm/opus, Safari: mp4) plus common STT-accepted formats. The value maps each
 * allowed base mime to the container-format hint passed to JSON-style STT
 * providers (e.g. OpenRouter); multipart endpoints ignore the hint.
 */
const AUDIO_FORMAT_MAP: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
};

/**
 * Resolve and whitelist an uploaded clip's mimetype. MediaRecorder mimetypes
 * carry parameters (e.g. "audio/webm;codecs=opus"), so the base type is split
 * out (lowercased, trimmed) before the whitelist check. Returns ok=false for a
 * non-whitelisted container; otherwise the base mime and its STT format hint.
 * Pure — the caller throws BadRequestException on !ok.
 */
export function resolveAudioFormat(
  mimetype: string,
): { ok: true; baseMime: string; format: string } | { ok: false } {
  const baseMime = mimetype.split(';')[0].trim().toLowerCase();
  const format = AUDIO_FORMAT_MAP[baseMime];
  if (format === undefined) {
    return { ok: false };
  }
  return { ok: true, baseMime, format };
}
