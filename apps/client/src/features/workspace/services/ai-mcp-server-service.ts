import api from "@/lib/api-client";
// Canonical types live in the shared MCP module (#686, AGENTS invariant #7) so
// the admin and personal paths cannot drift. Re-exported here to keep existing
// admin import sites working.
export type {
  McpTransport,
  IAiMcpServer,
  IAiMcpServerCreate,
  IAiMcpServerUpdate,
  IAiMcpServerTestResult,
} from "@/features/ai-mcp/mcp-server-types.ts";
import type {
  IAiMcpServer,
  IAiMcpServerCreate,
  IAiMcpServerUpdate,
  IAiMcpServerTestResult,
} from "@/features/ai-mcp/mcp-server-types.ts";

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
