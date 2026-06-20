import { Injectable, Logger } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
  type LanguageModel,
} from 'ai';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { AiService } from '../../integrations/ai/ai.service';
import { AiSettingsService } from '../../integrations/ai/ai-settings.service';
import { PublicShareChatToolsService } from './tools/public-share-chat-tools.service';
import { buildShareSystemPrompt } from './public-share-chat.prompt';
import {
  PublicShareWorkspaceLimiter,
  createPublicShareWorkspaceLimiter,
} from './public-share-workspace-limiter';

/**
 * Loose shape of the anonymous public-share chat POST body. We do NOT bind a
 * strict DTO (the global ValidationPipe whitelist would strip the useChat
 * fields), so this is parsed straight off `req.body`. Every field is
 * attacker-controllable; the share scope is enforced by the tools, not by trust
 * in this payload.
 */
export interface PublicShareChatStreamBody {
  shareId?: string;
  pageId?: string;
  messages?: UIMessage[];
}

export interface PublicShareChatStreamArgs {
  workspaceId: string;
  shareId: string;
  // The resolved share descriptor (from getShareForPage): used for prompt
  // context (title) and to confirm the opened page belongs to this share.
  share: {
    id: string;
    pageId: string;
    sharedPage?: { id?: string; title?: string } | null;
  };
  openedPage?: { id?: string; title?: string } | null;
  messages: UIMessage[];
  res: FastifyReply;
  signal: AbortSignal;
  // Resolved by the controller BEFORE res.hijack() so an unconfigured provider
  // (AiNotConfiguredException -> 503) surfaces as clean JSON before streaming.
  model: LanguageModel;
}

/**
 * Caps on the incoming anonymous payload. The transcript is client-held and
 * never persisted; these bound the per-request cost an anonymous caller can
 * force (the workspace owner pays for the tokens).
 */
export const MAX_SHARE_MESSAGES = 30;
export const MAX_SHARE_MESSAGE_CHARS = 8000;

/**
 * Keep ONLY genuine conversation turns from the client-held transcript. The
 * payload is fully attacker-controlled; a forged `system` turn could try to
 * override the locked share-scoped system prompt, and a forged `tool` turn could
 * try to fake tool results (claiming content the share never returned). We admit
 * only `user` / `assistant` text turns — the real tools re-derive their scope
 * server-side regardless, but dropping the forged roles keeps the injected text
 * out of the model context entirely. Exported pure so the filter is directly
 * unit-testable.
 */
export function filterShareTranscript(messages: UIMessage[]): UIMessage[] {
  return (messages ?? []).filter(
    (m) => m?.role === 'user' || m?.role === 'assistant',
  );
}

/**
 * Anonymous, read-only AI assistant for a single PUBLIC share tree.
 *
 * Mirrors the streaming plumbing of `AiChatService` (streamText ->
 * pipeUIMessageStreamToResponse) but with NO persistence, NO user identity, and
 * a tiny share-scoped read-only toolset. The transcript comes from the client
 * and is trusted ONLY as conversation text — it can never widen the tool scope.
 */
@Injectable()
export class PublicShareChatService {
  private readonly logger = new Logger(PublicShareChatService.name);

  /**
   * IP-INDEPENDENT, CLUSTER-WIDE per-workspace cap on anonymous share-AI calls.
   * This is the second limiter contour: the per-IP @Throttle on the route can be
   * evaded by an attacker rotating `X-Forwarded-For` (the app runs with
   * trustProxy), but the workspace id is server-resolved from the host, so this
   * bounds the owner's token bill even when the per-IP limit is defeated. It is
   * a SLIDING window backed by the shared Redis, so the cap holds across window
   * boundaries AND is shared by all app instances (one budget, not K x cap). In
   * production the endpoint should ALSO sit behind a trusted proxy that rewrites
   * (not appends) XFF so the per-IP throttle stays meaningful.
   */
  private readonly workspaceLimiter: PublicShareWorkspaceLimiter;

