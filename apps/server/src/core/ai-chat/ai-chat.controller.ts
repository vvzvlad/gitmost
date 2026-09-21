import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import {
  AiChat,
  AiChatMessage,
  AiChatRun,
  User,
  Workspace,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { AiChatRunStepRepo } from '@docmost/db/repos/ai-chat/ai-chat-run-step.repo';
import { AiChatPageBindingRepo } from '@docmost/db/repos/ai-chat/ai-chat-page-binding.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { incAiChatBindSkipped } from '../../integrations/metrics/metrics.registry';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import { AI_CHAT_THROTTLER } from '../../integrations/throttle/throttler-names';
import { FileInterceptor } from '../../common/interceptors/file.interceptor';
import {
  AiChatRunHooks,
  AiChatService,
  AiChatStreamBody,
  rowHasInlineParts,
  hydrateAssistantParts,
} from './ai-chat.service';
import { AiChatRunService } from './ai-chat-run.service';
import { AiTranscriptionService } from './ai-transcription.service';
import {
  BindPageDto,
  BoundChatDto,
  ChatIdDto,
  ExportChatDto,
  GeneratePageTitleDto,
  GetChatDeltaDto,
  GetChatMessagesDto,
  GetRunDto,
  RenameChatDto,
  StopRunDto,
} from './dto/ai-chat.dto';
import { describeProviderError } from '../../integrations/ai/ai-error.util';
import { buildChatMarkdown } from './chat-markdown.util';
import {
  AiChatStreamRegistryService,
  SUBSCRIBER_MAX_BUFFERED_BYTES,
} from './ai-chat-stream-registry.service';
import { startSseHeartbeat } from './sse-resilience';

/**
 * Write the attach TAIL to the hijacked socket in chunks that RESPECT drain
 * (#491): each `write()` that returns false (the kernel buffer is full) is awaited
 * on the next 'drain' before continuing. The old code wrote the whole buffer
 * synchronously, which — with the pre-#491 32MB ring — spiked memory (half the
 * OOM). Bails immediately if the socket ended/errored mid-write. Frames that the
 * paused registry subscriber buffers while this awaits are delivered by start().
 */
async function writeTailRespectingDrain(
  raw: {
    write(chunk: string): boolean;
    writableEnded?: boolean;
    destroyed?: boolean;
    once(event: string, cb: () => void): unknown;
    removeListener?(event: string, cb: () => void): unknown;
  },
  frames: string[],
): Promise<void> {
  for (const frame of frames) {
    if (raw.writableEnded || raw.destroyed) return;
    const ok = raw.write(frame);
    if (!ok) {
      // Kernel buffer full — wait for drain (or an early close/error) before the
      // next chunk, so a slow reader never forces the whole tail into memory.
      // Remove ALL three listeners once any fires, so a many-chunk tail with
      // repeated backpressure never leaks (MaxListenersExceededWarning).
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          raw.removeListener?.('drain', finish);
          raw.removeListener?.('close', finish);
          raw.removeListener?.('error', finish);
          resolve();
        };
        raw.once('drain', finish);
        raw.once('close', finish);
        raw.once('error', finish);
      });
    }
  }
}
import { EnvironmentService } from '../../integrations/environment/environment.service';

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
    private readonly aiChatRunService: AiChatRunService,
    private readonly aiChatRepo: AiChatRepo,
    private readonly aiChatMessageRepo: AiChatMessageRepo,
    private readonly aiTranscription: AiTranscriptionService,
    private readonly pageRepo: PageRepo,
    // #184 phase 1.5. OPTIONAL so existing positional constructions (controller
    // specs) compile unchanged; Nest always injects the real providers in
    // production. Only touched on the resumable-stream (flag-on) path.
    private readonly streamRegistry?: AiChatStreamRegistryService,
    private readonly environment?: EnvironmentService,
    // #492: reconstruct a #492 mid-run record's parts from the steps table before
    // returning rows to the client / export. OPTIONAL so positional controller
    // specs compile unchanged; when absent, hydration is skipped (old-era rows
    // already carry inline parts, so nothing to reconstruct).
    private readonly aiChatRunStepRepo?: AiChatRunStepRepo,
    // #665: the mutable page->chat binding repo, behind bound-chat (read) and
    // bind-page (write). OPTIONAL so existing positional controller specs compile
    // unchanged; Nest always injects the real singleton in production.
    private readonly aiChatPageBindingRepo?: AiChatPageBindingRepo,
  ) {}

  /**
   * Reconstruct parts for any assistant rows that don't carry them INLINE — a
   * #492 mid-run record whose per-step parts live in `ai_chat_run_steps` (the
   * append-persist backend). Every FINISHED row (old-era + #492) and every old-era
   * streaming snapshot already has inline `metadata.parts`, so the common path
   * fetches NOTHING and returns the rows untouched; only an actively-streaming
   * new-style row triggers the batch step fetch. Consumers (seed/poll/export) read
   * `metadata.parts` off the returned rows exactly as before — the era switch is
   * invisible to them (reconstructRunParts contract).
   */
  private async withReconstructedParts(
    rows: AiChatMessage[],
    workspaceId: string,
  ): Promise<AiChatMessage[]> {
    if (!this.aiChatRunStepRepo) return rows;
    const needy = rows.filter(
      (r) => r.role === 'assistant' && !rowHasInlineParts(r),
    );
    if (needy.length === 0) return rows;
    const stepsByMessage = await this.aiChatRunStepRepo.findByMessageIds(
      needy.map((r) => r.id),
      workspaceId,
    );
    return hydrateAssistantParts(rows, stepsByMessage);
  }

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

  /**
   * Resolve the chat bound to a document for the requesting user (#665): the chat
   * the `ai_chat_page_bindings` pointer holds for (user, page). Returns
   * { chatId: null } when nothing is bound (-> a fresh empty chat). There is NO
   * fallback to the retired #191 findLatestByPage heuristic — after "New chat" the
   * binding row is gone, and a fallback would resurrect the unbound chat.
   *
   * `dto.pageId` carries EITHER a page slugId (10-char nanoid, sent by the client
   * off a slug URL) OR a page uuid, so it must be resolved to a real page uuid
   * before it touches the uuid page_id column — passing a slugId straight through
   * triggered a Postgres 22P02 "invalid input syntax for type uuid" 500 (#312).
   * PageRepo.findById accepts both forms. The workspace guard rejects an unknown or
   * cross-workspace page (-> { chatId: null }) so a foreign id cannot probe another
   * workspace's chats. The binding resolver then re-checks chat ownership itself.
   */
  @HttpCode(HttpStatus.OK)
  @Post('bound-chat')
  async boundChat(
    @Body() dto: BoundChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ chatId: string | null }> {
    const page = await this.pageRepo.findById(dto.pageId); // accepts slugId OR uuid
    if (!page || page.workspaceId !== workspace.id) {
      return { chatId: null }; // unknown or foreign-workspace page — no binding, no leak
    }
    const chatId = await this.aiChatPageBindingRepo.findChatIdByPage(
      user.id,
      workspace.id,
      page.id, // the real uuid, never the incoming slugId
    );
    return { chatId };
  }

  /**
   * Move (or clear) the page->chat binding for the requesting user (#665). Called
   * on a CONSCIOUS open: the client's history select re-binds the page to the
   * chosen chat; "New chat" clears it (`chatId: null`). The header button and the
   * agent-badge deeplink deliberately do NOT call this.
   *
   * Binding is a convenience, not access control, so every "not applied" outcome is
   * a fail-SOFT `200 { chatId: null }` with NO write — but each one emits a WARN +
   * a bounded skip-counter, because otherwise a no-op is indistinguishable from a
   * success in the HTTP histogram. `dto.pageId` accepts a slugId OR uuid (resolved
   * before touching the uuid column, #312). A `chatId` that does not exist / is not
   * the caller's / left the workspace / is soft-deleted is fail-CLOSED: never write
   * a pointer to a chat the user does not own. The response body is a debug aid, NOT
   * a postcondition — the client ignores it and never blocks the UI on this call.
   */
  @HttpCode(HttpStatus.OK)
  @Post('bind-page')
  async bindPage(
    @Body() dto: BindPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ chatId: string | null }> {
    const page = await this.pageRepo.findById(dto.pageId); // accepts slugId OR uuid
    if (!page || page.workspaceId !== workspace.id) {
      // Unknown / foreign-workspace page: no write, existing binding untouched, no
      // probe of another workspace (mirrors boundChat).
      this.logger.warn(
        `bind-page skipped: page unresolved (user ${user.id}, reason=page_unresolved)`,
      );
      incAiChatBindSkipped('page_unresolved');
      return { chatId: null };
    }

    // Clear ("New chat").
    if (dto.chatId === null || dto.chatId === undefined) {
      await this.aiChatPageBindingRepo.clear(user.id, page.id);
      return { chatId: null };
    }

    // Re-bind: the chat must exist, be the caller's, in this workspace, and live.
    // findOwnershipById selects the ownership triple WITHOUT filtering so the three
    // failure modes stay distinguishable (a plain findById would collapse them into
    // one `undefined`, making the chat_deleted reason unobservable).
    const owned = await this.aiChatRepo.findOwnershipById(dto.chatId);
    if (
      !owned ||
      owned.creatorId !== user.id ||
      owned.workspaceId !== workspace.id
    ) {
      this.logger.warn(
        `bind-page skipped: chat ${dto.chatId} not owned by user ${user.id} (reason=chat_not_owned)`,
      );
      incAiChatBindSkipped('chat_not_owned');
      return { chatId: null };
    }
    if (owned.deletedAt !== null) {
      this.logger.warn(
        `bind-page skipped: chat ${dto.chatId} is deleted (reason=chat_deleted)`,
      );
      incAiChatBindSkipped('chat_deleted');
      return { chatId: null };
    }

    await this.aiChatPageBindingRepo.upsert(user.id, page.id, dto.chatId);
    return { chatId: dto.chatId };
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
    const page = await this.aiChatMessageRepo.findByChat(
      dto.chatId,
      workspace.id,
      pagination,
    );
    // #492: reconstruct parts for any active new-style row so the client seed sees
    // `metadata.parts` unchanged (a no-op for the finished rows that fill a page).
    return {
      ...page,
      items: await this.withReconstructedParts(page.items, workspace.id),
    };
  }

  /**
   * Delta poll (#491) — the degraded-poll fallback's payload. Returns the chat's
   * message rows changed since `cursor` (a DB-clock timestamp from the previous
   * poll), a FRESH cursor, AND the current run fact `{ id, status } | null`. This
   * replaces the old degraded poll that refetched ALL infinite-query pages (full
   * parts) every 2.5s: the client seeds once and thereafter merges only the
   * deltas by id (the overlap window guarantees repeats — the merge is idempotent,
   * see mergeById). The run fact rides IN the delta (a separate /run poll would
   * double the poll QPS), so the client FSM gets the run's status on the same tick.
   * Owner-gated via assertOwnedChat (same gate as the other read endpoints).
   */
  @HttpCode(HttpStatus.OK)
  @Post('messages/delta')
  async getMessagesDelta(
    @Body() dto: GetChatDeltaDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{
    rows: AiChatMessage[];
    cursor: string;
    run: { id: string; status: string } | null;
  }> {
    await this.assertOwnedChat(dto.chatId, user, workspace);
    const { rows, cursor } =
      await this.aiChatMessageRepo.findByChatUpdatedAfter(
        dto.chatId,
        workspace.id,
        dto.cursor ?? null,
      );
    const run = await this.aiChatRunService.getLatestForChat(
      dto.chatId,
      workspace.id,
    );
    return {
      // #492: the delta of an actively-streaming new-style row carries its parts
      // reconstructed from the steps table, so the degraded poll shows persisted
      // progress exactly as the pre-#492 full-row snapshot did.
      rows: await this.withReconstructedParts(rows, workspace.id),
      cursor,
      run: run ? { id: run.id, status: run.status } : null,
    };
  }

  /**
   * Export a chat to Markdown (#183). The DB is the single source of truth: the
   * whole transcript is loaded (oldest -> newest) and rendered server-side. Now
   * that the assistant row is persisted upfront and per step, an interrupted
   * turn is included up to its last finished step. Workspace-scoped and owner-
   * gated via assertOwnedChat (same as the other read endpoints). Returns
   * `{ markdown }`. `lang` localizes the few fixed labels (default English).
   */
  @HttpCode(HttpStatus.OK)
  @Post('export')
  async export(
    @Body() dto: ExportChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ markdown: string }> {
    const chat = await this.assertOwnedChat(dto.chatId, user, workspace);
    const rows = await this.withReconstructedParts(
      await this.aiChatMessageRepo.findAllByChat(dto.chatId, workspace.id),
      // #492: an interrupted-but-still-active turn exports its persisted steps
      // (reconstructed from the steps table) just like the pre-#492 full row did.
      workspace.id,
    );
    const markdown = buildChatMarkdown({
      title: chat.title ?? null,
      chatId: dto.chatId,
      rows,
      // normalizeLang(undefined) already yields 'en', so no `?? 'en'` is needed.
      lang: dto.lang,
    });
    return { markdown };
  }

  /**
   * Reconnect to the latest run of a chat (#184 phase 1). Returns the run's
   * persisted lifecycle state ({ status, error, stepCount, timings, ... }) plus
   * the assistant message it projects (the partial/final output) — the DB is the
   * source of truth, so this works for an in-flight run (the browser dropped, the
   * run kept going) and a finished one alike. Owner-gated via assertOwnedChat.
   * `{ run: null }` when the chat has never had a run.
   */
  @HttpCode(HttpStatus.OK)
  @Post('run')
  async getRun(
    @Body() dto: GetRunDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ run: AiChatRun | null; message: AiChatMessage | null }> {
    await this.assertOwnedChat(dto.chatId, user, workspace);
    const run = await this.aiChatRunService.getLatestForChat(
      dto.chatId,
      workspace.id,
    );
    if (!run) return { run: null, message: null };
    const message = run.assistantMessageId
      ? await this.aiChatMessageRepo.findById(
          run.assistantMessageId,
          workspace.id,
        )
      : undefined;
    // #492: reconnect to an IN-FLIGHT run reconstructs the projection row's parts
    // from the steps table (the row itself carries only the step marker mid-run);
    // a finished run's row already has inline parts, so this is a no-op.
    const [hydrated] = message
      ? await this.withReconstructedParts([message], workspace.id)
      : [undefined];
    return { run, message: hydrated ?? null };
  }

  /**
   * Explicitly STOP an agent run (#184 phase 1) — the user pressed Stop. This is
   * the ONLY thing that ends a detached run; a browser disconnect deliberately
   * does not. Target by `runId` (from the streamed start metadata) or by `chatId`
   * (stop whatever run is active on it). Owner-gated. Returns
   * `{ stopped }` — false when there was nothing active to stop.
   */
  @HttpCode(HttpStatus.OK)
  @Post('stop')
  async stopRun(
    @Body() dto: StopRunDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ stopped: boolean }> {
    let runId = dto.runId;
    if (!runId && !dto.chatId) {
      throw new BadRequestException('runId or chatId is required');
    }
    if (runId) {
      // Resolve the run to its chat and owner-gate via that chat.
      const run = await this.aiChatRunService.getRun(runId, workspace.id);
      if (!run) return { stopped: false };
      await this.assertOwnedChat(run.chatId, user, workspace);
    } else {
      await this.assertOwnedChat(dto.chatId!, user, workspace);
      const active = await this.aiChatRunService.getActiveForChat(
        dto.chatId!,
        workspace.id,
      );
      if (!active) return { stopped: false };
      runId = active.id;
    }
    const stopped = await this.aiChatRunService.requestStop(
      runId,
      workspace.id,
    );
    return { stopped };
  }

  /**
   * Attach to a chat's live run stream from the client's step frontier (#184 phase
   * 1.5, tail-only #491). A late/reloaded tab hands the server the step count it
   * has PERSISTED (`n` = the seeded row's `metadata.stepsPersisted`) and its
   * assistant row id (`anchor`); the registry answers with the TAIL past step `n`
   * (a synthetic `start` frame + the buffered frames stamped >= n) and then the
   * live tail. Owner-gated via assertOwnedChat (same gate as getRun). When there
   * is nothing to resume — no entry, a ring that does not cover the client's
   * frontier (overflow gap, or the client's seed lagged a rotation), or an anchor
   * that pins a DIFFERENT run (invariant 6) — the endpoint answers 204, the ONLY
   * "nothing to resume" signal the AI SDK's reconnect accepts (it maps 204 to a
   * silent no-op); the client then refetches (a larger n) and re-attaches. With
   * AI_CHAT_RESUMABLE_STREAM off the registry is never populated, so attach always
   * 204s.
   *
   * The step marker `n` comes ONLY from the client — the server never reads the
   * row to derive it, because a server-side n from a stale seed would open a
   * silent one-step hole. The tail is written to the socket in CHUNKS respecting
   * drain (writeTailRespectingDrain): the old code synchronously blasted the whole
   * buffer, which — with the old 32MB cap — was half the OOM.
   */
  @SkipTransform()
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [AI_CHAT_THROTTLER]: { limit: 60, ttl: 60000 } })
  @Get('runs/:chatId/stream')
  async attachRunStream(
    @Param('chatId', new ParseUUIDPipe()) chatId: string,
    @Query('anchor') anchor: string | undefined,
    @Query('n') n: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    await this.assertOwnedChat(chatId, user, workspace); // same gate as getRun
    // The client's persisted step frontier. #491: distinguish a MISSING/invalid `n`
    // (null — a NOT-tail-aware, legacy/parameterless tab expecting the old
    // "finished -> 204 -> poll" contract) from `n=0` (a tail-aware client with
    // nothing persisted yet). Passing 0 for a missing `n` would serve a finished,
    // non-rotated run's WHOLE tail and a parameterless client would append it onto
    // the steps it already shows -> #137/#161 duplicate. null makes the registry
    // 204 such a finished run (see attach); a tail-aware n=0 still resumes.
    const frontier: number | null =
      n === undefined || n === '' || !Number.isFinite(Number(n))
        ? null
        : Math.max(0, Number(n));
    // The per-subscriber backpressure cap tracks the (env-tunable) ring cap.
    const subscriberCap =
      this.streamRegistry?.subscriberMaxBufferedBytes ??
      SUBSCRIBER_MAX_BUFFERED_BYTES;
    let stopHeartbeat: () => void = () => undefined;
    const attachment = await this.streamRegistry?.attach(chatId, anchor, frontier, {
      onFrame: (frame) => {
        // Backpressure guard: 2x the ring cap, so the initial tail burst alone
        // can never trip it; only a genuinely stalled socket can.
        try {
          if (res.raw.writableLength > subscriberCap) {
            res.raw.destroy(); // 'close' fires -> unsubscribe below
            return;
          }
          if (!res.raw.writableEnded) res.raw.write(frame);
        } catch {
          res.raw.destroy();
        }
      },
      onEnd: () => {
        stopHeartbeat();
        if (!res.raw.writableEnded) res.raw.end();
      },
    });
    if (!attachment) {
      res.status(204).send(); // the ONLY "nothing to resume" signal the SDK accepts
      return;
    }
    res.hijack();
    // Cleanup BEFORE any write (invariant 5): a torn-down socket must not orphan
    // a paused subscriber whose pending queue would buffer the whole run.
    req.raw.once('close', () => {
      attachment.unsubscribe();
      stopHeartbeat();
    });
    // A close emitted DURING the awaits above was missed by the listener — check.
    // (Healthy pending GETs have req.raw.destroyed === false, so no false
    // positives; returning without end() is fine — the socket is gone.)
    if (req.raw.destroyed) {
      attachment.unsubscribe();
      return;
    }
    res.raw.on('error', () => undefined);
    try {
      res.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-vercel-ai-ui-message-stream': 'v1',
        'x-accel-buffering': 'no',
        // deliberately NO Connection/Keep-Alive (hop-by-hop; Safari/HTTP2)
      });
      res.raw.flushHeaders?.();
      // Write the tail in chunks respecting drain (not a synchronous blast, which
      // was half the OOM). Frames the paused subscriber buffers meanwhile are
      // drained by start() below; its cap is the backstop for a stalled socket.
      await writeTailRespectingDrain(res.raw, attachment.replay);
      if (attachment.finished) {
        if (!res.raw.writableEnded) res.raw.end();
        return;
      }
      stopHeartbeat = startSseHeartbeat(res.raw, 15_000);
      attachment.start(); // drain pending accumulated during the tail write, go live
    } catch {
      attachment.unsubscribe();
      stopHeartbeat();
      res.raw.destroy();
    }
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
    await this.aiChatRepo.update(
      dto.chatId,
      { title: dto.title },
      workspace.id,
    );
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
    const settings = (workspace.settings ?? {}) as {
      ai?: { chat?: boolean; autonomousRuns?: boolean };
    };
    if (settings.ai?.chat !== true) {
      throw new ForbiddenException('AI chat is disabled');
    }

    // #184 phase 1 flag: when ON, the turn becomes a detached, durable RUN — its
    // lifecycle is tracked in ai_chat_runs, a browser disconnect no longer aborts
    // it, and only an explicit /ai-chat/stop ends it. When OFF (the default) the
    // turn is socket-bound exactly as before, so existing deployments are
    // unaffected.
    const autonomousRuns = settings.ai?.autonomousRuns === true;

    const sessionId = (req.raw as { sessionId?: string }).sessionId;
    if (!sessionId) {
      // The chat requires an interactive session to mint loopback tokens
      // (§15[C1]); Bearer/API-key requests without a session are rejected.
      throw new ForbiddenException('AI chat requires an interactive session');
    }

    const body = (req.body ?? {}) as AiChatStreamBody;

    // #487 [security]: gate cross-user access to an EXISTING chat BEFORE anything
    // reads its runs. Every sibling endpoint (getRun/stop/history/rename/delete/
    // attachRunStream) owner-checks the chat via assertOwnedChat; stream() must too.
    // Without this a same-workspace member who is NOT the chat owner could POST a
    // supersede against another user's chat and (a) harvest that user's active runId
    // out of the 409 SUPERSEDE_TARGET_MISMATCH body, then (b) requestStop the foreign
    // run. Gate on the chatId the client sent, when present — a brand-new chat (no
    // chatId) has no prior owner to check. Mirrors /stop's owner check (403 as the
    // neighbors do), and runs pre-hijack so it returns clean JSON.
    if (body.chatId) {
      await this.assertOwnedChat(body.chatId, user, workspace);
    }

    // Resolve the agent role for this turn BEFORE hijack: existing chats read it
    // from ai_chats.role_id (authoritative), a new chat from body.roleId. The
    // role drives both the persona and the optional model override below.
    const role = await this.aiChatService.resolveRoleForRequest(
      workspace,
      body,
    );

    // Resolve the model (applying the role's optional override) BEFORE hijack so
    // an unconfigured provider — including a role pointing at an unconfigured
    // driver — returns a clean JSON 503 (AiNotConfiguredException is a 503
    // HttpException) instead of breaking mid-stream.
    const model = await this.aiChatService.getChatModel(workspace.id, role);

    // #487: server-side supersede CAS ("interrupt and send now"). When the client
    // asks to replace a live run, atomically STOP it and wait for it to settle
    // before this turn claims the slot. Runs BEFORE hijack so every branch returns
    // clean JSON (the client keeps the composer text on a 409). See
    // AiChatRunService.supersede for the branch semantics.
    let superseded = false;
    const supersedeRunId = body.supersede?.runId;
    if (supersedeRunId) {
      if (!body.chatId) {
        throw new BadRequestException({
          message: 'supersede requires chatId',
          code: 'SUPERSEDE_INVALID',
        });
      }
      const result = await this.aiChatRunService.supersede(
        body.chatId,
        supersedeRunId,
        workspace.id,
      );
      switch (result.kind) {
        case 'invalid':
          throw new BadRequestException({
            message: 'The run to supersede does not belong to this chat',
            code: 'SUPERSEDE_INVALID',
          });
        case 'mismatch':
          // A DIFFERENT run is active than the one the client targeted. Surface
          // the CURRENT runId; the client does NOT auto-retry (a stale CAS).
          throw new ConflictException({
            message: 'A different agent run is now active on this chat',
            code: 'SUPERSEDE_TARGET_MISMATCH',
            activeRunId: result.activeRunId,
          });
        case 'timeout':
          // The target did not settle within W — nothing was persisted, the
          // composer keeps the text. NOT a rollback: the stop is already issued.
          throw new ConflictException({
            message:
              'The previous run did not stop in time; nothing was sent — please try again',
            code: 'SUPERSEDE_TIMEOUT',
          });
        case 'ready':
          // The target stopped and settled: the slot is free. Prompt the new run
          // that the old run's last operations may still be applying.
          superseded = true;
          break;
        case 'degrade':
          // The run already ended between click and POST — send normally.
          break;
      }
    }

    // #487: one active run per chat — ENFORCED IN BOTH MODES now (legacy mode used
    // to have NO gate, so two tabs streamed two parallel turns on one chat, which
    // interleaved history and crashed convertToModelMessages). Reject a concurrent
    // start with a clean pre-hijack 409 (double-submit / second-tab). A brand-new
    // chat (no chatId) cannot have a prior run, and the DB partial unique index in
    // beginRun is the authoritative backstop for any race that slips past here
    // (including a slot stolen between a supersede release and beginRun).
    if (body.chatId) {
      const active = await this.aiChatRunService.getActiveForChat(
        body.chatId,
        workspace.id,
      );
      if (active) {
        throw new ConflictException({
          message: 'An agent run is already in progress for this chat',
          code: 'A_RUN_ALREADY_ACTIVE',
          activeRunId: active.id,
        });
      }
    }

    // #487: the turn is ALWAYS a first-class RUN now (both modes). The mode
    // difference is only the abort semantics on a browser disconnect (onClose
    // below). currentRunId is captured at begin so a legacy disconnect can stop
    // the run through its stop lever.
    let currentRunId: string | undefined;
    const runHooks: AiChatRunHooks = {
      begin: async (chatId) => {
        const handle = await this.aiChatRunService.beginRun({
          chatId,
          workspaceId: workspace.id,
          userId: user.id,
          trigger: 'user',
        });
        currentRunId = handle?.runId;
        // #184 phase 1.5: register the run-stream entry at BEGIN (before any
        // frame) so a tab that attaches in the begin->seed window finds an entry
        // to wait on. Gated on AI_CHAT_RESUMABLE_STREAM.
        if (
          handle?.runId &&
          this.environment?.isAiChatResumableStreamEnabled?.()
        ) {
          this.streamRegistry?.open(chatId, handle.runId);
        }
        return handle;
      },
      onAssistantSeeded: (runId, messageId) =>
        this.aiChatRunService.linkAssistantMessage(
          runId,
          workspace.id,
          messageId,
        ),
      onStep: (runId, stepCount) =>
        void this.aiChatRunService.recordStep(runId, workspace.id, stepCount),
      onSettled: (runId, status, error) =>
        this.aiChatRunService.finalizeRun(runId, workspace.id, status, error),
    };

    // Handle a client disconnect. `close` also fires on normal completion, so only
    // act when the response has not finished writing (a genuine disconnect). `once`
    // fires at most once and self-removes; we also drop it on response `finish`.
    // DIAGNOSTIC (Safari stream-drop investigation) — temporary: wall-clock at
    // which a Safari disconnect is observed, measured from request receipt.
    const reqStartedAt = Date.now();
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.raw.writableEnded) {
        if (autonomousRuns) {
          // #184: a DETACHED run — a disconnect must NOT stop it. The run keeps
          // executing and persisting server-side; the client reconnects via
          // /ai-chat/run (or re-stops via /ai-chat/stop). Log only.
          this.logger.log(
            `AI chat stream: client disconnected; run continues server-side ` +
              `(elapsed=${Date.now() - reqStartedAt}ms since request received)`,
          );
        } else {
          // #487: legacy — a disconnect ENDS the turn, but the turn is now a RUN,
          // so stop it through the run's stop lever (requestStop). streamText no
          // longer consumes the socket signal (effectiveSignal is the run signal),
          // so aborting `controller` would do nothing; requestStop aborts the run.
          this.logger.warn(
            `AI chat stream: client disconnected before completion; stopping the ` +
              `run (elapsed=${Date.now() - reqStartedAt}ms since request received)`,
          );
          if (currentRunId) {
            void this.aiChatRunService.requestStop(currentRunId, workspace.id);
          }
        }
      }
    };
    req.raw.once('close', onClose);
    res.raw.once('finish', () => req.raw.off('close', onClose));

    // #184/#487: the run/pipe can outlive the socket in BOTH modes now (autonomous
    // keeps going; legacy keeps going until requestStop's abort unwinds the turn).
    // The SDK's pipe may then write to a dropped socket and emit an 'error' on the
    // raw response — swallow it so it never surfaces as an unhandled error event.
    res.raw.on('error', (err) => {
      this.logger.debug(
        `AI chat stream: post-disconnect socket error swallowed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

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
        // #487: the turn is always run-wrapped now (both modes).
        runHooks,
        // #487: warn the new run that a superseded run's last ops may still apply.
        superseded,
      });
    } catch (err) {
      // Any failure AFTER hijack can no longer go through Nest's exception
      // filter, so emit the error on the raw socket if nothing has been written
      // yet. The lost-the-race 409 (RunAlreadyActiveError -> ConflictException)
      // is raised by stream() BEFORE it writes a byte, so headers are still
      // unsent here: honor the HttpException's real status + body (a clean 409),
      // not a blanket 500. Everything else stays a 500.
      const isHttp = err instanceof HttpException;
      if (!isHttp) {
        this.logger.error('AI chat stream failed', err as Error);
      }
      if (!res.raw.headersSent) {
        const status = isHttp ? err.getStatus() : 500;
        const payload = isHttp
          ? err.getResponse()
          : { error: 'Internal server error' };
        res.raw.statusCode = status;
        res.raw.setHeader('Content-Type', 'application/json');
        res.raw.end(
          JSON.stringify(
            typeof payload === 'string' ? { message: payload } : payload,
          ),
        );
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
      file = await req.file({
        limits: { fileSize: 25 * 1024 * 1024, files: 1 },
      });
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
   * Generate a page title from supplied note content (#199). One-shot,
   * non-streaming. Gated by the AI chat flag (settings.ai.chat, the same toggle
   * that enables the chat agent); returns { title }.
   * The endpoint NEVER writes the page — the client applies the title via the
   * existing /pages/update route (which enforces edit permission), so access
   * checks are not duplicated here. Throttled per user via AI_CHAT_THROTTLER.
   */
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [AI_CHAT_THROTTLER]: { limit: 20, ttl: 60000 } })
  @Post('generate-page-title')
  async generatePageTitle(
    @Body() dto: GeneratePageTitleDto,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ title: string }> {
    const settings = (workspace.settings ?? {}) as {
      ai?: { chat?: boolean };
    };
    if (settings.ai?.chat !== true) {
      throw new ForbiddenException('AI title generation is disabled');
    }
    try {
      const title = await this.aiChatService.generatePageTitle(
        workspace.id,
        dto.content,
      );
      return { title };
    } catch (err) {
      // Preserve meaningful HTTP errors (e.g. AiNotConfiguredException -> 503).
      if (err instanceof HttpException) throw err;
      // Surface the real provider/transport reason instead of an opaque 500.
      this.logger.error('AI title generation failed', err as Error);
      throw new ServiceUnavailableException(describeProviderError(err));
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
  ): Promise<AiChat> {
    const chat = await this.aiChatRepo.findById(chatId, workspace.id);
    if (!chat || chat.creatorId !== user.id) {
      throw new ForbiddenException();
    }
    return chat;
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
