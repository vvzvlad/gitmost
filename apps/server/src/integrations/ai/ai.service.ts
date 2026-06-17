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
   * Throws AiEmbeddingNotConfiguredException (→ 503) when the driver,
   * embeddingModel or (for non-ollama) the API key is missing, so RAG callers
   * can 503 or skip independently of chat being configured.
   */
  async getEmbeddingModel(workspaceId: string): Promise<EmbeddingModel> {
    const cfg = await this.aiSettings.resolve(workspaceId);
    if (
      !cfg?.driver ||
      !cfg?.embeddingModel ||
      (cfg.driver !== 'ollama' && !cfg.apiKey)
    ) {
      throw new AiEmbeddingNotConfiguredException();
    }

    switch (cfg.driver) {
      case 'openai':
        // baseURL (when set) covers openai-compatible endpoints.
        return createOpenAI({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseUrl,
        }).textEmbeddingModel(cfg.embeddingModel);
      case 'gemini':
        return createGoogleGenerativeAI({
          apiKey: cfg.apiKey,
        }).textEmbeddingModel(cfg.embeddingModel);
      case 'ollama':
        // Ollama needs no API key (e.g. nomic-embed-text).
        return createOllama({ baseURL: cfg.baseUrl }).textEmbeddingModel(
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
    const { embeddings } = await embedMany({ model, values: texts });
    return embeddings;
  }

  /**
   * Cheap connectivity check. Builds the model and asks for a one-word reply.
   * On AiNotConfiguredException returns a generic "not configured" message; for
   * any other failure surfaces the provider's own cause (e.g. AI SDK
   * `AI_APICallError` -> `${statusCode}: ${message}`) so a 402 / wrong model /
   * missing key is diagnosable, and logs the full error. The decrypted key is
   * never logged or returned — AI SDK error messages/4xx bodies do not contain
   * it, and the resolved config (which holds the key) is never dumped (§6.4/§8.3).
   */
  async testConnection(
    workspaceId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const model = await this.getChatModel(workspaceId);
      // maxOutputTokens keeps the probe cheap and avoids providers (e.g.
      // OpenRouter) reserving/charging for the model's full max-token budget,
      // which would 402 on a key with limited credit.
      await generateText({ model, prompt: 'ping', maxOutputTokens: 16 });
      return { ok: true };
    } catch (err) {
      if (err instanceof AiNotConfiguredException) {
        return { ok: false, error: 'AI provider not configured' };
      }
      // Surface the real provider cause so failures are diagnosable, and log the
      // full error. AI SDK errors expose statusCode/message (and responseBody);
      // none of these carry the key. Do NOT log/return the resolved config.
      this.logger.error('AI test connection failed', err as Error);
      const e = err as { statusCode?: number; message?: string };
      const msg = e?.statusCode
        ? `${e.statusCode}: ${e.message}`
        : (e?.message ?? 'Unknown error');
      return { ok: false, error: msg };
    }
  }
}
