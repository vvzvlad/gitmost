import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  acquireCollabSession,
  destroyAllSessions,
  __setCollabProviderFactory,
} from "../../build/lib/collab-session.js";
import { savePageVersionRealtime } from "../../build/lib/collaboration.js";

// #370 — unit coverage for the MCP client transport of the explicit save-version.
// There is no collaboration server in the test env, so a fake HocuspocusProvider
// drives the stateless round-trip: it auto-completes the connect/sync handshake on
// a microtask (like the real provider), records sends, and either auto-broadcasts a
// configured reply (`opts.reply`) or lets the test emit stateless messages /
// disconnects by hand (`_emitStateless` / `_disconnect`) to exercise the predicate
// filter, the teardown-mid-wait path, and the timeout.
class FakeProvider extends EventEmitter {
  static instances = [];

  static reset() {
    FakeProvider.instances = [];
  }

  static last() {
    return FakeProvider.instances[FakeProvider.instances.length - 1];
  }

  constructor(config, opts = {}) {
    super();
    this.config = config;
    this.synced = false;
    this.unsyncedChanges = 0;
    this.destroyed = false;
    this.sent = [];
    this.opts = opts;
    FakeProvider.instances.push(this);
    // Real HocuspocusProvider fires onSynced asynchronously after the handshake;
    // a microtask reproduces that without depending on timers (so mock.timers on
    // setTimeout does not stall the connect).
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.config.onConnect?.();
      this.synced = true;
      this.config.onSynced?.();
    });
  }

  destroy() {
    this.destroyed = true;
  }

  sendStateless(payload) {
    this.sent.push(payload);
    const reply = this.opts.reply;
    if (!reply) return; // silent → the caller times out, or the test drives it
    // Broadcast the configured server reply on a microtask, mirroring
    // document.broadcastStateless landing back on this provider's `stateless` event.
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.emit("stateless", { payload: JSON.stringify(reply) });
    });
  }

  // --- test drivers ---
  _emitStateless(obj) {
    this.emit("stateless", { payload: JSON.stringify(obj) });
  }
  _disconnect() {
    this.config.onDisconnect?.();
  }
}

const ENV_KEYS = [
  "MCP_COLLAB_SESSION_IDLE_MS",
  "MCP_COLLAB_SESSION_MAX_AGE_MS",
  "MCP_COLLAB_SESSION_MAX_ENTRIES",
  "MCP_COLLAB_TOKEN_TTL_MS",
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  FakeProvider.reset();
});

