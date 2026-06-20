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
import { Workspace } from '@docmost/db/types/entity.types';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { PUBLIC_SHARE_AI_THROTTLER } from '../../integrations/throttle/throttler-names';
import { ShareService } from '../share/share.service';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { AiSettingsService } from '../../integrations/ai/ai-settings.service';
import { AiNotConfiguredException } from '../../integrations/ai/ai-not-configured.exception';
import {
  PublicShareChatService,
  PublicShareChatStreamBody,
  MAX_SHARE_MESSAGES,
  MAX_SHARE_MESSAGE_CHARS,
} from './public-share-chat.service';
import { evaluateShareAssistantFunnel } from './public-share-chat.funnel';
import type { UIMessage } from 'ai';

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
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageRepo: PageRepo,
    private readonly aiSettings: AiSettingsService,
    private readonly publicShareChat: PublicShareChatService,
  ) {}

  @Public()
  @SkipTransform()
  // IP-keyed throttle (default ThrottlerGuard tracker = client IP): ~5/min.
  // Runs FIRST, so an over-limit anonymous caller gets 429 before any work.
  @UseGuards(ThrottlerGuard)
  @Throttle({ [PUBLIC_SHARE_AI_THROTTLER]: { limit: 5, ttl: 60000 } })
  @Post('stream')
  async stream(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    const body = (req.body ?? {}) as PublicShareChatStreamBody;
    const shareId = typeof body.shareId === 'string' ? body.shareId.trim() : '';
    const pageId = typeof body.pageId === 'string' ? body.pageId.trim() : '';

    // ---- Guardrail funnel (order matters; each failure exits before stream) ----

    // 1. Workspace master toggle. 404 (do not reveal the feature exists).
    const assistantEnabled = await this.aiSettings.isPublicShareAssistantEnabled(
      workspace.id,
    );

    // 2. Share usable? Resolved via the page's share membership, since the page
    //    resolution (getShareForPage) ALSO yields the share + workspace. We
    //    still need basic input to attempt it.
    // 3. Page in share? The same getShareForPage lookup confirms the opened page
    //    resolves to THIS share tree, PLUS an explicit restricted-ancestor gate
    //    (getShareForPage itself does NOT exclude restricted descendants) so a
    //    restricted page hidden from the public view is graded not-in-share.
    //    (shareUsable + pageInShare are set together below; the funnel grades
    //    them as distinct ordered steps.)
    let share: Awaited<ReturnType<ShareService['getShareForPage']>> | undefined;
    let shareUsable = false;
    let pageInShare = false;
    if (assistantEnabled && shareId && pageId) {
      // getShareForPage walks up the tree to the nearest ancestor share,
      // enforces share.workspaceId === workspaceId and includeSubPages, and
      // returns undefined when the page is not publicly reachable. NOTE: it
      // joins only the `shares` table — it does NOT exclude restricted
      // descendants — so a restricted page inside an includeSubPages share
      // still resolves here. We add an explicit restricted-ancestor gate below
      // (same as the public view) so the opened page's title never leaks into
      // the system prompt for a page the public view 404s.
      share = await this.shareService.getShareForPage(pageId, workspace.id);
      if (share && share.id === shareId) {
        // Confirm sharing is still allowed for the share's space (and not
        // disabled at workspace/space level) — same gate the public views use.
        const sharingAllowed = await this.shareService.isSharingAllowed(
          workspace.id,
          share.spaceId,
        );
        shareUsable = sharingAllowed;
        // A restricted descendant is hidden from the public share view; treat
        // the opened page as not-in-share so the funnel returns the SAME 404 it
        // returns for an out-of-tree page (uniform, no existence leak).
        // hasRestrictedAncestor matches on the page UUID only, while the
        // opened pageId may be a slugId, so resolve to the UUID first (cheap
        // base-fields lookup, mirroring how getSharedPage resolves the page
        // before its restricted check).
        const openedPageRow = await this.pageRepo.findById(pageId);
        const restricted = openedPageRow
          ? await this.pagePermissionRepo.hasRestrictedAncestor(
              openedPageRow.id,
            )
          : true; // unresolvable opened page => fail closed (treat as not-in-share)
        pageInShare = sharingAllowed && !restricted;
      }
    }

    // 4. Provider configured? Resolve the model now so an unconfigured provider
    //    yields a clean 503 (AiNotConfiguredException) BEFORE hijack. Only
    //    attempt this once the earlier gates passed, to avoid leaking timing.
    let model: Awaited<ReturnType<PublicShareChatService['getShareChatModel']>> | undefined;
    let providerConfigured = false;
    if (assistantEnabled && shareUsable && pageInShare) {
      try {
        model = await this.publicShareChat.getShareChatModel(workspace.id);
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

    // 5. Per-WORKSPACE anti-abuse cap (IP-independent; defense in depth). The
    //    per-IP @Throttle above can be evaded by an attacker rotating
    //    `X-Forwarded-For` (the app runs with trustProxy), and each evaded call
    //    spends REAL tokens on the workspace owner's paid AI provider. This cap
    //    is keyed by the server-resolved workspace id (never attacker-
    //    controllable), so it bounds the owner's bill even when the per-IP limit
    //    is fully defeated via XFF spoofing. Checked here, BEFORE res.hijack(),
    //    so an over-cap workspace gets a clean 429 and spends nothing. NOTE:
    //    production should ALSO front this endpoint with a trusted proxy that
    //    REWRITES (not appends) XFF so the per-IP throttle stays meaningful.
    if (!this.publicShareChat.tryConsumeWorkspaceQuota(workspace.id)) {
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
      const text = uiMessageTextLength(m);
      if (text > MAX_SHARE_MESSAGE_CHARS) {
        throw new HttpException('Message too long', 413);
      }
    }

    const openedPage = {
      id: pageId,
      title: share?.sharedPage?.title ?? undefined,
    };

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
          id: share!.id,
          pageId: share!.pageId,
          sharedPage: share!.sharedPage,
        },
        openedPage,
        messages,
        res,
        signal: controller.signal,
        model: model!,
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

/** Sum of the text-part lengths of a UIMessage (cheap, for the size cap). */
function uiMessageTextLength(message: UIMessage | undefined): number {
  if (!message?.parts || !Array.isArray(message.parts)) return 0;
  let total = 0;
  for (const p of message.parts) {
    if (p?.type === 'text' && typeof (p as { text?: string }).text === 'string') {
      total += (p as { text: string }).text.length;
    }
  }
  return total;
}
