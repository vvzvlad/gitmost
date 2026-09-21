import api from "@/lib/api-client";
// Personal external MCP servers (#686). Same wire shape as the admin path, so
// the types come from the shared MCP module (single source of truth). These
// endpoints are scoped to the calling user by the server (`/account/mcp-servers*`,
// JWT-only, no CASL) — see PR A's `AccountMcpServersController`.
import type {
  IAiMcpServer,
  IAiMcpServerCreate,
  IAiMcpServerUpdate,
  IAiMcpServerTestResult,
} from "@/features/ai-mcp/mcp-server-types.ts";

export async function getAccountMcpServers(): Promise<IAiMcpServer[]> {
  const req = await api.post<IAiMcpServer[]>("/account/mcp-servers");
  return req.data;
}

export async function createAccountMcpServer(
  data: IAiMcpServerCreate,
): Promise<IAiMcpServer> {
  const req = await api.post<IAiMcpServer>("/account/mcp-servers/create", data);
  return req.data;
}

export async function updateAccountMcpServer(
  data: IAiMcpServerUpdate,
): Promise<IAiMcpServer> {
  const req = await api.post<IAiMcpServer>("/account/mcp-servers/update", data);
  return req.data;
}

export async function deleteAccountMcpServer(
  id: string,
): Promise<{ success: true }> {
  const req = await api.post<{ success: true }>("/account/mcp-servers/delete", {
    id,
  });
  return req.data;
}

// Tests a SAVED personal server by id (the server connects with the stored
// headers, under the calling user's ownership).
export async function testAccountMcpServer(
  id: string,
): Promise<IAiMcpServerTestResult> {
  const req = await api.post<IAiMcpServerTestResult>(
    "/account/mcp-servers/test",
    { id },
  );
  return req.data;
}
