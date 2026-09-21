import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  acquireCollabSession,
  destroyAllSessions,
  isCollabIndeterminateError,
  __setCollabProviderFactory,
  __sessionCountForTests,
} from "../../build/lib/collab-session.js";
import { withPageLock } from "../../build/lib/page-lock.js";
import { DocmostClient } from "../../build/client.js";

// A stand-in for HocuspocusProvider: it shares the ydoc (so the real yjs
// read/transform/write in CollabSession.mutate runs unchanged), auto-completes
// the connect+sync handshake on a microtask (unaffected by mock timers), and
// exposes hooks to drive disconnect/close/auth-failure and the unsyncedChanges
// ack. There is no collaboration server in the test env, so every test drives
// the provider through this fake.
class FakeProvider extends EventEmitter {
  static instances = [];
  static connectCount = 0;

  static reset() {
    FakeProvider.instances = [];
    FakeProvider.connectCount = 0;
  }

  static last() {
    return FakeProvider.instances[FakeProvider.instances.length - 1];
  }

  constructor(config, opts = {}) {
    super();
    this.config = config;
    this.ydoc = config.document;
    this.synced = false;
    this.unsyncedChanges = opts.unsynced ?? 0;
    this.destroyed = false;
    FakeProvider.instances.push(this);
    FakeProvider.connectCount += 1;
    if (opts.autoSync !== false) {
      // Real HocuspocusProvider fires onSynced asynchronously after the
      // handshake; a microtask reproduces that without depending on timers.
      queueMicrotask(() => {
        if (this.destroyed) return;
        this.config.onConnect?.();
        this.synced = true;
        this.config.onSynced?.();
      });
    }
  }

  destroy() {
    this.destroyed = true;
  }

  // --- test drivers ---
  _disconnect() {
    this.config.onDisconnect?.();
  }
  _close() {
    this.config.onClose?.();
  }
  _authFail() {
    this.config.onAuthenticationFailed?.();
  }
  _ack() {
    this.unsyncedChanges = 0;
    this.emit("unsyncedChanges", { number: 0 });
  }
}

/** Build a provider factory that stamps every provider with the given opts. */
function factory(opts = {}) {
  return (config) => new FakeProvider(config, opts);
}

/** A minimal, schema-valid ProseMirror doc for a write. */
function docWith(text) {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: String(text) }] },
    ],
  };
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
  __setCollabProviderFactory(factory());
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

test("acquire opens one provider; reuse returns the SAME live session", async () => {
  const a = await acquireCollabSession("page-1", "tok", "http://h/api");
  const b = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.equal(a, b, "same (wsUrl,page,token) must reuse the session");
  assert.equal(FakeProvider.connectCount, 1, "exactly one connect/sync");
  assert.equal(__sessionCountForTests(), 1);
});

test("N mutates on one page open the provider ONCE (coalesced series)", async () => {
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  for (let i = 0; i < 20; i++) {
    const r = await session.mutate(() => docWith(`edit ${i}`));
    assert.ok(r && r.doc, "each mutate resolves a MutationResult");
  }
  assert.equal(
    FakeProvider.connectCount,
    1,
    "20 mutates must not reconnect — one live provider for the whole series",
  );
});

test("mutate preserves the transform-abort no-op report (null transform)", async () => {
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  const r = await session.mutate(() => null);
  assert.equal(r.verify.changed, false);
  assert.equal(r.verify.summary, "no changes (transform aborted)");
});

test("registry key includes the token: different tokens => different sessions", async () => {
  const a = await acquireCollabSession("page-1", "tok-A", "http://h/api");
  const b = await acquireCollabSession("page-1", "tok-B", "http://h/api");
  assert.notEqual(a, b, "different tokens must never share a session");
  assert.equal(FakeProvider.connectCount, 2);
  assert.equal(__sessionCountForTests(), 2);
  // Same token reuses.
  const a2 = await acquireCollabSession("page-1", "tok-A", "http://h/api");
  assert.equal(a, a2);
  assert.equal(FakeProvider.connectCount, 2);
});

test("disconnect at any time kills the session and removes it from the registry", async () => {
  const a = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 1);
  FakeProvider.last()._disconnect();
  assert.equal(__sessionCountForTests(), 0, "dead session is deregistered");
  // Re-acquire opens a brand new provider.
  const b = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(a, b);
  assert.equal(FakeProvider.connectCount, 2);
});

