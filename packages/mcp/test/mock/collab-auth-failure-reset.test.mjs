// Unit tests for the collab-token reset on a Hocuspocus WS auth failure (#486).
//
// Before this fix the cached collab token (#435) was dropped ONLY on an HTTP
// 401/403 (the REST interceptor + login()); a rejected collab-WEBSOCKET handshake
// left the stale token in the cache, so every subsequent mutation re-presented
// the SAME bad token for up to the collab-token TTL (minutes) with no self-heal.
//
// The fix wraps collab writes in `writeWithCollabAuthRetry`: when the write
// rejects with the tagged collab-auth error (collab-session.ts's
// onAuthenticationFailed), it invalidates the cached token and retries the write
// ONCE with a force-refreshed token — symmetric to the HTTP-401 path.
//
// writeWithCollabAuthRetry / getCollabTokenWithReauth are protected in TS but
// plain methods on the compiled build, so the tests call them directly (same
// convention as collab-token-cache.test.mjs).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DocmostClient } from "../../build/client.js";

const ENV_KEY = "MCP_COLLAB_TOKEN_TTL_MS";
afterEach(() => {
  delete process.env[ENV_KEY];
});

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

// The tagged error collab-session.ts throws on a rejected WS handshake.
function collabAuthError() {
  const err = new Error("Authentication failed for collaboration connection");
  err.collabAuthFailed = true;
  return err;
}

test("a WS auth failure clears the cached token and retries the write with a FRESH one (#486)", async () => {
  process.env[ENV_KEY] = "300000"; // 5 min: the cache is warm across the burst.
  const p = countingProvider();
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
    getCollabToken: p.fn,
  });

  // Warm the cache the way a real write would (mints provider-token-1).
  const initial = await client.getCollabTokenWithReauth();
  assert.equal(initial, "provider-token-1");
  assert.equal(p.calls, 1);

  const tokensSeen = [];
  const write = async (token) => {
    tokensSeen.push(token);
    // The FIRST attempt (with the stale cached token) fails the WS handshake;
    // the retry (with a fresh token) succeeds.
    if (tokensSeen.length === 1) throw collabAuthError();
    return `written-with:${token}`;
  };

  const result = await client.writeWithCollabAuthRetry(initial, write);

  assert.equal(tokensSeen.length, 2, "write attempted exactly twice (one retry)");
  assert.equal(tokensSeen[0], "provider-token-1", "first attempt used the stale token");
  assert.equal(
    tokensSeen[1],
    "provider-token-2",
    "retry used a FRESH force-refreshed token, not the stale cached one",
  );
  assert.equal(result, "written-with:provider-token-2", "the retry's result wins");
  assert.equal(p.calls, 2, "exactly one extra mint for the retry — no loop");

  // The cache now holds the fresh token, so a subsequent op reuses it (proving
  // the stale token was evicted and the fresh one cached, not re-minted).
  const next = await client.getCollabTokenWithReauth();
  assert.equal(next, "provider-token-2", "the fresh token replaced the stale cache");
  assert.equal(p.calls, 2, "served from cache — provider not re-invoked");
});

test("a successful write is NOT retried and mints nothing extra", async () => {
  process.env[ENV_KEY] = "300000";
  const p = countingProvider();
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
    getCollabToken: p.fn,
  });

  const initial = await client.getCollabTokenWithReauth(); // provider-token-1
  let attempts = 0;
  const result = await client.writeWithCollabAuthRetry(initial, async (token) => {
    attempts++;
    return `ok:${token}`;
  });

  assert.equal(attempts, 1, "no retry on success");
  assert.equal(result, "ok:provider-token-1");
  assert.equal(p.calls, 1, "no extra mint");
});

test("a NON-auth write error propagates unchanged (no reset, no retry)", async () => {
  process.env[ENV_KEY] = "300000";
  const p = countingProvider();
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
    getCollabToken: p.fn,
  });

  const initial = await client.getCollabTokenWithReauth(); // provider-token-1
  let attempts = 0;
  await assert.rejects(
    client.writeWithCollabAuthRetry(initial, async () => {
      attempts++;
      throw new Error("collab connection closed before persist"); // NOT tagged.
    }),
    /closed before persist/,
  );

  assert.equal(attempts, 1, "a non-auth error is not retried");
  assert.equal(p.calls, 1, "the cache is untouched -> no fresh mint");

  // Cache still holds the original token (was never invalidated).
  const still = await client.getCollabTokenWithReauth();
  assert.equal(still, "provider-token-1");
  assert.equal(p.calls, 1);
});
