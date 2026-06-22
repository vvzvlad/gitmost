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
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { AiAgentRole } from '@docmost/db/types/entity.types';
import { AiService } from '../../integrations/ai/ai.service';
import { AiSettingsService } from '../../integrations/ai/ai-settings.service';
import { PublicShareChatToolsService } from './tools/public-share-chat-tools.service';
import { buildShareSystemPrompt } from './public-share-chat.prompt';
import { roleModelOverride } from './roles/role-model-config';
import {
  PublicShareWorkspaceLimiter,
  createPublicShareWorkspaceLimiter,
} from './public-share-workspace-limiter';
import { describeProviderError } from '../../integrations/ai/ai-error.util';
import {
  startSseHeartbeat,
  stripStreamingHopByHopHeaders,
} from './sse-resilience';

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
  // Pre-resolved by the controller; its instructions replace the locked persona,
  // while the safety framework is still always appended. null = built-in persona.
  role: AiAgentRole | null;
}

/**
 * Caps on the incoming anonymous payload. The transcript is client-held and
 * never persisted; these bound the per-request cost an anonymous caller can
 * force (the workspace owner pays for the tokens).
 */
export const MAX_SHARE_MESSAGES = 30;
export const MAX_SHARE_MESSAGE_CHARS = 8000;

/**
 * Per-request output-token ceiling for the anonymous assistant. `streamText`
 * runs up to `stepCountIs(5)` steps, so the worst-case output of one accepted
 * request is bounded by (steps × this). The per-workspace cap bounds the COUNT
 * of calls; this bounds the SIZE of each, so a single anonymous call cannot run
 * up the provider bill even if the per-IP throttle is evaded. Env-overridable
 * seam; a non-positive or unparseable value falls back to the default.
 */
export const SHARE_AI_MAX_OUTPUT_TOKENS_DEFAULT = 512;
export function resolveShareAiMaxOutputTokens(): number {
  const raw = Number(process.env.SHARE_AI_MAX_OUTPUT_TOKENS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : SHARE_AI_MAX_OUTPUT_TOKENS_DEFAULT;
}

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
    private readonly aiAgentRoleRepo: AiAgentRoleRepo,
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
   * Resolve the admin-selected agent role for the anonymous public-share
   * assistant, scoped to the workspace and soft-delete aware. Returns null when
   * no role is configured, or when the referenced role is missing or disabled —
   * in which case the built-in locked persona applies. Mirrors the authenticated
   * chat's server-authoritative role resolution.
   */
  async resolveShareRole(workspaceId: string): Promise<AiAgentRole | null> {
    const resolved = await this.aiSettings.resolve(workspaceId);
    const roleId = resolved?.publicShareAssistantRoleId;
    if (!roleId) return null;
    // Same shared invariant as the authenticated chat: only a live + enabled +
    // workspace-scoped role applies; otherwise the built-in locked persona does.
    return (
      (await this.aiAgentRoleRepo.findLiveEnabled(roleId, workspaceId)) ?? null
    );
  }

  /**
   * Resolve the public-share chat model BEFORE res.hijack() (clean 503 path).
   * An admin-selected role's model override takes precedence over the cheap
   * `publicShareChatModel`; without a role override it uses the cheap
   * `publicShareChatModel`, falling back to the workspace `chatModel` when unset.
   *
   * IMPORTANT: a model override substitutes ONLY the model id (unless the role
   * also switches the driver). The baseUrl and apiKey are reused from the
   * workspace's main chat provider (see AiService.getChatModel) — the "cheap
   * model" is NOT an isolated provider or key, just a different model on the SAME
   * configured provider.
   */
  async getShareChatModel(
    workspaceId: string,
    role?: AiAgentRole | null,
  ): Promise<LanguageModel> {
    const override = roleModelOverride(role);
    if (override) {
      return this.ai.getChatModel(workspaceId, override);
    }
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
    role,
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
      roleInstructions: role?.instructions ?? null,
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
        // Cap per-request output so one anonymous call cannot run up the provider
        // bill even if the per-IP throttle is evaded; worst case = steps × this.
        maxOutputTokens: resolveShareAiMaxOutputTokens(),
        abortSignal: signal,
        onError: ({ error }) => {
          // Reuse the shared formatter so provider error formatting stays
          // unified (statusCode + body) with the authenticated path.
          const e = error as { stack?: string };
          const errorText = describeProviderError(error, String(error));
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
      // Scrub the SDK's hop-by-hop Connection header before it writes the head (Safari/HTTP2).
      stripStreamingHopByHopHeaders(res.raw);
      result.pipeUIMessageStreamToResponse(res.raw, {
        headers: { 'X-Accel-Buffering': 'no' },
        onError: (error: unknown) => {
          // Reuse the shared formatter so provider error formatting stays
          // unified between the log line and the streamed error message — a
          // share reader sees 402/429/503 causes consistently with the
          // authenticated path.
          return describeProviderError(error, 'AI stream error');
        },
      });

      // Force the status line + headers onto the socket now (before the first
      // token), so the proxy sees the response start immediately.
      res.raw.flushHeaders?.();
      // Heartbeat: keep the SSE stream progressing during silent tool/think gaps (Safari/proxy idle timeout).
      startSseHeartbeat(res.raw);
    } catch (err) {
      // Synchronous failure before/while wiring the stream: re-throw for the
      // controller to surface on the socket.
      throw err;
    }
  }
}
