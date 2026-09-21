import { IAiMcpServer } from "./mcp-server-types.ts";

// Resolve the tool allowlist value to persist from the form field.
//
// An empty tag field normally means "no restriction" and is sent as null so
// the server drops the column (all tools allowed). But a server that was
// ALREADY deny-all (a stored literal `[]`, meaning zero tools — creatable via
// the API) loads into the form as an empty field too. Coercing that empty
// field to null on submit would SILENTLY widen a deny-all server to allow-all
// on any routine edit (rename, toggle) — the exact silent-widen class #476
// closed on the read side. So when the edited server was deny-all, preserve
// `[]` (deny-all); only a genuinely-unrestricted server (stored null/absent)
// stays null.
export function resolveToolAllowlist(
  fieldValue: string[],
  server?: Pick<IAiMcpServer, "toolAllowlist">,
): string[] | null {
  if (fieldValue.length > 0) return fieldValue;
  const wasDenyAll =
    Array.isArray(server?.toolAllowlist) && server.toolAllowlist.length === 0;
  return wasDenyAll ? [] : null;
}
