// Canonical client-side types for external MCP servers (#686).
//
// SINGLE SOURCE OF TRUTH (AGENTS invariant #7): both the admin path
// (`features/workspace/services/ai-mcp-server-service.ts`, POSTs to
// `/workspace/ai-mcp-servers*`) and the personal path
// (`features/account-mcp/services/account-mcp-server-service.ts`, POSTs to
// `/account/mcp-servers*`) speak the SAME wire shape, so these interfaces live
// in one place and are imported (never re-declared) by both services. The
// admin service re-exports them for backwards compatibility with existing
// import sites.

// External MCP server transports (mirrors the server's MCP_TRANSPORTS).
export type McpTransport = "http" | "sse";

// View of a configured external MCP server.
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
  // Author-supplied guidance injected into the agent system prompt (#180).
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
  // Omit/null => no restriction; `[]` is persisted verbatim and means
  // deny-all (zero tools) since #476.
  toolAllowlist?: string[] | null;
  // Author-supplied prompt guidance (#180). Blank => stored as null.
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
  // Absent => unchanged; null => no restriction; `[]` is persisted verbatim
  // and means deny-all (zero tools) since #476.
  toolAllowlist?: string[] | null;
  // Author-supplied prompt guidance (#180). Absent => unchanged; blank => cleared.
  instructions?: string;
  enabled?: boolean;
}

// Result of a "Test connection" against a SAVED server (by id).
// The error string is already sanitized server-side; never carries secrets.
export type IAiMcpServerTestResult =
  | { ok: true; tools: string[] }
  | { ok: false; error: string };
