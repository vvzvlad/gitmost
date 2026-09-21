// Unit tests for the collab-token cache (issue #435). The live CollabSession
// registry (#400/#431) keys sessions on (wsUrl, pageId, collabToken), so a token
// string that changes every op defeats reuse. This cache holds the last minted
// token per DocmostClient for MCP_COLLAB_TOKEN_TTL_MS so a burst of mutations
// reuses ONE token -> ONE session. These tests exercise both mint sources:
//   - the getCollabToken PROVIDER path (in-app agent), via a counting provider fn;
//   - the REST /auth/collab-token path (external MCP), via a mock http server.
// getCollabTokenWithReauth is private in TS but a plain method on the compiled
// build, so the tests call it directly (same convention as reauth.test.mjs).
import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocmostClient } from "../../build/client.js";

// Restore the env knob after each test so cases do not leak into one another.
const ENV_KEY = "MCP_COLLAB_TOKEN_TTL_MS";
afterEach(() => {
  delete process.env[ENV_KEY];
});

// ---------------------------------------------------------------------------
// Small mock server for the REST /auth/collab-token path. Counts collab-token
// mints and can be told to 401 the first N of them (to drive the reauth retry).
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}
function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(obj));
}

const openServers = [];
after(async () => {
  await Promise.all(
    openServers.map((s) => new Promise((r) => s.close(r))),
  );
});