test("an in-flight mutate rejects with the connection-closed text on disconnect", async () => {
  __setCollabProviderFactory(factory({ unsynced: 1 })); // stay pending after write
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  const p = session.mutate(() => docWith("x"));
  // The write happened synchronously; persistence is pending. Now the socket drops.
  FakeProvider.last()._disconnect();
  await assert.rejects(
    p,
    // Assert the #437 diagnostic hint tail too (pageId + transient/retry cue),
    // so a refactor that drops hint() can't pass this vacuously.
    /Collaboration connection closed before the update was persisted\/synced \(pageId page-1; transient/,
  );
});

test("auth failure rejects the pending open with the auth error text", async () => {
  __setCollabProviderFactory(factory({ autoSync: false }));
  const p = acquireCollabSession("page-1", "tok", "http://h/api");
  // Let the provider be constructed, then fail auth.
  await Promise.resolve();
  FakeProvider.last()._authFail();
  await assert.rejects(
    p,
    /Authentication failed for collaboration connection/,
  );
  assert.equal(__sessionCountForTests(), 0);
});

test("mutate-error invalidates the session (caller destroys; re-acquire is fresh)", async () => {
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  await assert.rejects(
    session.mutate(() => {
      throw new Error("afterText not found");
    }),
    /afterText not found/,
  );
  // The production caller destroys on failure; mirror that here.
  session.destroy("mutate failed");
  assert.equal(__sessionCountForTests(), 0);
  const fresh = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(fresh, session);
  assert.equal(FakeProvider.connectCount, 2);
});

test("a pending write resolves when the server acks (unsyncedChanges -> 0)", async () => {
  __setCollabProviderFactory(factory({ unsynced: 1 }));
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  const p = session.mutate(() => docWith("y"));
  FakeProvider.last()._ack();
  const r = await p;
  assert.ok(r.doc);
});

test("concurrent mutate on one session: the second rejects, the first is unaffected", async () => {
  __setCollabProviderFactory(factory({ unsynced: 1 })); // first stays pending after write
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  // First mutate: write happens synchronously, persistence ack still pending.
  const first = session.mutate(() => docWith("first"));
  // Second overlapping mutate on the SAME session must fail fast.
  await assert.rejects(
    session.mutate(() => docWith("second")),
    /mutate already in-flight; caller must serialize \(hold the page lock\)/,
  );
  // The first op is untouched: its rejector was not clobbered. Ack it now.
  FakeProvider.last()._ack();
  const r = await first;
  assert.ok(r.doc, "the first in-flight mutate still resolves on its own ack");
  assert.equal(FakeProvider.connectCount, 1, "no reconnect from the rejected overlap");
});

test("sequential mutates on one session both succeed (the guard doesn't break serialized use)", async () => {
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  // Await the first fully, then run the second: inflightReject was cleared by
  // localFinish before the first settled, so the guard is clear for the second.
  const r1 = await session.mutate(() => docWith("one"));
  assert.ok(r1.doc, "first sequential mutate resolves");
  const r2 = await session.mutate(() => docWith("two"));
  assert.ok(r2.doc, "second sequential mutate resolves — guard not tripped");
  assert.equal(FakeProvider.connectCount, 1, "sequential mutates reuse one provider");
});

test("connect timeout rejects with the connect-timeout text and fires the metric hook", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  __setCollabProviderFactory(factory({ autoSync: false }));
  let metricFired = 0;
  const p = acquireCollabSession("page-1", "tok", "http://h/api", {
    onConnectTimeout: () => {
      metricFired += 1;
    },
  });
  mock.timers.tick(25000);
  await assert.rejects(
    p,
    // Assert the #437 diagnostic hint tail too (pageId + transient/retry cue).
    /Connection timeout to collaboration server \(pageId page-1; transient/,
  );
  assert.equal(metricFired, 1);
  assert.equal(__sessionCountForTests(), 0);
});

test("idle TTL destroys the session; re-acquire reconnects", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  process.env.MCP_COLLAB_SESSION_IDLE_MS = "1000";
  const a = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 1);
  mock.timers.tick(1000); // idle fires
  assert.equal(__sessionCountForTests(), 0, "idle timeout destroyed it");
  const b = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(a, b);
  assert.equal(FakeProvider.connectCount, 2);
});

test("max age is enforced at acquire (destroy + open fresh), idle held off", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  process.env.MCP_COLLAB_SESSION_MAX_AGE_MS = "1000";
  process.env.MCP_COLLAB_SESSION_IDLE_MS = "10000000"; // never fires in this test
  const a = await acquireCollabSession("page-1", "tok", "http://h/api");
  mock.timers.tick(2000); // past max age, below idle
  const b = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(a, b, "a session past its max age must be replaced");
  assert.equal(FakeProvider.connectCount, 2);
});

