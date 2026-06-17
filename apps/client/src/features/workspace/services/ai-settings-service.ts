import api from "@/lib/api-client";

// Supported LLM providers/drivers.
export type AiDriver = "openai" | "gemini" | "ollama";

// Masked AI provider settings returned by the server.
// The API key is NEVER returned; only `hasApiKey` indicates whether one is stored.
export interface IAiSettings {
  driver?: AiDriver;
  chatModel?: string;
  embeddingModel?: string;
  baseUrl?: string;
  systemPrompt?: string;
  hasApiKey: boolean;
  // RAG indexing coverage (pages indexed for semantic search).
  indexedPages: number;
  totalPages: number;
}

// Update payload. Key semantics:
//   - omit `apiKey`        -> key unchanged
//   - `apiKey: ''`         -> clear the stored key
//   - `apiKey: 'non-empty'`-> set the key
// Non-secret fields are saved as given.
export interface IAiSettingsUpdate {
  driver?: AiDriver;
  chatModel?: string;
  embeddingModel?: string;
  baseUrl?: string;
  systemPrompt?: string;
  apiKey?: string;
}

// Result of a connection test against the configured provider.
// The error string is already sanitized server-side.
export interface IAiTestResult {
  ok: boolean;
  error?: string;
}

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

export async function testAiConnection(): Promise<IAiTestResult> {
  const req = await api.post<IAiTestResult>("/workspace/ai-settings/test");
  return req.data;
}