// state: { collabCalls, loginCalls, unauthorizedCollabHits }
function spawnCollabServer(state, { collabAuthFailsFor = 0 } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      await readBody(req);
      if (req.url === "/api/auth/login") {
        state.loginCalls++;
        // A fresh authToken per login so an identity change is observable.
        sendJson(res, 200, { success: true }, {
          "Set-Cookie": `authToken=login-${state.loginCalls}; Path=/; HttpOnly`,
        });
        return;
      }
      if (req.url === "/api/auth/collab-token") {
        state.collabCalls++;
        if (state.collabCalls <= collabAuthFailsFor) {
          sendJson(res, 401, { message: "Unauthorized" });
          return;
        }
        // Unique token per mint so a stale cached value is distinguishable.
        sendJson(res, 200, { data: { token: `collab-${state.collabCalls}` } });
        return;
      }
      sendJson(res, 404, { message: "not found" });
    });
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}/api`);
    });
  });
}

// ===========================================================================
// PROVIDER path (in-app agent getCollabToken fn)
// ===========================================================================

// A counting provider that returns a distinct token each call so a cached
// (reused) token is visibly the SAME string while a fresh mint is different.
function countingProvider() {
  let n = 0;
  const fn = async () => {
    n++;
    return `provider-token-${n}`;
  };
  return {
    fn,
    get calls() {
      return n;
    },
  };
}

test("within TTL, repeated calls return the SAME token and mint ONCE (provider path)", async () => {
  process.env[ENV_KEY] = "300000"; // 5 min
  const p = countingProvider();
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
    getCollabToken: p.fn,
  });

  const a = await client.getCollabTokenWithReauth();
  const b = await client.getCollabTokenWithReauth();
  const c = await client.getCollabTokenWithReauth();

  assert.equal(a, "provider-token-1");
  assert.equal(b, a, "second call reuses the cached token");
  assert.equal(c, a, "third call reuses the cached token");
  assert.equal(p.calls, 1, "the provider is invoked exactly once within the TTL");
});

test("after TTL expiry a new token is minted (provider path)", async () => {
  process.env[ENV_KEY] = "20"; // 20ms TTL
  const p = countingProvider();
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
    getCollabToken: p.fn,
  });

  const a = await client.getCollabTokenWithReauth();
  await new Promise((r) => setTimeout(r, 40)); // let the TTL lapse
  const b = await client.getCollabTokenWithReauth();

  assert.equal(a, "provider-token-1");
  assert.equal(b, "provider-token-2", "a fresh token is minted after expiry");
  assert.equal(p.calls, 2);
});

test("MCP_COLLAB_TOKEN_TTL_MS=0 disables the cache: mint on EVERY call (provider path)", async () => {
  process.env[ENV_KEY] = "0";
  const p = countingProvider();
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
    getCollabToken: p.fn,
  });

  await client.getCollabTokenWithReauth();
  await client.getCollabTokenWithReauth();
  await client.getCollabTokenWithReauth();

  assert.equal(p.calls, 3, "cache disabled -> exact fetch-per-call legacy path");
});

test("a 401 triggers the internal reauth retry, which bypasses the cache and mints fresh (provider path)", async () => {
  process.env[ENV_KEY] = "300000";
  let n = 0;
  const provider = async () => {
    n++;
    if (n === 1) {
      // The FIRST mint fails with an auth error; the internal reauth retry must
      // re-invoke the provider (bypassing the empty cache) for a fresh token.
      const err = new Error("collab token expired");
      err.status = 401;
      throw err;
    }
    return `provider-token-${n}`;
  };
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
    getCollabToken: provider,
  });

  // Cache is empty: mint #1 401s -> the reauth retry mints #2 and caches it.
  const tok = await client.getCollabTokenWithReauth();
  assert.equal(tok, "provider-token-2", "the post-401 retry token wins");
  assert.equal(n, 2, "exactly one failed mint + one retry, no loop");

  // The retried token is what got cached (no extra mint on a cache hit).
  const cached = await client.getCollabTokenWithReauth();
  assert.equal(cached, "provider-token-2");
  assert.equal(n, 2, "served from cache, provider not re-invoked");
});

test("forceRefresh=true bypasses a warm cache and mints a fresh token (provider path)", async () => {
  process.env[ENV_KEY] = "300000";
  const p = countingProvider();
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
    getCollabToken: p.fn,
  });

  const first = await client.getCollabTokenWithReauth(); // caches token-1
  assert.equal(first, "provider-token-1");

  // A forced refresh (what the reauth path passes) must NOT return the cached
  // token-1; it mints a fresh token-2 and replaces the cache.
  const forced = await client.getCollabTokenWithReauth(true);
  assert.equal(forced, "provider-token-2", "cache bypassed on forceRefresh");
  assert.equal(p.calls, 2);

  const cached = await client.getCollabTokenWithReauth();
  assert.equal(cached, "provider-token-2", "the fresh token replaced the cache");
  assert.equal(p.calls, 2);
});

test("two consecutive mutations keep the SAME token, so the session key is stable (provider path)", async () => {
  // The whole point of #435: acquireCollabSession keys on the token, so two
  // acquire calls in a burst must be handed the identical token string.
  process.env[ENV_KEY] = "300000";
  const p = countingProvider();
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
    getCollabToken: p.fn,
  });

  const t1 = await client.getCollabTokenWithReauth();
  const t2 = await client.getCollabTokenWithReauth();
  assert.equal(t1, t2, "identical token across two mutations -> one session key");
  assert.equal(p.calls, 1);
});

// ===========================================================================
// REST /auth/collab-token path (external MCP)
// ===========================================================================

test("within TTL, the REST /auth/collab-token endpoint is hit ONCE", async () => {
  process.env[ENV_KEY] = "300000";
  const state = { collabCalls: 0, loginCalls: 0 };
  const baseURL = await spawnCollabServer(state);
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const a = await client.getCollabTokenWithReauth();
  const b = await client.getCollabTokenWithReauth();

  assert.equal(a, "collab-1");
  assert.equal(b, a, "cached token reused");
  assert.equal(state.collabCalls, 1, "POST /auth/collab-token called once");
});

test("TTL=0 hits the REST endpoint on every call", async () => {
  process.env[ENV_KEY] = "0";
  const state = { collabCalls: 0, loginCalls: 0 };
  const baseURL = await spawnCollabServer(state);
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  await client.getCollabTokenWithReauth();
  await client.getCollabTokenWithReauth();

  assert.equal(state.collabCalls, 2, "cache disabled -> fetch each call");
});

test("401 on REST collab-token re-logs-in and refetches (cache bypassed)", async () => {
  process.env[ENV_KEY] = "300000";
  const state = { collabCalls: 0, loginCalls: 0 };
  // The first collab-token mint 401s; the reauth path logs in and retries.
  const baseURL = await spawnCollabServer(state, { collabAuthFailsFor: 1 });
  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  // Pre-seed a token so the initial call does not perform an initial login.
  client.token = "seed";
  client.client.defaults.headers.common["Authorization"] = "Bearer seed";

  const tok = await client.getCollabTokenWithReauth();
  assert.equal(tok, "collab-2", "the post-reauth mint wins, not the failed one");
  assert.equal(state.loginCalls, 1, "re-login happened exactly once");
  assert.equal(state.collabCalls, 2, "one failed mint + one successful retry");
});

test("a fresh login clears the cache so a collab token cannot outlive the identity", async () => {
  process.env[ENV_KEY] = "300000";
  const state = { collabCalls: 0, loginCalls: 0 };
  const baseURL = await spawnCollabServer(state);
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const before = await client.getCollabTokenWithReauth();
  assert.equal(before, "collab-1");

  // Simulate an identity change (the 401 interceptor / re-login path calls
  // login(), which must drop the cached collab token).
  await client.login();

  const after = await client.getCollabTokenWithReauth();
  assert.equal(after, "collab-2", "cache was invalidated by login(); refetched");
  assert.equal(state.collabCalls, 2);
});
