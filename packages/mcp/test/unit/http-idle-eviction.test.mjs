// Unit tests for createMcpHttpHandler's idle-session eviction (http.ts).
//
// http.ts keeps one transport per MCP session alive between requests, keyed by
// the mcp-session-id header, and runs a periodic sweep (setInterval, every 5
// min) that closes any transport idle longer than the idle TTL
// (MCP_SESSION_IDLE_MS, default 30 min) and drops its lastSeen + sessionIdentity
// bookkeeping. Routing a request to an existing transport refreshes its
// lastSeen.
//
// We drive this DETERMINISTICALLY rather than waiting wall-clock: the env knob
// MCP_SESSION_IDLE_MS is read ONCE when the handler is created, so we set it
// small; and node:test's mock.timers lets us mock both `setInterval` (the sweep)
// and `Date` (the lastSeen comparison clock) so ticking advances the clock and
// fires the sweep on demand.
//
// IMPORTANT mock.timers semantics: when a tick spans MULTIPLE timer fires (or
// overshoots a fire), the callbacks all observe Date.now() == the FINAL ticked
// time, not their individual scheduled times. So to make the sweep's
// `now - lastSeen` comparison meaningful we tick EXACTLY to a sweep boundary
// (a multiple of the sweep interval): then Date.now() inside the sweep equals
// that boundary. The mocked clock starts at 0, so sweeps fire at SWEEP, 2*SWEEP,
// ... We pin each session's lastSeen by establishing/touching it at a known
// pre-boundary clock, then tick the remaining delta to land exactly on the
// boundary.
//
// Sessions are established over a real loopback http server (so the SDK's
// StreamableHTTPServerTransport gets genuine Node req/res and a real
// mcp-session-id), exactly like http-resolver.test.mjs, and the server is closed
// in a finally.
//
// Eviction is asserted via its OBSERVABLE effect: once a session is evicted its
// transport is gone from the handler's internal map, so a subsequent non-init
// request replaying that session id is treated as unknown (400 "no valid
// session ID") — the same response an id that was never established would get.
// An active (recently-seen) session is retained and its subsequent request is
// NOT a 400.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

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

const SWEEP_MS = 5 * 60 * 1000; // setInterval cadence in http.ts.

// Spin a loopback http server bridging every request into the MCP handler with
// its JSON body parsed, mirroring the embedding host. Returns { call, close }.
async function startLoopback(handler) {
  const http = await import("node:http");
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

  return { call, close: () => new Promise((r) => server.close(r)) };
}

// The sweep closes transports asynchronously (void transport.close()), whose
// onclose then removes the entry from the internal map. Yield to the event loop
// so those microtasks settle before we assert the observable effect.
const settle = () => new Promise((r) => setImmediate(r));

// Set the idle TTL env knob (read once at handler creation) and enable mocked
// setInterval + Date BEFORE creating the handler, so the sweep interval and
// every Date.now() (lastSeen at init, lastSeen on routing, and the sweep's
// comparison) all run on the same mocked clock. Returns restore() to undo it.
function withMockedTimers(idleMs) {
  const prevIdle = process.env.MCP_SESSION_IDLE_MS;
  process.env.MCP_SESSION_IDLE_MS = String(idleMs);
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  return () => {
    mock.timers.reset();
    if (prevIdle === undefined) delete process.env.MCP_SESSION_IDLE_MS;
    else process.env.MCP_SESSION_IDLE_MS = prevIdle;
  };
}

