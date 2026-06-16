#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDocmostMcpServer } from "./index.js";

// Standalone stdio entrypoint. This restores the original behavior of the
// package when run as a CLI (`docmost-mcp`): it reads credentials from the
// environment and serves the MCP protocol over stdin/stdout. The factory in
// index.ts stays side-effect-free; all the process/transport lifecycle lives
// here.

const API_URL = process.env.DOCMOST_API_URL;
const EMAIL = process.env.DOCMOST_EMAIL;
const PASSWORD = process.env.DOCMOST_PASSWORD;

if (!API_URL || !EMAIL || !PASSWORD) {
  console.error(
    "Error: DOCMOST_API_URL, DOCMOST_EMAIL, and DOCMOST_PASSWORD environment variables are required.",
  );
  process.exit(1);
}

async function run() {
  // Global safety nets so a stray rejection/exception cannot silently kill
  // the stdio server. Per-tool errors still flow through the SDK and are not
  // affected by these handlers; these only catch errors raised OUTSIDE a tool
  // call (e.g. a transient ws/collab socket "error" event). Such errors must
  // NOT tear down the whole stdio server, so we log only and keep running.
  // Genuine startup failures are still fatal via run().catch(...) below.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
  });

  const server = createDocmostMcpServer({
    apiUrl: API_URL!,
    email: EMAIL!,
    password: PASSWORD!,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
