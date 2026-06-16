import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createDocmostMcpServer, DocmostMcpConfig } from "./index.js";

/**
 * Build a stateful Streamable-HTTP handler for the Docmost MCP server. The
 * embedding host (the gitmost NestJS server) bridges its raw Node req/res into
 * `handleRequest`. One McpServer + transport is created per MCP session and
 * kept alive between requests, keyed by the `mcp-session-id` header.
 */
export function createMcpHttpHandler(config: DocmostMcpConfig) {
  // One transport (and one McpServer) per MCP session, keyed by session id.
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  // Last activity timestamp per session id, used for idle eviction.
  const lastSeen: Record<string, number> = {};

  // Idle session TTL (ms): a session with no activity for this long is evicted.
  // Defaults to 30 min; overridable via MCP_SESSION_IDLE_MS.
  const idleTtlMs = (() => {
    const parsed = parseInt(process.env.MCP_SESSION_IDLE_MS ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
  })();

  // Periodically close transports idle longer than the TTL. transport.close()
  // triggers its onclose, which removes it from `transports`; we also drop the
  // lastSeen entry. unref() so this timer never keeps the process alive.
  const sweepIntervalMs = 5 * 60 * 1000;
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const sid of Object.keys(transports)) {
      if (now - (lastSeen[sid] ?? 0) > idleTtlMs) {
        void transports[sid].close();
        delete lastSeen[sid];
      }
    }
  }, sweepIntervalMs);
  sweepTimer.unref();

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const method = (req.method || "GET").toUpperCase();
    let transport = sessionId ? transports[sessionId] : undefined;

    if (method === "POST" && !transport) {
      // A new session may only be created by an initialize request without a
      // session id.
      if (sessionId || !isInitializeRequest(parsedBody)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: no valid session ID provided",
            },
            id: null,
          }),
        );
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports[sid] = transport!;
          lastSeen[sid] = Date.now();
        },
      });
      transport.onclose = () => {
        const sid = transport!.sessionId;
        if (sid && transports[sid]) delete transports[sid];
      };
      const server = createDocmostMcpServer(config);
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (!transport) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: no valid session ID provided",
          },
          id: null,
        }),
      );
      return;
    }
    // Routing to an existing transport: refresh its idle timestamp.
    if (sessionId) lastSeen[sessionId] = Date.now();
    await transport.handleRequest(req, res, parsedBody);
  }

  return { handleRequest };
}
