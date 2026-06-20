// Unit tests for createMcpHttpHandler's config-resolver + anti-fixation hook
// (http.ts). These assert the wrapper contract WITHOUT depending on the MCP
// SDK's full initialize handshake succeeding:
//   - a STATIC config is still accepted (back-compat: stdio / service account)
//     and never invokes a resolver;
//   - a RESOLVER is accepted and is invoked exactly once on a session-init POST;
//   - the resolver/identify path runs BEFORE the transport, so a thrown
//     resolver error surfaces as a clean 401 and no session is created.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createMcpHttpHandler } from "../../build/http.js";

// A minimal initialize JSON-RPC request body (isInitializeRequest checks
// method === "initialize" + jsonrpc + an object params with protocolVersion).
const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  },
};

// Fake Node req: a readable stream is fine; we pass parsedBody explicitly so the
// transport never reads the stream, and our resolver short-circuits before that.
function makeReq({ method = "POST", headers = {} } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.headers = headers;
  req.push(null);
  return req;
}

// Fake Node res capturing statusCode + body, mimicking just what http.ts uses.
function makeRes() {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(data) {
      if (data) chunks.push(data);
      this.headersSent = true;
      this.ended = true;
    },
    body() {
      return chunks.join("");
    },
  };
}

test("static config is accepted and never calls a resolver (back-compat)", async () => {
  // A static config object — the stdio / service-account path. A NON-initialize
  // POST with no session id must hit the 400 branch deterministically, proving
  // the static handler is wired and no resolver is consulted.
  const handler = createMcpHttpHandler({
    apiUrl: "http://127.0.0.1:3000/api",
    email: "svc@example.com",
    password: "secret",
  });
  const req = makeReq({ method: "POST", headers: {} });
  const res = makeRes();
  await handler.handleRequest(req, res, { jsonrpc: "2.0", method: "ping", id: 9 });
  assert.equal(res.statusCode, 400);
  assert.match(res.body(), /no valid session ID/);
});

test("resolver is invoked exactly once on a session-init POST", async () => {
  let calls = 0;
  const handler = createMcpHttpHandler((req) => {
    calls += 1;
    // Throw a sentinel so we observe invocation without driving the full
    // SDK handshake; http.ts turns a resolver throw into a clean 401.
    throw new Error("sentinel-from-resolver");
  });
  const req = makeReq({ method: "POST", headers: {} });
  const res = makeRes();
  await handler.handleRequest(req, res, INIT_BODY);
  assert.equal(calls, 1, "resolver must be called exactly once per init");
  assert.equal(res.statusCode, 401);
  assert.match(res.body(), /sentinel-from-resolver/);
});

test("resolver is NOT invoked for a non-init POST without a session id", async () => {
  let calls = 0;
  const handler = createMcpHttpHandler(() => {
    calls += 1;
    return { apiUrl: "http://127.0.0.1:3000/api", getToken: async () => "t" };
  });
  const req = makeReq({ method: "POST", headers: {} });
  const res = makeRes();
  await handler.handleRequest(req, res, { jsonrpc: "2.0", method: "ping", id: 2 });
  assert.equal(calls, 0);
  assert.equal(res.statusCode, 400);
});

test("identify hook throwing on init surfaces as a clean 401", async () => {
  const handler = createMcpHttpHandler(
    () => ({ apiUrl: "http://127.0.0.1:3000/api", getToken: async () => "t" }),
    {
      identify: () => {
        throw new Error("bad-identity");
      },
    },
  );
  const req = makeReq({ method: "POST", headers: {} });
  const res = makeRes();
  await handler.handleRequest(req, res, INIT_BODY);
  assert.equal(res.statusCode, 401);
  assert.match(res.body(), /bad-identity/);
});

// Drive a REAL initialize handshake (over a loopback http server so the SDK's
// StreamableHTTPServerTransport gets genuine Node req/res objects), capture the
// assigned mcp-session-id, then replay subsequent requests to exercise the
// anti-fixation identify comparison: the SAME identity is accepted (routed to
// the transport), a DIFFERENT identity is rejected 401, and crucially the
// per-session config RESOLVER is consulted only ONCE (at init), never on a
// subsequent request — proving subsequent requests do not re-mint the config.
test("subsequent request: SAME identity routes through, DIFFERENT identity is 401, resolver runs once", async () => {
  const http = await import("node:http");

  let resolverCalls = 0;
  let currentIdentity = "user-a";
  const handler = createMcpHttpHandler(
    () => {
      resolverCalls += 1;
      return { apiUrl: "http://127.0.0.1:3000/api", getToken: async () => "t" };
    },
    { identify: () => currentIdentity },
  );

  // Loopback server: every request is bridged into the MCP handler with its body
  // parsed from JSON, exactly like the embedding host does.
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      handler.handleRequest(req, res, body).catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const call = (headers, body) =>
    new Promise((resolve) => {
      const r = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...headers,
          },
        },
        (resp) => {
          let data = "";
          resp.on("data", (c) => (data += c));
          resp.on("end", () =>
            resolve({
              statusCode: resp.statusCode,
              sessionId: resp.headers["mcp-session-id"],
              body: data,
            }),
          );
        },
      );
      r.end(JSON.stringify(body));
    });

  try {
    // 1) Establish a session via a real initialize POST (identity = user-a).
    const init = await call({}, INIT_BODY);
    assert.equal(resolverCalls, 1, "resolver runs exactly once at init");
    const sid = init.sessionId;
    assert.ok(sid, "initialize must assign an mcp-session-id");

    // 2) Subsequent request, SAME identity: not a 401, resolver NOT re-run.
    const ok = await call(
      { "mcp-session-id": sid },
      { jsonrpc: "2.0", method: "ping", id: 5 },
    );
    assert.notEqual(ok.statusCode, 401, "same identity must not be rejected");
    assert.equal(resolverCalls, 1, "resolver is NOT re-run on a subsequent request");

    // 3) Subsequent request, DIFFERENT identity: rejected 401 (anti-fixation).
    currentIdentity = "user-b";
    const bad = await call(
      { "mcp-session-id": sid },
      { jsonrpc: "2.0", method: "ping", id: 6 },
    );
    assert.equal(bad.statusCode, 401, "different identity hijack is rejected");
    assert.match(bad.body, /do not match the user/);
    assert.equal(resolverCalls, 1, "still no resolver re-run on the rejected request");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("unknown existing session id (non-init, with session header) is 400", async () => {
  // A request carrying a session id that was never established must not consult
  // the resolver or identify hook — it is a plain 400 (no valid session).
  let calls = 0;
  const handler = createMcpHttpHandler(
    () => {
      calls += 1;
      return { apiUrl: "http://127.0.0.1:3000/api", getToken: async () => "t" };
    },
    { identify: () => "x" },
  );
  const req = makeReq({
    method: "POST",
    headers: { "mcp-session-id": "does-not-exist" },
  });
  const res = makeRes();
  await handler.handleRequest(req, res, { jsonrpc: "2.0", method: "ping", id: 3 });
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});