test("idle session is evicted by the sweep; an active session is retained", async () => {
  // A small TTL: idle longer than 1s triggers eviction. Both sessions start at
  // clock 0; we keep one fresh (touch it just before the sweep) and leave the
  // other idle, then fire ONE sweep exactly on its boundary.
  const idleMs = 1000;
  const restore = withMockedTimers(idleMs);

  const { createMcpHttpHandler } = await import("../../build/http.js");
  const handler = createMcpHttpHandler(() => ({
    apiUrl: "http://127.0.0.1:3000/api",
    getToken: async () => "t",
  }));

  const lb = await startLoopback(handler);
  try {
    // T0 (clock 0): establish both sessions; lastSeen(A) = lastSeen(B) = 0.
    const a = await lb.call({}, INIT_BODY);
    const b = await lb.call({}, INIT_BODY);
    assert.ok(a.sessionId, "session A must get an mcp-session-id");
    assert.ok(b.sessionId, "session B must get an mcp-session-id");
    assert.notEqual(a.sessionId, b.sessionId, "distinct sessions");

    // Advance to just before the first sweep boundary (SWEEP - 1ms): no sweep
    // fires yet (boundary not reached). lastSeen(A) stays 0.
    mock.timers.tick(SWEEP_MS - 1);
    // Touch ONLY B here, refreshing lastSeen(B) to SWEEP-1 (active); A is left
    // idle since clock 0.
    const touchB = await lb.call(
      { "mcp-session-id": b.sessionId },
      { jsonrpc: "2.0", method: "ping", id: 5 },
    );
    assert.notEqual(touchB.statusCode, 400, "B alive right before the sweep");

    // Land EXACTLY on the sweep boundary (clock = SWEEP). Inside the sweep
    // Date.now() == SWEEP, so:
    //   idle(A) = SWEEP - 0       = SWEEP   > TTL(1s)  -> A EVICTED
    //   idle(B) = SWEEP - (SWEEP-1) = 1ms   < TTL(1s)  -> B RETAINED
    mock.timers.tick(1);
    await settle();

    // OBSERVABLE EFFECT 1 — A evicted: replaying its session id on a non-init
    // request is now treated as unknown (400, no valid session).
    const aAfter = await lb.call(
      { "mcp-session-id": a.sessionId },
      { jsonrpc: "2.0", method: "ping", id: 10 },
    );
    assert.equal(aAfter.statusCode, 400, "evicted session id is unknown -> 400");
    assert.match(aAfter.body, /no valid session ID/);

    // OBSERVABLE EFFECT 2 — B retained: a subsequent request on its session id
    // is routed to the live transport, NOT rejected as an unknown session.
    const bAfter = await lb.call(
      { "mcp-session-id": b.sessionId },
      { jsonrpc: "2.0", method: "ping", id: 11 },
    );
    assert.notEqual(
      bAfter.statusCode,
      400,
      "active session must survive the sweep (not 400)",
    );
  } finally {
    await lb.close();
    restore();
  }
});

test("a session left idle past the TTL is dropped so its id becomes unknown", async () => {
  // Simplest single-session eviction: establish a session, let it go idle past
  // the TTL, fire the sweep on its boundary, and confirm its id is now unknown
  // (400). Pins the core "lastSeen older than TTL -> closed and dropped" path.
  const idleMs = 1000;
  const restore = withMockedTimers(idleMs);

  const { createMcpHttpHandler } = await import("../../build/http.js");
  const handler = createMcpHttpHandler(() => ({
    apiUrl: "http://127.0.0.1:3000/api",
    getToken: async () => "t",
  }));

  const lb = await startLoopback(handler);
  try {
    const s = await lb.call({}, INIT_BODY);
    assert.ok(s.sessionId, "session must get an mcp-session-id");

    // Fire the first sweep exactly on its boundary: Date.now() == SWEEP, idle =
    // SWEEP - 0 = SWEEP > TTL, so the untouched session is evicted.
    mock.timers.tick(SWEEP_MS);
    await settle();

    const after = await lb.call(
      { "mcp-session-id": s.sessionId },
      { jsonrpc: "2.0", method: "ping", id: 30 },
    );
    assert.equal(after.statusCode, 400, "idle session id is unknown -> 400");
    assert.match(after.body, /no valid session ID/);
  } finally {
    await lb.close();
    restore();
  }
});

test("activity refreshes lastSeen so a busy session is never evicted", async () => {
  // A session kept busy (a request just before the sweep) refreshes its
  // lastSeen, so even though it was created long ago the sweep must not evict
  // it. Pins the "routing to an existing transport refreshes its idle
  // timestamp" branch of http.ts.
  const idleMs = 1000;
  const restore = withMockedTimers(idleMs);

  const { createMcpHttpHandler } = await import("../../build/http.js");
  const handler = createMcpHttpHandler(() => ({
    apiUrl: "http://127.0.0.1:3000/api",
    getToken: async () => "t",
  }));

  const lb = await startLoopback(handler);
  try {
    const s = await lb.call({}, INIT_BODY);
    assert.ok(s.sessionId, "session must get an mcp-session-id");

    // Age to just before the sweep boundary, then touch the session so its
    // lastSeen is refreshed to SWEEP-1 (well within the TTL of the imminent
    // sweep).
    mock.timers.tick(SWEEP_MS - 1);
    const touch = await lb.call(
      { "mcp-session-id": s.sessionId },
      { jsonrpc: "2.0", method: "ping", id: 40 },
    );
    assert.notEqual(touch.statusCode, 400, "session still alive before sweep");

    // Land exactly on the sweep boundary: idle = SWEEP - (SWEEP-1) = 1ms < TTL,
    // so the busy session is retained.
    mock.timers.tick(1);
    await settle();

    const after = await lb.call(
      { "mcp-session-id": s.sessionId },
      { jsonrpc: "2.0", method: "ping", id: 41 },
    );
    assert.notEqual(
      after.statusCode,
      400,
      "a session touched just before the sweep must not be evicted",
    );
  } finally {
    await lb.close();
    restore();
  }
});