test("registry cap: least-recently-used session is destroy-evicted", async () => {
  process.env.MCP_COLLAB_SESSION_MAX_ENTRIES = "2";
  const s1 = await acquireCollabSession("page-1", "tok", "http://h/api");
  const p1prov = FakeProvider.last();
  const s2 = await acquireCollabSession("page-2", "tok", "http://h/api");
  const p2prov = FakeProvider.last();
  assert.equal(__sessionCountForTests(), 2);

  // Touch page-1 so page-2 becomes the least-recently-used entry.
  assert.equal(await acquireCollabSession("page-1", "tok", "http://h/api"), s1);
  assert.equal(FakeProvider.connectCount, 2, "reuse must not reconnect");

  // A third distinct page (cap 2) must evict the LRU (page-2), not page-1.
  const s3 = await acquireCollabSession("page-3", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 2);
  assert.equal(FakeProvider.connectCount, 3);
  assert.equal(p2prov.destroyed, true, "the LRU provider was destroy-evicted");
  assert.equal(p1prov.destroyed, false, "the MRU page-1 survived");

  // page-1 still reused (survived), page-3 still reused.
  assert.equal(await acquireCollabSession("page-1", "tok", "http://h/api"), s1);
  assert.equal(await acquireCollabSession("page-3", "tok", "http://h/api"), s3);
  assert.equal(FakeProvider.connectCount, 3, "no extra reconnects");
});

// #494 — the LRU cap must PREFER an idle victim: evicting a session with an
// in-flight mutate (whose update may already be on the server) would reject that
// write as a false failure → the agent retries → duplicate. Here the LRU (oldest)
// session is BUSY and a younger one is idle; the busy one must be spared.
test("#494: LRU eviction SKIPS a busy session and evicts a younger idle one instead", async () => {
  process.env.MCP_COLLAB_SESSION_MAX_ENTRIES = "2";
  __setCollabProviderFactory(factory({ unsynced: 1 })); // a mutate stays pending
  // page-1 is the OLDEST (LRU). Start a mutate on it so it is BUSY (in-flight).
  const s1 = await acquireCollabSession("page-1", "tok", "http://h/api");
  const p1prov = FakeProvider.last();
  const inflight = s1.mutate(() => docWith("in-flight write")); // pending (no ack)
  // page-2 is younger and IDLE.
  const s2 = await acquireCollabSession("page-2", "tok", "http://h/api");
  const p2prov = FakeProvider.last();
  assert.equal(__sessionCountForTests(), 2);

  // page-3 forces an eviction (cap 2). The LRU is page-1, but it is BUSY, so the
  // guard must skip it and evict the idle page-2 instead.
  await acquireCollabSession("page-3", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 2);
  assert.equal(
    p1prov.destroyed,
    false,
    "the BUSY LRU session must be spared (its in-flight write may have landed)",
  );
  assert.equal(p2prov.destroyed, true, "the idle younger session was evicted");

  // The spared write still completes normally once the server acks it — it was
  // never rejected by the eviction.
  p1prov._ack();
  const r = await inflight;
  assert.ok(r.doc, "the in-flight write on the spared session resolves on its ack");
});

// #494 — when EVERY cached session is busy, eviction is unavoidable; the victim's
// in-flight write must reject as INDETERMINATE (verify-before-retry), NOT a plain
// failure that invites a blind, duplicate retry.
test("#494: evicting a busy session when all are busy rejects the write as INDETERMINATE", async () => {
  process.env.MCP_COLLAB_SESSION_MAX_ENTRIES = "1";
  __setCollabProviderFactory(factory({ unsynced: 1 }));
  const s1 = await acquireCollabSession("page-1", "tok", "http://h/api");
  const inflight = s1.mutate(() => docWith("maybe-persisted write")); // pending
  assert.equal(__sessionCountForTests(), 1);

  // page-2 needs the single slot; page-1 is the only (busy) candidate, so its
  // eviction is unavoidable. Its in-flight write must reject with the tagged
  // indeterminate error.
  await acquireCollabSession("page-2", "tok", "http://h/api");

  await assert.rejects(inflight, (err) => {
    assert.ok(
      isCollabIndeterminateError(err),
      "the evicted busy write must carry the INDETERMINATE marker, not be a plain failure",
    );
    assert.match(err.message, /INDETERMINATE/);
    assert.match(err.message, /verify|Do NOT blindly retry/i);
    return true;
  });
});

