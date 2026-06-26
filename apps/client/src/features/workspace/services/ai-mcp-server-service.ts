import api from "@/lib/api-client";

// External MCP server transports (mirrors the server's MCP_TRANSPORTS).
export type McpTransport = "http" | "sse";

// Admin-facing view of a configured external MCP server.
// SECURITY (§8.10): the auth headers are NEVER returned — only `hasHeaders`
// signals whether any are stored. `toolAllowlist` is null when unrestricted.
export interface IAiMcpServer {
  id: string;
  name: string;
  transport: McpTransport;
  url: string;
  enabled: boolean;
  toolAllowlist: string[] | null;
  hasHeaders: boolean;
  // Admin-authored guidance injected into the agent system prompt (#180).
  // NON-secret, so it IS returned. Null when no guidance is configured.
  instructions: string | null;
}

// Create payload. `headers` is write-only: omit => no auth headers.
export interface IAiMcpServerCreate {
  name: string;
  transport: McpTransport;
  url: string;
  // Auth headers map (e.g. { Authorization: 'Bearer ...' }). Encrypted on save;
  // never returned.
  headers?: Record<string, string>;
  toolAllowlist?: string[];
  // Admin-authored prompt guidance (#180). Blank => stored as null.
  instructions?: string;
  enabled?: boolean;
}

// Update payload. Every field is optional (partial update). `headers` semantics:
//   - omit            -> auth headers unchanged
//   - {} (empty)      -> auth headers cleared
//   - non-empty value -> auth headers replaced
export interface IAiMcpServerUpdate {
  id: string;
  name?: string;
  transport?: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  toolAllowlist?: string[];
  // Admin-authored prompt guidance (#180). Absent => unchanged; blank => cleared.
  instructions?: string;
  enabled?: boolean;
}

// Result of a "Test connection" against a SAVED server (by id).
// The error string is already sanitized server-side; never carries secrets.
export type IAiMcpServerTestResult =
  | { ok: true; tools: string[] }
  | { ok: false; error: string };

export async function getAiMcpServers(): Promise<IAiMcpServer[]> {
  const req = await api.post<IAiMcpServer[]>("/workspace/ai-mcp-servers");
  return req.data;
}

export async function createAiMcpServer(
  data: IAiMcpServerCreate,
): Promise<IAiMcpServer> {
  const req = await api.post<IAiMcpServer>(
    "/workspace/ai-mcp-servers/create",
    data,
  );
  return req.data;
}

export async function updateAiMcpServer(
  data: IAiMcpServerUpdate,
): Promise<IAiMcpServer> {
  const req = await api.post<IAiMcpServer>(
    "/workspace/ai-mcp-servers/update",
    data,
  );
  return req.data;
}

export async function deleteAiMcpServer(
  id: string,
): Promise<{ success: true }> {
  const req = await api.post<{ success: true }>(
    "/workspace/ai-mcp-servers/delete",
    { id },
  );
  return req.data;
}

// Tests a SAVED server by id (the server connects with the stored headers).
export async function testAiMcpServer(
  id: string,
): Promise<IAiMcpServerTestResult> {
  const req = await api.post<IAiMcpServerTestResult>(
    "/workspace/ai-mcp-servers/test",
    { id },
  );
  return req.data;
}
