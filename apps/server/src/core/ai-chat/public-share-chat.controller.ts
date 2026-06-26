import {
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Workspace, AiAgentRole } from '@docmost/db/types/entity.types';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { PUBLIC_SHARE_AI_THROTTLER } from '../../integrations/throttle/throttler-names';
import { ShareService } from '../share/share.service';
import { AiSettingsService } from '../../integrations/ai/ai-settings.service';
import { AiNotConfiguredException } from '../../integrations/ai/ai-not-configured.exception';
import {
  PublicShareChatService,
  PublicShareChatStreamBody,
  MAX_SHARE_MESSAGES,
  MAX_SHARE_MESSAGE_CHARS,
} from './public-share-chat.service';
import { evaluateShareAssistantFunnel } from './public-share-chat.funnel';
import { deriveShareAccess } from './public-share-chat.access';
import { isTextUIPart, type UIMessage } from 'ai';

/**
 * Anonymous, read-only AI assistant over a SINGLE public share tree.
 *
 * Route: POST /api/shares/ai/stream (controller path `shares/ai`, the global
 * `/api` prefix is applied by main.ts). `@Public()` so no session is required;
 * the workspace (tenant) is resolved from the host by DomainMiddleware
 * (`req.raw.workspace`), exactly like the other `/api/shares/*` public routes —
 * so no main.ts change is needed.
 *
 * The security boundary is the tool scope (the share tree), not identity. The
 * guardrail funnel below runs entirely BEFORE res.hijack(): every failure
 * returns a clean JSON error and never starts streaming.
 */
@UseGuards(JwtAuthGuard)
@Controller('shares/ai')
export class PublicShareChatController {
  private readonly logger = new Logger(PublicShareChatController.name);

  constructor(
    private readonly shareService: ShareService,
    private readonly aiSettings: AiSettingsService,
    private readonly publicShareChat: PublicShareChatService,
  ) {}

  @Public()
  @SkipTransform()
  // IP-keyed throttle (default ThrottlerGuard tracker = client IP): ~5/min.
  // Runs FIRST, so an over-limit anonymous caller gets 429 before any work.
  // DEFENSE IN DEPTH ONLY: the app runs with trustProxy, so the "client IP" is
  // taken from X-Forwarded-For. This layer is only meaningful when a TRUSTED
  // reverse proxy REWRITES (not appends) XFF with the real client IP; otherwise
  // an attacker rotates XFF to evade it. The cluster-wide per-workspace cap
  // below is the backstop that holds even when this layer is fully evaded.
  @UseGuards(ThrottlerGuard)
  @Throttle({ [PUBLIC_SHARE_AI_THROTTLER]: { limit: 5, ttl: 60000 } })
  @Post('stream')
  async stream(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    const body = (req.body ?? {}) as PublicShareChatStreamBody;

    // ---- Guardrail funnel (order matters; each failure exits before stream) ----
    // The whole pre-hijack fact-resolution + cap-ordering block is a pure-ish
    // helper (collaborators passed in) so every funnel branch — 404 disabled /
    // share-mismatch / page-unresolvable / restricted, 503 unconfigured, 429
    // over-cap, 413 too many/too long — is unit-testable against the red-team
    // boundaries without the full Nest/DB graph. It throws the SAME HttpException
    // the controller would, and never starts streaming.
    const resolved = await resolveShareAssistantRequest(
      {
        aiSettings: this.aiSettings,
        shareService: this.shareService,
        publicShareChat: this.publicShareChat,
      },
      { workspaceId: workspace.id, body },
    );
    const { shareId, share, model, role, messages, openedPage } = resolved;

    // Abort the agent loop when the client disconnects (mirrors ai-chat).
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.raw.writableEnded) controller.abort();
    };
    req.raw.once('close', onClose);
    res.raw.once('finish', () => req.raw.off('close', onClose));

    // Commit to streaming.
    res.hijack();

    try {
      await this.publicShareChat.stream({
        workspaceId: workspace.id,
        shareId,
        share: {
          id: share.id,
          pageId: share.pageId,
          sharedPage: share.sharedPage,
        },
        openedPage,
        messages,
        res,
        signal: controller.signal,
        model,
        role,
      });
    } catch (err) {
      // After hijack we can no longer send a clean JSON error.
      this.logger.error('Public share chat stream failed', err as Error);
      if (!res.raw.headersSent) {
        res.raw.statusCode = 500;
        res.raw.setHeader('Content-Type', 'application/json');
        res.raw.end(JSON.stringify({ error: 'Internal server error' }));
      } else if (!res.raw.writableEnded) {
        res.raw.end();
      }
    }
  }
}