afterEach(() => {
  destroyAllSessions();
  __setCollabProviderFactory(null);
  mock.timers.reset();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const PAGE_A = "11111111-1111-4111-8111-111111111111";
const PAGE_B = "22222222-2222-4222-8222-222222222222";
const PAGE_C = "33333333-3333-4333-8333-333333333333";
const PAGE_D = "44444444-4444-4444-8444-444444444444";
const PAGE_E = "55555555-5555-4555-8555-555555555555";
const PAGE_F = "66666666-6666-4666-8666-666666666666";

// --- happy paths (resolve with the server's terminal reply) -----------------

test("saved: resolves { saved:true, historyId, kind, alreadySaved }", async () => {
  __setCollabProviderFactory(
    (config) =>
      new FakeProvider(config, {
        reply: {
          type: "version.saved",
          historyId: "hist-42",
          kind: "agent",
          alreadySaved: false,
        },
      }),
  );

  const result = await savePageVersionRealtime(PAGE_A, "collab-tok", "http://host/api");

  assert.deepEqual(result, {
    saved: true,
    historyId: "hist-42",
    kind: "agent",
    alreadySaved: false,
  });
  // The client actually asked the server to save a version (the stateless send).
  assert.deepEqual(
    FakeProvider.last().sent.map((p) => JSON.parse(p)),
    [{ type: "save-version" }],
  );
});

test("saved: surfaces alreadySaved=true (promote-not-dup / no-op save)", async () => {
  __setCollabProviderFactory(
    (config) =>
      new FakeProvider(config, {
        reply: {
          type: "version.saved",
          historyId: "hist-7",
          kind: "manual",
          alreadySaved: true,
        },
      }),
  );

  const result = await savePageVersionRealtime(PAGE_B, "collab-tok", "http://host/api");

  assert.deepEqual(result, {
    saved: true,
    historyId: "hist-7",
    kind: "manual",
    alreadySaved: true,
  });
});

// --- F2: terminal SKIP replies (no timeout, no false "unreachable") ---------

test("F2 skip: an empty-page reply resolves to a clean { saved:false, skipped:true, reason:'empty' } — no timeout", async () => {
  __setCollabProviderFactory(
    (config) =>
      new FakeProvider(config, {
        reply: { type: "version.skipped", reason: "empty" },
      }),
  );

  const result = await savePageVersionRealtime(PAGE_C, "collab-tok", "http://host/api");

  assert.deepEqual(result, { saved: false, skipped: true, reason: "empty" });
});

test("F2 skip: a page-not-found reply throws an immediate, truthful error (not the health-timeout path)", async () => {
  __setCollabProviderFactory(
    (config) =>
      new FakeProvider(config, {
        reply: { type: "version.skipped", reason: "page-not-found" },
      }),
  );

  await assert.rejects(
    savePageVersionRealtime(PAGE_D, "collab-tok", "http://host/api"),
    /was not found on the collaboration server/,
  );
});

// --- F1 (a): predicate filters unrelated messages, resolves on the real reply ---

test("F1(a) unrelated-then-real: an unrelated stateless message does NOT resolve; the later version.saved does", async () => {
  __setCollabProviderFactory((config) => new FakeProvider(config, {})); // manual drive

  const p = savePageVersionRealtime(PAGE_E, "collab-tok", "http://host/api");
  // Let acquire's handshake + the stateless send complete so the listener is armed.
  await new Promise((r) => setImmediate(r));
  const provider = FakeProvider.last();

  // Noise first: an unrelated stateless type (e.g. another feature's broadcast).
  provider._emitStateless({ type: "something-else", historyId: "NOPE" });
  // The wait must still be pending — a microtask turn would have resolved it if the
  // predicate wrongly matched.
  let settledEarly = false;
  p.then(() => (settledEarly = true)).catch(() => (settledEarly = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(settledEarly, false, "resolved on an unrelated stateless message");

  // Now the real reply arrives → it resolves with that payload.
  provider._emitStateless({
    type: "version.saved",
    historyId: "h-real",
    kind: "agent",
    alreadySaved: false,
  });
  const result = await p;
  assert.deepEqual(result, {
    saved: true,
    historyId: "h-real",
    kind: "agent",
    alreadySaved: false,
  });
});

// --- F1 (b): teardown mid-wait rejects AND removes the stateless listener -----

test("F1(b) teardown mid-wait: a disconnect rejects the wait with the connection-loss error AND removes the stateless listener (no leak)", async () => {
  __setCollabProviderFactory((config) => new FakeProvider(config, {})); // silent

  const session = await acquireCollabSession(PAGE_F, "collab-tok", "http://host/api");
  const provider = FakeProvider.last();

  const p = session.sendStatelessAndAwait(
    JSON.stringify({ type: "save-version" }),
    (m) => (m && m.type === "version.saved" ? m : undefined),
    20000,
  );
  // Swallow the eventual rejection so it does not race the assertions below.
  p.catch(() => {});
  await new Promise((r) => setImmediate(r));

  // The wait armed exactly one stateless listener.
  assert.equal(
    provider.listenerCount("stateless"),
    1,
    "the wait must register one stateless listener",
  );

  // A disconnect tears the session down mid-wait.
  provider._disconnect();

  await assert.rejects(p, /connection closed before the update was persisted/);
  // The listener was removed on teardown — dropping provider.off() reds this.
  assert.equal(
    provider.listenerCount("stateless"),
    0,
    "the stateless listener leaked after teardown",
  );
});

// --- F1 (c): concurrent-in-flight guard fails fast, no cross-wiring -----------

test("F1(c) concurrent guard: a second sendStatelessAndAwait while one is in flight fails fast", async () => {
  __setCollabProviderFactory((config) => new FakeProvider(config, {})); // silent

  const session = await acquireCollabSession(PAGE_A, "collab-tok", "http://host/api");

  const first = session.sendStatelessAndAwait(
    JSON.stringify({ type: "save-version" }),
    (m) => (m && m.type === "version.saved" ? m : undefined),
    20000,
  );
  first.catch(() => {}); // it stays pending until afterEach destroys the session

  await assert.rejects(
    session.sendStatelessAndAwait(
      JSON.stringify({ type: "save-version" }),
      (m) => (m && m.type === "version.saved" ? m : undefined),
      20000,
    ),
    /already in-flight/,
  );
});

// --- timeout: NO reply at all is the genuine "server unreachable" path --------

test("timeout: rejects on a bounded timeout when the server never replies", async () => {
  __setCollabProviderFactory((config) => new FakeProvider(config, {})); // silent

  mock.timers.enable({ apis: ["setTimeout"] });
  const p = savePageVersionRealtime(PAGE_B, "collab-tok", "http://host/api");
  // Swallow the eventual rejection so an unhandled-rejection does not race the tick.
  p.catch(() => {});

  // Flush the (microtask-driven) connect handshake + the stateless send so the
  // ack timer is armed before we advance the clock.
  await new Promise((r) => setImmediate(r));
  // Advance well past the 20s ack window; the connect timer (25s) does not fire.
  mock.timers.tick(20000 + 100);

  await assert.rejects(p, /Timeout waiting for a stateless reply/);
});
