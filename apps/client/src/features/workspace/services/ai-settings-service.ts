import api from "@/lib/api-client";

// Supported LLM providers/drivers.
export type AiDriver = "openai" | "gemini" | "ollama";

// Masked AI provider settings returned by the server.
// No API key is ever returned; only `hasApiKey` / `hasEmbeddingApiKey` indicate
// whether one is stored. `embeddingBaseUrl` is the RAW stored value (empty means
// "uses the chat base URL").
export interface IAiSettings {
  driver?: AiDriver;
  chatModel?: string;
  embeddingModel?: string;
  baseUrl?: string;
  embeddingBaseUrl?: string;
  systemPrompt?: string;
  hasApiKey: boolean;
  hasEmbeddingApiKey: boolean;
  // RAG indexing coverage (pages indexed for semantic search).
  indexedPages: number;
  totalPages: number;
}

// Update payload. Key semantics (same for `apiKey` and `embeddingApiKey`):
//   - omit the key         -> key unchanged
//   - `key: ''`            -> clear the stored key
//   - `key: 'non-empty'`   -> set the key
// Non-secret fields are saved as given.
export interface IAiSettingsUpdate {
  driver?: AiDriver;
  chatModel?: string;
  embeddingModel?: string;
  baseUrl?: string;
  embeddingBaseUrl?: string;
  systemPrompt?: string;
  apiKey?: string;
  embeddingApiKey?: string;
}

// Result of a connection test against the configured provider.
// The error string is already sanitized server-side.
export interface IAiTestResult {
  ok: boolean;
  error?: string;
}

// Which endpoint a connection test probes.
export type AiTestCapability = "chat" | "embeddings";

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