/**
 * The collaborators the pre-hijack funnel needs. Declared as the minimal slice
 * of each injected service it actually calls, so the resolver can be unit-tested
 * with hand-rolled mocks (no Nest module graph, no DB).
 */
export interface ShareAssistantDeps {
  aiSettings: Pick<AiSettingsService, 'isPublicShareAssistantEnabled'>;
  // The (shareId, pageId) -> readable page resolve is the SINGLE canonical
  // share-access boundary (resolveReadableSharePage); isSharingAllowed remains a
  // separate workspace/space toggle this funnel layers on top of it.
  shareService: Pick<
    ShareService,
    'resolveReadableSharePage' | 'isSharingAllowed'
  >;
  publicShareChat: Pick<
    PublicShareChatService,
    | 'resolveShareRole'
    | 'getShareChatModel'
    | 'tryConsumeWorkspaceQuota'
    | 'withinShareTokenBudget'
  >;
}

/** The resolved, validated request ready to stream (everything is non-null). */
export interface ResolvedShareAssistantRequest {
  shareId: string;
  share: NonNullable<
    Awaited<ReturnType<ShareService['resolveReadableSharePage']>>
  >['share'];
  model: Awaited<ReturnType<PublicShareChatService['getShareChatModel']>>;
  role: AiAgentRole | null;
  messages: UIMessage[];
  openedPage: { id: string; title?: string };
}

/**
 * Pre-hijack fact-resolution + cap-ordering for the anonymous public-share
 * assistant, extracted from the controller so every funnel branch is unit-
 * testable without the Nest/DB graph. Order is security-relevant and each
 * failure exits BEFORE any stream/hijack:
 *  1. assistant toggle off => 404 (no share/page/model lookups);
 *  2. share/page access (deriveShareAccess + evaluateShareAssistantFunnel) =>
 *     404 (uniform; restricted descendant and out-of-tree look identical);
 *  3. provider unconfigured => 503 (AiNotConfiguredException), other errors
 *     re-thrown;
 *  4. per-workspace quota exhausted => 429 (BEFORE any stream/hijack);
 *  5. payload caps => 413 (too many messages / a single message too long).
 * Throws the SAME HttpException the controller would; returns the resolved,
 * non-null request otherwise.
 */
