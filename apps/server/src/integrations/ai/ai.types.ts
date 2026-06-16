/**
 * Server-side AI provider configuration types.
 *
 * The non-secret provider settings live under `settings.ai.provider`; the
 * encrypted API key lives ONLY in `ai_provider_credentials` (per driver) and is
 * never part of these settings (§6.2/§6.4/§8).
 */

export type AiDriver = 'openai' | 'gemini' | 'ollama';

export const AI_DRIVERS: AiDriver[] = ['openai', 'gemini', 'ollama'];

/**
 * Non-secret provider settings persisted under `settings.ai.provider`.
 * The API key is intentionally absent here.
 */
export interface AiProviderSettings {
  driver: AiDriver;
  chatModel: string;
  embeddingModel?: string;
  baseUrl?: string;
  systemPrompt?: string;
}

/**
 * Fully resolved provider config, including the decrypted API key for the
 * stored driver. Returned by `AiSettingsService.resolve`. The key is held in
 * memory only while building the provider and is never logged.
 */
export interface ResolvedAiConfig extends Partial<AiProviderSettings> {
  driver?: AiDriver;
  chatModel?: string;
  apiKey?: string;
}

/**
 * Masked provider settings safe to return to admin clients. NEVER includes the
 * API key (not even encrypted); only a `hasApiKey` boolean.
 */
export interface MaskedAiSettings {
  driver?: AiDriver;
  chatModel?: string;
  embeddingModel?: string;
  baseUrl?: string;
  systemPrompt?: string;
  hasApiKey: boolean;
}
