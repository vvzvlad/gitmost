import { Injectable } from '@nestjs/common';
import { generateText, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOllama } from 'ai-sdk-ollama';
import { AiSettingsService } from './ai-settings.service';
import { AiNotConfiguredException } from './ai-not-configured.exception';

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
        // baseURL (when set) covers openai-compatible endpoints.
        return createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })(
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
   * Cheap connectivity check. Builds the model and asks for a one-word reply.
   * Never leaks the provider's raw error body or the key — only a short,
   * generic message (§6.4/§8.3).
   */
  async testConnection(
    workspaceId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let model: LanguageModel;
    try {
      model = await this.getChatModel(workspaceId);
    } catch (err) {
      if (err instanceof AiNotConfiguredException) {
        return { ok: false, error: 'AI provider not configured' };
      }
      // Defensive: do not surface internal error details.
      return { ok: false, error: 'AI provider not configured' };
    }

    try {
      await generateText({ model, prompt: 'ping' });
      return { ok: true };
    } catch {
      // Do NOT include the provider's raw error (may echo the request/key).
      return {
        ok: false,
        error: 'Failed to reach the AI provider. Check the settings and key.',
      };
    }
  }
}
