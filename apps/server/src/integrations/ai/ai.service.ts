import { Injectable, Logger } from '@nestjs/common';
import {
  embedMany,
  generateText,
  type EmbeddingModel,
  type LanguageModel,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOllama } from 'ai-sdk-ollama';
import { AiSettingsService } from './ai-settings.service';
import { AiNotConfiguredException } from './ai-not-configured.exception';
import { AiEmbeddingNotConfiguredException } from './ai-embedding-not-configured.exception';
import { describeProviderError } from './ai-error.util';

/**
 * Builds AI SDK language models from per-workspace config and runs cheap
 * connectivity checks.
 *
 * The provider client is built PER WORKSPACE on demand — never cached globally —
 * and the decrypted API key is held only for the duration of the call and is
 * never logged (§6.2/§8).
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly aiSettings: AiSettingsService) {}

  /**
   * Resolve the workspace config and build the chat language model.
   * Throws AiNotConfiguredException (→ 503) when the config is incomplete.
   */
  async getChatModel(workspaceId: string): Promise<LanguageModel> {
    const cfg = await this.aiSettings.resolve(workspaceId);
    if (
      !cfg?.driver ||
      !cfg?.chatModel ||
      (cfg.driver !== 'ollama' && !cfg.apiKey)
    ) {
      throw new AiNotConfiguredException();
    }

    switch (cfg.driver) {
      case 'openai':
        // baseURL (when set) covers openai-compatible endpoints. Use Chat
        // Completions (/chat/completions) — the portable OpenAI-compatible
        // endpoint. The default callable createOpenAI(...)(model) targets the
        // Responses API (/responses), which OpenAI-compatible gateways
        // (OpenRouter, etc.) reject on multi-turn requests (history with
        // assistant messages) → 400.
        return createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl }).chat(
          cfg.chatModel,
        );
      case 'gemini':
        return createGoogleGenerativeAI({ apiKey: cfg.apiKey })(cfg.chatModel);
      case 'ollama':
        // Ollama needs no API key.
        return createOllama({ baseURL: cfg.baseUrl })(cfg.chatModel);
      default:
        throw new AiNotConfiguredException();
    }
  }

  /**
   * Resolve the workspace config and build the text-embedding model used by the
   * RAG indexer / semanticSearch (§6.7 stage D). Built PER WORKSPACE on demand,
   * same as getChatModel; the decrypted key is never logged.
   *
   * Uses the embedding-specific endpoint/key (`embeddingBaseUrl` /
   * `embeddingApiKey`), which fall back to the chat values when unset (resolved
   * by AiSettingsService.resolve).
   *
   * Throws AiEmbeddingNotConfiguredException (→ 503) when the driver,
   * embeddingModel or (for non-ollama) the embedding API key is missing, so RAG
   * callers can 503 or skip independently of chat being configured.
   */
  async getEmbeddingModel(workspaceId: string): Promise<EmbeddingModel> {
    const cfg = await this.aiSettings.resolve(workspaceId);
    if (
      !cfg?.driver ||
      !cfg?.embeddingModel ||
      (cfg.driver !== 'ollama' && !cfg.embeddingApiKey)
    ) {
      throw new AiEmbeddingNotConfiguredException();
    }

    switch (cfg.driver) {
      case 'openai':
        // embeddingBaseUrl (when set) covers openai-compatible endpoints.
        return createOpenAI({
          apiKey: cfg.embeddingApiKey,
          baseURL: cfg.embeddingBaseUrl,
        }).textEmbeddingModel(cfg.embeddingModel);
      case 'gemini':
        return createGoogleGenerativeAI({
          apiKey: cfg.embeddingApiKey,
        }).textEmbeddingModel(cfg.embeddingModel);
      case 'ollama':
        // Ollama needs no API key (e.g. nomic-embed-text).
        return createOllama({ baseURL: cfg.embeddingBaseUrl }).textEmbeddingModel(
          cfg.embeddingModel,
        );
      default:
        throw new AiEmbeddingNotConfiguredException();
    }
  }

  /**
   * Embed a batch of texts with the workspace embedding model. Returns one
   * vector per input, in the same order. Thin wrapper over the AI SDK's
   * embedMany; never logs the key or the texts.
   */
  async embedTexts(workspaceId: string, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const model = await this.getEmbeddingModel(workspaceId);
    // Bound the embedding call: a slow/hung embeddings endpoint must fail loudly
    // (and let the caller move on to the next page) instead of blocking forever.
    // The single signal caps the WHOLE call, including the SDK's internal
    // retries/backoff (embedMany defaults to maxRetries: 2).
    const timeoutMs = AiService.embeddingTimeoutMs();
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const { embeddings } = await embedMany({
        model,
        values: texts,
        abortSignal: signal,
      });
      return embeddings;
    } catch (err) {
      // AbortSignal.timeout aborts with an opaque TimeoutError; surface a clear,
      // greppable message so a hung/slow embeddings endpoint is obvious in logs.
      // Classify by the error itself (name) AND the signal, not the flag alone:
      // a genuine provider error that loses a race with the timer would also see
      // `signal.aborted === true`, and must keep its real diagnostics.
      // Mirror the SDK's own isAbortError (@ai-sdk/provider-utils): it treats
      // TimeoutError, AbortError and ResponseAborted (Next.js) as aborts.
      const abortLike =
        err instanceof Error &&
        (err.name === 'TimeoutError' ||
          err.name === 'AbortError' ||
          err.name === 'ResponseAborted');
      if (signal.aborted && abortLike) {
        throw new Error(
          `Embedding request timed out after ${timeoutMs}ms ` +
            `(workspace ${workspaceId}, ${texts.length} chunk(s)). ` +
            `Increase AI_EMBEDDING_TIMEOUT_MS or check the embeddings endpoint.`,
        );
      }
      throw err;
    }
  }

  /**
   * Per-embedding-call timeout in ms. Configurable via AI_EMBEDDING_TIMEOUT_MS;
   * falls back to 120000 (2 min) when unset or invalid.
   */
  private static embeddingTimeoutMs(): number {
    const raw = Number(process.env.AI_EMBEDDING_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
  }

  /**
   * Cheap connectivity check for the "Test connection" button. Probes the
   * configured chat model (a one-word generation) AND the configured embeddings
   * model (embedding a tiny string) independently:
   *  - a probe is skipped when that capability is not configured (its
   *    NotConfigured exception), so a chat-only or embeddings-only workspace
   *    still tests fine;
   *  - any real failure returns ok:false with the provider's own cause
   *    (statusCode + truncated response body via describeProviderError),
   *    prefixed Chat: / Embeddings: so the failing side is obvious;
   *  - if neither capability is configured, reports "not configured".
   *
   * Probing embeddings here catches a misconfigured embeddings endpoint (e.g.
   * one returning non-JSON, which the background RAG indexer would otherwise hit
   * as an opaque "Invalid JSON response") at config time instead of silently
   * during indexing. The decrypted key is never logged or returned — AI SDK
   * error fields do not carry it, and the resolved config is never dumped.
   */
  async testConnection(
    workspaceId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let probed = false;

    // Chat probe — only when a chat model is configured.
    try {
      const model = await this.getChatModel(workspaceId);
      // maxOutputTokens keeps the probe cheap and avoids providers (e.g.
      // OpenRouter) reserving/charging for the model's full max-token budget,
      // which would 402 on a key with limited credit.
      await generateText({ model, prompt: 'ping', maxOutputTokens: 16 });
      probed = true;
    } catch (err) {
      if (!(err instanceof AiNotConfiguredException)) {
        this.logger.error('AI chat test connection failed', err as Error);
        return { ok: false, error: `Chat: ${describeProviderError(err)}` };
      }
      // Chat not configured: skip — embeddings may still be configured.
    }

    // Embedding probe — only when an embedding model is configured.
    try {
      await this.embedTexts(workspaceId, ['ping']);
      probed = true;
    } catch (err) {
      if (!(err instanceof AiEmbeddingNotConfiguredException)) {
        this.logger.error('AI embedding test connection failed', err as Error);
        return { ok: false, error: `Embeddings: ${describeProviderError(err)}` };
      }
      // Embeddings not configured: skip.
    }

    if (!probed) {
      return { ok: false, error: 'AI provider not configured' };
    }
    return { ok: true };
  }
}
