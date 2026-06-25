import { Timestamp, Generated } from '@docmost/db/types/db';

// ai_mcp_servers type
// Hand-written (not generated) because codegen requires a live DB.
// Mirrors the migration 20260617T130000-ai-mcp-servers.ts.
//
// SECURITY (§8.10/§8.11): `headersEnc` is the AES-256-GCM blob of the per-server
// auth headers (the external service's API key, e.g. Tavily). It is WRITE-ONLY:
// it must NEVER be added to workspace `baseFields`, returned by any endpoint, or
// written to logs. Only the server-side MCP client layer decrypts it.
export interface AiMcpServers {
  id: Generated<string>;
  workspaceId: string;
  // Display name, e.g. 'Tavily'. Also drives the tool-name namespace prefix.
  name: string;
  // '@ai-sdk/mcp' transport type: 'http' | 'sse'.
  transport: string;
  // Remote MCP endpoint URL.
  url: string;
  // Encrypted JSON of the auth headers. Nullable (a server may need no auth).
  headersEnc: string | null;
  // Optional allowlist of remote tool names to expose; null = expose all.
  // Stored as jsonb. The postgres driver may return a JSON string for legacy
  // double-encoded rows; `AiMcpServerRepo` normalizes every read to
  // `string[] | null` via `parseToolAllowlist`.
  toolAllowlist: string[] | null;
  // Admin-authored guidance ("how/when to use this server's tools") injected
  // into the agent system prompt (#180). Unlike `headersEnc` this is NON-secret
  // and IS returned in admin views/forms. Plain text column (no jsonb). Null =
  // no guidance. Trusted text — it goes inside the prompt safety sandwich.
  instructions: string | null;
  enabled: Generated<boolean>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}