export async function resolveShareAssistantRequest(
  deps: ShareAssistantDeps,
  input: { workspaceId: string; body: PublicShareChatStreamBody },
): Promise<ResolvedShareAssistantRequest> {
  const { workspaceId, body } = input;
  const shareId = typeof body.shareId === 'string' ? body.shareId.trim() : '';
  const pageId = typeof body.pageId === 'string' ? body.pageId.trim() : '';

  // 1. Workspace master toggle. 404 (do not reveal the feature exists).
  const assistantEnabled =
    await deps.aiSettings.isPublicShareAssistantEnabled(workspaceId);

  // 2/3. Share usable? Page in share? The (shareId, pageId) -> readable page
  //      resolve is delegated WHOLE to the single canonical share-access
  //      boundary: resolveReadableSharePage returns non-null ONLY when the page
  //      resolves to THIS share, matches the requested shareId, is live, and has
  //      NO restricted ancestor (the gate getShareForPage does NOT itself do).
  //      So `pageInShare` is exactly "resolve succeeded". `isSharingAllowed`
  //      stays a SEPARATE workspace/space toggle layered on top (it is NOT part
  //      of the resolve), feeding `shareUsable` via deriveShareAccess.
  let share:
    | NonNullable<
        Awaited<ReturnType<ShareService['resolveReadableSharePage']>>
      >['share']
    | undefined;
  let shareUsable = false;
  let pageInShare = false;
  if (assistantEnabled && shareId && pageId) {
    const resolved = await deps.shareService.resolveReadableSharePage(
      shareId,
      pageId,
      workspaceId,
    );
    if (resolved) {
      share = resolved.share;
      const sharingAllowed = await deps.shareService.isSharingAllowed(
        workspaceId,
        share.spaceId,
      );
      // The resolve already guarantees the page is in THIS share AND not
      // restricted; deriveShareAccess folds in the orthogonal sharing toggle.
      ({ shareUsable, pageInShare } = deriveShareAccess({
        resolvedShareId: share.id,
        requestedShareId: shareId,
        sharingAllowed,
        restricted: false,
      }));
    }
  }

  // 4. Provider configured? Resolve the model now so an unconfigured provider
  //    yields a clean 503 BEFORE hijack. Only after the access gates pass, to
  //    avoid leaking timing.
  let model:
    | Awaited<ReturnType<PublicShareChatService['getShareChatModel']>>
    | undefined;
  let role: AiAgentRole | null = null;
  let providerConfigured = false;
  if (assistantEnabled && shareUsable && pageInShare) {
    try {
      role = await deps.publicShareChat.resolveShareRole(workspaceId);
      model = await deps.publicShareChat.getShareChatModel(workspaceId, role);
      providerConfigured = true;
    } catch (err) {
      if (err instanceof AiNotConfiguredException) {
        providerConfigured = false;
      } else {
        throw err;
      }
    }
  }

  const outcome = evaluateShareAssistantFunnel({
    assistantEnabled,
    shareUsable,
    pageInShare,
    providerConfigured,
  });
  if (outcome.ok === false) {
    // 404 for everything access-shaped (feature/share/page); 503 for config.
    if (outcome.status === 503) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    throw new NotFoundException('Not found');
  }

  // 5a. Per-WORKSPACE rolling-day TOKEN budget (the COST backstop). Read-only and
  //     checked FIRST so a workspace that has already burned its day's token
  //     budget gets a clean 429 WITHOUT consuming a request slot, and spends
  //     nothing. Counting requests alone does not bound the owner's provider
  //     bill (issue #159, finding #5).
  if (!(await deps.publicShareChat.withinShareTokenBudget(workspaceId))) {
    throw new HttpException(
      'This documentation assistant has reached its usage budget. Please try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  // 5b. Per-WORKSPACE anti-abuse request cap (IP-independent; defense in depth).
  //     Checked BEFORE res.hijack(), so an over-cap workspace gets a clean 429
  //     and spends nothing.
  if (!(await deps.publicShareChat.tryConsumeWorkspaceQuota(workspaceId))) {
    throw new HttpException(
      'This documentation assistant is temporarily busy. Please try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  // ---- Validate / bound the payload (cheap caps; ephemeral, never stored) ----
  const messages = Array.isArray(body.messages)
    ? (body.messages as UIMessage[])
    : [];
  if (messages.length > MAX_SHARE_MESSAGES) {
    throw new HttpException('Too many messages', 413);
  }
  for (const m of messages) {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    // The server runs no tools on the anonymous path, so a client tool/non-text
    // part is never legitimate. Reject before the size check: it keeps the char
    // cap meaningful (a forged tool-result/file/data part would otherwise bypass
    // it and bloat the model input) and avoids stringifying an attacker-sized
    // payload via convertToModelMessages.
    if (parts.some((p) => !isTextUIPart(p))) {
      throw new HttpException('Unsupported message content', 400);
    }
    if (uiMessageTextLength(m) > MAX_SHARE_MESSAGE_CHARS) {
      throw new HttpException('Message too long', 413);
    }
  }

  const openedPage = {
    id: pageId,
    title: share?.sharedPage?.title ?? undefined,
  };

  // The funnel passed, so share/model are guaranteed present.
  return {
    shareId,
    share: share!,
    model: model!,
    role,
    messages,
    openedPage,
  };
}

/** Sum of the text-part lengths of a UIMessage (cheap, for the size cap).
 * Exported so the 413 size-cap logic is unit-testable without the Nest/DB graph.
 */
export function uiMessageTextLength(message: UIMessage | undefined): number {
  if (!message?.parts || !Array.isArray(message.parts)) return 0;
  let total = 0;
  for (const p of message.parts) {
    if (p?.type === 'text' && typeof (p as { text?: string }).text === 'string') {
      total += (p as { text: string }).text.length;
    }
  }
  return total;
}
