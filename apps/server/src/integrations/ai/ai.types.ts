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

// Chat provider implementation for the `openai` driver. Chosen explicitly by the
// admin (NOT inferred from baseUrl — a custom URL can front real OpenAI too).
// 'openai-compatible' = @ai-sdk/openai-compatible: maps streamed
//   `reasoning_content` to reasoning parts (z.ai/GLM, DeepSeek, OpenRouter, ...).
// 'openai' = official @ai-sdk/openai: real-OpenAI reasoning-model request shaping
//   (max_completion_tokens, the 'developer' role), no third-party reasoning map.
export type ChatApiStyle = 'openai-compatible' | 'openai';
export const CHAT_API_STYLES: ChatApiStyle[] = ['openai-compatible', 'openai'];

/**
 * Non-secret provider settings persisted under `settings.ai.provider`.
 * The API key is intentionally absent here.
 */
export interface AiProviderSettings {
  driver: AiDriver;
  chatModel: string;
  // Chat provider implementation for the `openai` driver. Unset → defaults to
  // 'openai-compatible' (so reasoning is surfaced by default). See ChatApiStyle.
  chatApiStyle?: ChatApiStyle;
  embeddingModel?: string;
  baseUrl?: string;
  // Embedding-specific base URL. Falls back to `baseUrl` when empty/unset.
  embeddingBaseUrl?: string;
  sttModel?: string;
  // STT-specific base URL. Falls back to baseUrl when empty/unset.
  sttBaseUrl?: string;
  sttApiStyle?: SttApiStyle;
  // ISO-639-1 dictation language hint (e.g. 'en', 'ru'). Empty/unset = auto-detect.
  sttLanguage?: string;
  systemPrompt?: string;
  // Cheap chat model id used ONLY by the anonymous public-share assistant. The
  // driver / baseUrl / apiKey of the main chat provider are reused; this is the
  // model id only. Empty/unset → the public-share assistant falls back to
  // `chatModel`. The workspace owner pays for anonymous tokens, so a cheaper
  // model is preferred for read-only Q&A over published documentation.
  publicShareChatModel?: string;
  // Agent-role id whose persona the anonymous public-share assistant adopts;
  // empty/unset = built-in locked persona.
  publicShareAssistantRoleId?: string;
}

/**
 * The persisted, non-secret provider setting keys — the SINGLE source of truth
 * for which fields a settings update may write through to `settings.ai.provider`.
 * `satisfies readonly (keyof AiProviderSettings)[]` makes the compiler reject a
 * typo or a key that is not a real provider setting.
 *
 * The settings service consumes this directly. The generic workspace repo cannot
 * import AI types, so it keeps its own copy of the same keys, guarded by a parity
 * test against this constant (so any future drift fails in CI, not silently in
 * prod — a missing key there validates fine, passes the service, and is then
 * dropped at the SQL boundary with no error).
 */
export const PROVIDER_SETTINGS_KEYS = [
  'driver',
  'chatModel',
  'chatApiStyle',
  'embeddingModel',
  'baseUrl',
  'embeddingBaseUrl',
  'sttModel',
  'sttBaseUrl',
  'sttApiStyle',
  'sttLanguage',
  'systemPrompt',
  'publicShareChatModel',
  'publicShareAssistantRoleId',
] as const satisfies readonly (keyof AiProviderSettings)[];

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
  // Cheap model id for the public-share assistant; reuses the chat creds.
  publicShareChatModel?: string;
  // Agent-role id whose persona the public-share assistant adopts (empty/unset
  // = built-in locked persona). Re-declared for parity with the explicit fields.
  publicShareAssistantRoleId?: string;
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
  chatApiStyle?: ChatApiStyle;
  embeddingModel?: string;
  baseUrl?: string;
  embeddingBaseUrl?: string;
  sttModel?: string;
  sttBaseUrl?: string;
  sttApiStyle?: SttApiStyle;
  // ISO-639-1 dictation language hint (e.g. 'en', 'ru'). Empty/unset = auto-detect.
  sttLanguage?: string;
  systemPrompt?: string;
  publicShareChatModel?: string;
  // Agent-role id whose persona the public-share assistant adopts; empty/unset
  // = built-in locked persona.
  publicShareAssistantRoleId?: string;
  hasApiKey: boolean;
  hasEmbeddingApiKey: boolean;
  hasSttApiKey: boolean;
  // RAG indexing coverage for the settings UI.
  indexedPages: number;
  totalPages: number;
}