// #494 — a session whose open() has NOT resolved yet (state "connecting") sits in
// the registry between `sessions.set(key)` and `await session.open()`, but it is
// NOT an idle eviction victim: its write has not even started, and a parallel
// acquire for a DIFFERENT page that interleaves across that await must not destroy
// it (which would reject its pending open() as "evicted (LRU cap)" — a spurious
// failure of a write that never began). Under saturation the connecting session is
// spared; a genuinely-busy LRU session is evicted (INDETERMINATE) instead, and the
// connecting session's open() still resolves.
test("#494: a still-CONNECTING session is NOT evicted as an idle victim by a parallel acquire under saturation", async () => {
  process.env.MCP_COLLAB_SESSION_MAX_ENTRIES = "2";

  // A = the OLDEST (LRU) session, made BUSY by an in-flight (un-acked) mutate.
  __setCollabProviderFactory(factory({ unsynced: 1 }));
  const sA = await acquireCollabSession("page-1", "tok", "http://h/api");
  const provA = FakeProvider.last();
  const inflightA = sA.mutate(() => docWith("in-flight write")); // pending
  // Attach a handler NOW so a later reject is never "unhandled"; capture it.
  let inflightErr;
  inflightA.catch((e) => {
    inflightErr = e;
  });

  // B = a session still mid-handshake: open() never resolves under autoSync:false,
  // so it stays "connecting". acquireCollabSession runs synchronously through
  // `sessions.set(key)` and into open()'s executor (provider created) before it
  // suspends at `await session.open()`, so B is already registered here.
  __setCollabProviderFactory(factory({ autoSync: false }));
  const pB = acquireCollabSession("page-2", "tok", "http://h/api"); // NOT awaited
  const provB = FakeProvider.last();
  assert.equal(__sessionCountForTests(), 2, "A (busy) + B (connecting) fill the cap");
  assert.notEqual(provA, provB);

  // C forces an eviction (cap 2). The idle-victim scan must treat B (connecting) as
  // NON-idle and fall through to the busy LRU (A), evicting A as INDETERMINATE and
  // SPARING the connecting B.
  __setCollabProviderFactory(factory());
  const sC = await acquireCollabSession("page-3", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 2);
  assert.ok(sC);

  assert.equal(
    provB.destroyed,
    false,
    "the CONNECTING session must be spared — a parallel acquire must not evict a mid-handshake write",
  );
  assert.equal(
    provA.destroyed,
    true,
    "the busy LRU session was the eviction victim instead",
  );

  // B's handshake completes -> its open() resolves and the acquire returns a live
  // session (its write can now start), proving the eviction never touched it.
  provB.config.onConnect?.();
  provB.synced = true;
  provB.config.onSynced?.();
  const sB = await pB;
  assert.ok(sB, "the spared connecting session's open() resolves normally");
  assert.equal(provB.destroyed, false);

  // The evicted busy write rejects as INDETERMINATE (verify-before-retry), not a
  // plain failure — the existing all-busy guarantee still holds for A.
  assert.ok(
    isCollabIndeterminateError(inflightErr),
    "the evicted busy write carries the INDETERMINATE marker",
  );
});

test("MCP_COLLAB_SESSION_IDLE_MS=0 disables the cache (legacy provider-per-op)", async () => {
  process.env.MCP_COLLAB_SESSION_IDLE_MS = "0";
  const s1 = await acquireCollabSession("page-1", "tok", "http://h/api");
  // Never registered (ephemeral).
  assert.equal(__sessionCountForTests(), 0);
  const r1 = await s1.mutate(() => docWith("a"));
  assert.ok(r1.doc);
  // After its single op the ephemeral session self-destroyed.
  assert.equal(FakeProvider.instances[0].destroyed, true);
  // A second op opens a BRAND NEW provider (no reuse).
  const s2 = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(s1, s2);
  assert.equal(FakeProvider.connectCount, 2);
});

test("replaceImage-shaped flow: acquire under an EXTERNAL page lock does not deadlock and reuses one session", async () => {
  // withPageLock now asserts a canonical UUID key (#449); this flow takes the
  // real page lock (mirroring replaceImage), so the key must be a valid UUID.
  const pageId = "77777777-7777-4777-8777-777777777777";
  // Mirror replaceImage: hold ONE withPageLock across scan (read-only) + write,
  // each going through the non-locking acquireCollabSession.
  const result = await withPageLock(pageId, async () => {
    // pass 1: read-only scan (transform returns null -> no write)
    const scan = await acquireCollabSession(pageId, "tok", "http://h/api");
    const scanRes = await scan.mutate(() => null);
    assert.equal(scanRes.verify.changed, false);
    // pass 2: the actual write, same held lock
    const write = await acquireCollabSession(pageId, "tok", "http://h/api");
    return write.mutate(() => docWith("repointed"));
  });
  assert.ok(result.doc, "the locked scan+write completed without deadlock");
  assert.equal(
    FakeProvider.connectCount,
    1,
    "both passes under the held lock reuse ONE live session",
  );
});