  constructor(
    private readonly ai: AiService,
    private readonly aiSettings: AiSettingsService,
    private readonly tools: PublicShareChatToolsService,
    redisService: RedisService,
  ) {
    this.workspaceLimiter = createPublicShareWorkspaceLimiter(redisService);
  }

  /**
   * Account one anonymous share-AI call against the per-workspace cap. Returns
   * true if allowed; false once the workspace has hit its hourly cap (the
   * controller must then 429 BEFORE starting the stream / spending any tokens).
   */
  async tryConsumeWorkspaceQuota(workspaceId: string): Promise<boolean> {
    return this.workspaceLimiter.tryConsume(workspaceId);
  }

  /**
   * Resolve the public-share chat model BEFORE res.hijack() (clean 503 path).
   * Uses the cheap `publicShareChatModel`, falling back to the workspace
   * `chatModel` when unset.
   *
   * IMPORTANT: this override substitutes ONLY the model id. The driver, baseUrl
   * and apiKey are reused from the workspace's main chat provider (see
   * AiService.getChatModel) — the "cheap model" is NOT an isolated provider or
   * key, just a different model on the SAME configured provider.
   */
  async getShareChatModel(workspaceId: string): Promise<LanguageModel> {
    const resolved = await this.aiSettings.resolve(workspaceId);
    return this.ai.getChatModel(workspaceId, {
      chatModel: resolved?.publicShareChatModel,
    });
  }

  async stream({
    workspaceId,
    shareId,
    share,
    openedPage,
    messages,
    res,
    signal,
    model,
  }: PublicShareChatStreamArgs): Promise<void> {
    // Rebuild the conversation from the client payload. The client holds the
    // transcript (ephemeral, never stored). Trusting it is safe: the share
    // scope is enforced by the tools, not by the messages.
    const uiMessages = filterShareTranscript(messages);
    // convertToModelMessages is async in ai@6.x (Promise<ModelMessage[]>).
    const modelMessages = await convertToModelMessages(uiMessages);

    const system = buildShareSystemPrompt({
      share: { sharedPageTitle: share.sharedPage?.title ?? null },
      openedPage,
    });

    // Tiny, READ-only, in-process toolset hard-scoped to THIS share tree.
    const tools = this.tools.forShare(shareId, workspaceId);

    // NOTE: streamText is synchronous in v6 — do NOT await it. A synchronous
    // failure here (or in the pipe below) would skip the terminal callbacks, so
    // the catch re-throws for the controller to surface on the socket.
    let result: ReturnType<typeof streamText>;
    try {
      result = streamText({
        model,
        system,
        messages: modelMessages,
        tools,
        // Bound the agent loop for anonymous callers.
        stopWhen: stepCountIs(5),
        abortSignal: signal,
        onError: ({ error }) => {
          const e = error as {
            statusCode?: number;
            message?: string;
            stack?: string;
          };
          const errorText = e?.statusCode
            ? `${e.statusCode}: ${e.message ?? String(error)}`
            : (e?.message ?? String(error));
          // Never persist anonymous transcripts; just log the failure.
          this.logger.error(
            `Public share chat stream error: ${errorText}`,
            e?.stack,
          );
        },
      });

      // Stream the UI-message protocol straight to the hijacked Node response.
      // Surface the real provider message (AI SDK error bodies never carry the
      // API key, so this is safe; we never dump the resolved config).
      result.pipeUIMessageStreamToResponse(res.raw, {
        headers: { 'X-Accel-Buffering': 'no' },
        onError: (error: unknown) => {
          const e = error as { statusCode?: number; message?: string };
          return e?.statusCode
            ? `${e.statusCode}: ${e.message}`
            : (e?.message ?? 'AI stream error');
        },
      });

      // Force the status line + headers onto the socket now (before the first
      // token), so the proxy sees the response start immediately.
      res.raw.flushHeaders?.();
    } catch (err) {
      // Synchronous failure before/while wiring the stream: re-throw for the
      // controller to surface on the socket.
      throw err;
    }
  }
}
