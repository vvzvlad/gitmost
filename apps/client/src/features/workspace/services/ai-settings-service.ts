import api from "@/lib/api-client";

// Supported LLM providers/drivers.
export type AiDriver = "openai" | "gemini" | "ollama";

// How STT (speech-to-text) requests are encoded for the transcription endpoint.
//   - 'multipart' -> OpenAI-compatible multipart/form-data (OpenAI, speaches,
//     faster-whisper-server)
//   - 'json'      -> JSON body with base64-encoded audio (OpenRouter)
export type SttApiStyle = "multipart" | "json";

// Chat provider implementation for the `openai` driver (chosen explicitly):
//   - 'openai-compatible' -> maps streamed reasoning_content to reasoning parts
//     (z.ai/GLM, DeepSeek, OpenRouter, ...). Default.
//   - 'openai'            -> official provider; real-OpenAI reasoning-model shaping.
export type ChatApiStyle = "openai-compatible" | "openai";

// Masked AI provider settings returned by the server.
// No API key is ever returned; only `hasApiKey` / `hasEmbeddingApiKey` indicate
// whether one is stored. `embeddingBaseUrl` is the RAW stored value (empty means
// "uses the chat base URL").
export interface IAiSettings {
  driver?: AiDriver;
  chatModel?: string;
  // Max context window in tokens shown in the chat header badge; 0/unset = no limit.
  chatContextWindow?: number;
  chatApiStyle?: ChatApiStyle;
  // Cheap model id for the anonymous public-share assistant; empty = chatModel.
  publicShareChatModel?: string;
  // Agent-role id whose persona the public-share assistant adopts; empty =
  // built-in locked persona.
  publicShareAssistantRoleId?: string;
  embeddingModel?: string;
  baseUrl?: string;
  embeddingBaseUrl?: string;
  systemPrompt?: string;
  hasApiKey: boolean;
  hasEmbeddingApiKey: boolean;
  // STT-specific settings. `sttBaseUrl` is the RAW stored value (empty means
  // "uses the chat base URL"). `hasSttApiKey` indicates whether an STT-specific
  // key is stored (empty means "uses the chat API key").
  sttModel?: string;
  sttBaseUrl?: string;
  sttApiStyle?: SttApiStyle;
  // ISO-639-1 dictation language; empty = auto-detect.
  sttLanguage?: string;
  hasSttApiKey: boolean;
  // RAG indexing coverage (pages indexed for semantic search).
  indexedPages: number;
  totalPages: number;
  // True while a full workspace reindex is actively running; the counts above
  // then reflect the live run progress (done climbs 0 -> total).
  reindexing?: boolean;
}

// Update payload. Key semantics (same for `apiKey` and `embeddingApiKey`):
//   - omit the key         -> key unchanged
//   - `key: ''`            -> clear the stored key
//   - `key: 'non-empty'`   -> set the key
// Non-secret fields are saved as given.
export interface IAiSettingsUpdate {
  driver?: AiDriver;
  chatModel?: string;
  // Max context window in tokens for the chat header badge; 0 = clear the limit.
  chatContextWindow?: number;
  chatApiStyle?: ChatApiStyle;
  publicShareChatModel?: string;
  // Agent-role id whose persona the public-share assistant adopts; empty =
  // built-in locked persona.
  publicShareAssistantRoleId?: string;
  embeddingModel?: string;
  baseUrl?: string;
  embeddingBaseUrl?: string;
  systemPrompt?: string;
  apiKey?: string;
  embeddingApiKey?: string;
  sttModel?: string;
  sttBaseUrl?: string;
  sttApiStyle?: SttApiStyle;
  // ISO-639-1 dictation language; empty = auto-detect.
  sttLanguage?: string;
  // Write-only STT key (same semantics as `apiKey` / `embeddingApiKey`).
  sttApiKey?: string;
}

// Result of a connection test against the configured provider.
// The error string is already sanitized server-side.
export interface IAiTestResult {
  ok: boolean;
  error?: string;
}

// Which endpoint a connection test probes.
export type AiTestCapability = "chat" | "embeddings" | "stt";

export async function getAiSettings(): Promise<IAiSettings> {
  const req = await api.post<IAiSettings>("/workspace/ai-settings");
  return req.data;
}

export async function updateAiSettings(
  data: IAiSettingsUpdate,
): Promise<IAiSettings> {
  const req = await api.post<IAiSettings>("/workspace/ai-settings/update", data);
  return req.data;
}

export async function testAiConnection(
  capability: AiTestCapability,
): Promise<IAiTestResult> {
  const req = await api.post<IAiTestResult>("/workspace/ai-settings/test", {
    capability,
  });
  return req.data;
}

export async function reindexAiEmbeddings(): Promise<IAiSettings> {
  const req = await api.post<IAiSettings>("/workspace/ai-settings/reindex");
  return req.data;
}
