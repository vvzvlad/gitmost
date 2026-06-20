import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createDocmostMcpServer, DocmostMcpConfig } from "./index.js";

/**
 * Per-request config resolver. Run ONCE per MCP session, at the `initialize`
 * POST, so the session's DocmostClient is bound to that request's identity
 * (e.g. the HTTP-Basic user the embedding host validated). Back-compat: a plain
 * `DocmostMcpConfig` object is still accepted (stdio + service account), in
 * which case the resolver branch is never taken.
 */
export type McpConfigResolver = (
  req: IncomingMessage,
) => DocmostMcpConfig | Promise<DocmostMcpConfig>;

/**
 * Optional anti-session-fixation hook. When supplied, it is called on EVERY
 * request (init and subsequent) to derive an opaque identity key for the
 * presented credentials/token. The key resolved at session init is bound to the
 * `mcp-session-id`; a later request whose key differs is rejected with 401, so
 * a caller cannot hijack another user's established session by reusing its
 * session id with different credentials. The key is opaque to this package (the
 * embedding host decides what identity means, e.g. the user's `sub`/email), so
 * the package stays generic. Throwing here surfaces as a 401 as well.
 */
export interface McpHttpOptions {
  identify?: (req: IncomingMessage) => string | Promise<string>;
}

/**
 * Build a stateful Streamable-HTTP handler for the Docmost MCP server. The
 * embedding host (the gitmost NestJS server) bridges its raw Node req/res into
 * `handleRequest`. One McpServer + transport is created per MCP session and
 * kept alive between requests, keyed by the `mcp-session-id` header.
 *
 * `config` is EITHER a static `DocmostMcpConfig` (back-compat: stdio + the env
 * service account, unchanged) OR a `McpConfigResolver` run once per session at
 * `initialize` to bind that session to the request's identity.
 */
export function createMcpHttpHandler(
  config: DocmostMcpConfig | McpConfigResolver,
  options: McpHttpOptions = {},
) {
  // One transport (and one McpServer) per MCP session, keyed by session id.
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  // Last activity timestamp per session id, used for idle eviction.
  const lastSeen: Record<string, number> = {};
  // Anti-session-fixation: the opaque identity key bound to each session at
  // initialize. A later request for that session whose key differs is rejected.
  const sessionIdentity: Record<string, string> = {};

  // Write a JSON-RPC error and end the response. Used for the 400/401 paths so
  // every early rejection is a well-formed JSON-RPC error, not a torn response.
  const sendJsonRpcError = (
    res: ServerResponse,
    statusCode: number,
    code: number,
    message: string,
  ): void => {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
      }),
    );
  };

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
        delete sessionIdentity[sid];
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
        sendJsonRpcError(
          res,
          400,
          -32000,
          "Bad Request: no valid session ID provided",
        );
        return;
      }
      // Resolve the per-session config from the request (per-user identity) when
      // a resolver was supplied; otherwise use the static config unchanged. The
      // resolver may throw (e.g. bad credentials) — surface a clean 401, never
      // a created session.
      let sessionConfig: DocmostMcpConfig;
      let identity: string | undefined;
      try {
        sessionConfig =
          typeof config === "function" ? await config(req) : config;
        if (options.identify) identity = await options.identify(req);
      } catch (err) {
        sendJsonRpcError(
          res,
          401,
          -32001,
          err instanceof Error ? err.message : "Unauthorized",
        );
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports[sid] = transport!;
          lastSeen[sid] = Date.now();
          // Bind the resolved identity to the new session id for anti-fixation.
          if (identity !== undefined) sessionIdentity[sid] = identity;
        },
      });
      transport.onclose = () => {
        const sid = transport!.sessionId;
        if (sid && transports[sid]) delete transports[sid];
        if (sid) delete sessionIdentity[sid];
      };
      const server = createDocmostMcpServer(sessionConfig);
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (!transport) {
      sendJsonRpcError(
        res,
        400,
        -32000,
        "Bad Request: no valid session ID provided",
      );
      return;
    }

    // Anti-session-fixation: a request reusing an existing session id must
    // present credentials/token that resolve to the SAME identity bound at
    // initialize, otherwise reject with 401. This prevents hijacking another
    // user's established session by replaying its session id with different
    // credentials.
    if (options.identify && sessionId && sessionId in sessionIdentity) {
      let presented: string;
      try {
        presented = await options.identify(req);
      } catch (err) {
        sendJsonRpcError(
          res,
          401,
          -32001,
          err instanceof Error ? err.message : "Unauthorized",
        );
        return;
      }
      if (presented !== sessionIdentity[sessionId]) {
        sendJsonRpcError(
          res,
          401,
          -32001,
          "Credentials do not match the user that owns this MCP session.",
        );
        return;
      }
    }

    // Routing to an existing transport: refresh its idle timestamp.
    if (sessionId) lastSeen[sessionId] = Date.now();
    await transport.handleRequest(req, res, parsedBody);
  }

  return { handleRequest };
}