// --- #439: the collab-token cache is what makes the session cache ACTUALLY hit ---
//
// WHY these two tests exist (the #435 incident): the session registry keys on
// (wsUrl, pageId, token) for identity isolation, but BOTH production token
// sources mint a FRESH JWT on every call (the in-app provider re-signs a JWT
// whose iat/exp changes every second; the external MCP POSTs /auth/collab-token
// per call). The fresh token per call made the session-registry key unstable,
// so the prod hit-rate was 0% — connect storms, 25s timeouts, zombie sessions —
// while every other test in this file stayed green because they pass a FIXED
// "tok" string. The #439 fix is the per-client collab-token cache
// (DocmostClient.getCollabTokenWithReauth + MCP_COLLAB_TOKEN_TTL_MS); these
// tests drive the token through it with a source that returns a DIFFERENT
// fresh JWT per mint, exactly like prod, so a regression in EITHER the token
// cache or the registry keying turns them red.
//
// getCollabTokenWithReauth is TS-private, but the compiled JS exposes it; the
// tests call it directly because that is exactly the per-op composition of the
// production call sites (updatePage etc.: mint the token, then acquire).

test("#439 token cache ON: fresh-JWT-per-mint source, two ops => ONE connect (session cache hits)", async () => {
  process.env.MCP_COLLAB_TOKEN_TTL_MS = "300000"; // cache ON (explicit, not default-dependent)
  let mints = 0;
  const client = new DocmostClient({
    apiUrl: "http://h/api",
    getToken: async () => "user-jwt",
    // Like both prod sources: a DIFFERENT fresh JWT on every mint.
    getCollabToken: async () => `fresh-jwt-${++mints}`,
  });

  // Op 1: mint the collab token through the client, then acquire + mutate.
  const tok1 = await client.getCollabTokenWithReauth();
  const s1 = await acquireCollabSession("page-1", tok1, "http://h/api");
  await s1.mutate(() => docWith("one"));

  // Op 2: the same identity mints again — the cache must serve the SAME token.
  const tok2 = await client.getCollabTokenWithReauth();
  const s2 = await acquireCollabSession("page-1", tok2, "http://h/api");
  await s2.mutate(() => docWith("two"));

  assert.equal(mints, 1, "the second op is served from the token cache");
  assert.equal(tok2, tok1, "stable token => stable session-registry key");
  assert.equal(s2, s1, "the live session is reused");
  assert.equal(
    FakeProvider.connectCount,
    1,
    "two mutations over one identity must cost exactly ONE real connect",
  );
  assert.equal(__sessionCountForTests(), 1);
});

test("#439 negative control: token cache OFF (TTL=0) reproduces the #435 churn — two ops => TWO connects", async () => {
  process.env.MCP_COLLAB_TOKEN_TTL_MS = "0"; // explicit 0 disables the cache (fetch-per-call legacy)
  let mints = 0;
  const client = new DocmostClient({
    apiUrl: "http://h/api",
    getToken: async () => "user-jwt",
    getCollabToken: async () => `fresh-jwt-${++mints}`,
  });

  const tok1 = await client.getCollabTokenWithReauth();
  const s1 = await acquireCollabSession("page-1", tok1, "http://h/api");
  await s1.mutate(() => docWith("one"));

  const tok2 = await client.getCollabTokenWithReauth();
  const s2 = await acquireCollabSession("page-1", tok2, "http://h/api");
  await s2.mutate(() => docWith("two"));

  assert.equal(mints, 2, "without the cache every op mints its own token");
  assert.notEqual(tok2, tok1, "unstable token => unstable session-registry key");
  assert.notEqual(s2, s1, "no session reuse");
  assert.equal(
    FakeProvider.connectCount,
    2,
    "a full reconnect per op — the #435 storm in miniature",
  );
  // The first session lingers under its now-unreachable key until its idle
  // TTL — the zombie-session symptom of the incident.
  assert.equal(__sessionCountForTests(), 2);
});

test("destroyAllSessions tears down every cached session", async () => {
  await acquireCollabSession("page-1", "tok", "http://h/api");
  await acquireCollabSession("page-2", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 2);
  const provs = [...FakeProvider.instances];
  destroyAllSessions();
  assert.equal(__sessionCountForTests(), 0);
  assert.ok(provs.every((p) => p.destroyed), "all providers destroyed");
});
