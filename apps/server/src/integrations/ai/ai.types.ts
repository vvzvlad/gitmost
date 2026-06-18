/**
 * Server-side AI provider configuration types.
 *
 * The non-secret provider settings live under `settings.ai.provider`; the
 * encrypted API key lives ONLY in `ai_provider_credentials` (per driver) and is
 * never part of these settings (§6.2/§6.4/§8).
 */

export type AiDriver = 'openai' | 'gemini' | 'ollama';

export const AI_DRIVERS: AiDriver[] = ['openai', 'gemini', 'ollama'];

// STT request encoding. 'multipart' = OpenAI-compatible /audio/transcriptions
// form-data (OpenAI, speaches, faster-whisper-server). 'json' = JSON body with
// base64 input_audio (OpenRouter). Chosen explicitly by the admin.
export type SttApiStyle = 'multipart' | 'json';
export const STT_API_STYLES: SttApiStyle[] = ['multipart', 'json'];

/**
 * Non-secret provider settings persisted under `settings.ai.provider`.
 * The API key is intentionally absent here.
 */
export interface AiProviderSettings {
  driver: AiDriver;
  chatModel: string;
  embeddingModel?: string;
  baseUrl?: string;
  // Embedding-specific base URL. Falls back to `baseUrl` when empty/unset.
  embeddingBaseUrl?: string;
  sttModel?: string;
  // STT-specific base URL. Falls back to baseUrl when empty/unset.
  sttBaseUrl?: string;
  sttApiStyle?: SttApiStyle;
  systemPrompt?: string;
}

/**
 * Fully resolved provider config, including the decrypted API key for the
 * stored driver. Returned by `AiSettingsService.resolve`. The keys are held in
 * memory only while building the provider and are never logged.
 *
 * `embeddingBaseUrl` / `embeddingApiKey` are the embedding-specific endpoint and
 * key, already resolved with the chat-value fallback applied by `resolve`.
 * `sttBaseUrl` / `sttApiKey` are likewise the STT-specific endpoint and key,
 * already resolved with the chat-value fallback applied by `resolve`.
 */
export interface ResolvedAiConfig extends Partial<AiProviderSettings> {
  driver?: AiDriver;
  chatModel?: string;
  apiKey?: string;
  embeddingApiKey?: string;
  sttApiKey?: string;
}

/**
 * Masked provider settings safe to return to admin clients. NEVER includes any
 * API key (not even encrypted); only `hasApiKey` / `hasEmbeddingApiKey` booleans.
 * `embeddingBaseUrl` reflects the RAW stored value (empty means "uses chat value").
 */
export interface MaskedAiSettings {
  driver?: AiDriver;
  chatModel?: string;
  embeddingModel?: string;
  baseUrl?: string;
  embeddingBaseUrl?: string;
  sttModel?: string;
  sttBaseUrl?: string;
  sttApiStyle?: SttApiStyle;
  systemPrompt?: string;
  hasApiKey: boolean;
  hasEmbeddingApiKey: boolean;
  hasSttApiKey: boolean;
  // RAG indexing coverage for the settings UI.
  indexedPages: number;
  totalPages: number;
}
