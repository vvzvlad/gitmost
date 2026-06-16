// Mock-HTTP tests for the re-auth / multipart / pagination paths in
// DocmostClient that the live e2e (which always starts with a FRESH token)
// can never reach: expired-token replay, concurrent-login dedup, the
// no-infinite-loop guard, exact cookie parsing, and the paginateAll loop
// guards. A local http.createServer stands in for Docmost so everything
// stays deterministic and offline.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocmostClient } from "../../build/client.js";

// Read a request body to completion (used to assert /auth/login receives the
// email/password JSON, and just to drain the stream before responding).
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
  });
}

// Start an http server bound to an ephemeral port and resolve once it is
// listening, returning the server plus the api base URL the client should use.
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${port}/api` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// JSON helper.
function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(obj));
}

// Track every server so the after() hook can guarantee nothing is left open.
const openServers = [];
async function spawn(handler) {
  const { server, baseURL } = await startServer(handler);
  openServers.push(server);
  return { server, baseURL };
}

after(async () => {
  await Promise.all(openServers.map((s) => closeServer(s)));
});

// -----------------------------------------------------------------------------
// 1) 401-then-200: the interceptor re-logs-in and replays the request once.
// -----------------------------------------------------------------------------
test("401 on a JSON endpoint triggers re-login and a successful replay", async () => {
  let loginCalls = 0;
  let infoCalls = 0;
  let replayedAuthHeader = null;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      loginCalls++;
      // Hand back a fresh token via Set-Cookie (HttpOnly, like Docmost).
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=fresh-token-123; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/workspace/info") {
      infoCalls++;
      // First hit: token is stale -> 401. Second hit (the replay): 200, and
      // record the Authorization header so we can confirm the new Bearer.
      if (infoCalls === 1) {
        sendJson(res, 401, { message: "Unauthorized" });
      } else {
        replayedAuthHeader = req.headers["authorization"];
        sendJson(res, 200, { success: true, data: { id: "ws-1", name: "WS" } });
      }
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  // Pre-seed a stale token so the FIRST /workspace/info uses it and 401s,
  // exercising the interceptor replay rather than the initial-login path.
  client.token = "stale-token";
  client.client.defaults.headers.common["Authorization"] = "Bearer stale-token";

  const result = await client.getWorkspace();

  assert.equal(result.success, true);
  assert.equal(loginCalls, 1, "/auth/login should be called exactly once");
  assert.equal(infoCalls, 2, "the endpoint should be hit twice (401 then replay)");
  assert.equal(
    replayedAuthHeader,
    "Bearer fresh-token-123",
    "the replay must carry the freshly minted Bearer token",
  );
});

// -----------------------------------------------------------------------------
// 2) Login dedup: concurrent 401s collapse into a single /auth/login.
// -----------------------------------------------------------------------------
test("concurrent 401s deduplicate into a single /auth/login call", async () => {
  let loginCalls = 0;
  const infoState = new Map(); // per-endpoint hit counter

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      loginCalls++;
      // Delay the login response a touch so all concurrent requests are still
      // in flight and genuinely share the one in-flight loginPromise.
      setTimeout(() => {
        sendJson(res, 200, { success: true }, {
          "Set-Cookie": "authToken=shared-token; Path=/; HttpOnly",
        });
      }, 40);
      return;
    }
    // Several distinct JSON endpoints, each 401 on the first hit then 200.
    const n = (infoState.get(req.url) || 0) + 1;
    infoState.set(req.url, n);
    if (n === 1) {
      sendJson(res, 401, { message: "Unauthorized" });
    } else {
      sendJson(res, 200, { success: true, data: { items: [], meta: {} } });
    }
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  client.token = "stale-token";
  client.client.defaults.headers.common["Authorization"] = "Bearer stale-token";

  // Fire several different requests concurrently; each one's first attempt 401s
  // and triggers a re-login, but the in-flight loginPromise must coalesce them.
  await Promise.all([
    client.getWorkspace(),
    client.getSpaces(),
    client.search("anything"),
    client.listShares(),
  ]);

  assert.equal(
    loginCalls,
    1,
    "all concurrent 401s must share ONE in-flight /auth/login",
  );
});

// -----------------------------------------------------------------------------
// 3) Persistent 401: exactly one retry, no infinite loop; a 401 on the login
//    endpoint itself is NOT retried.
// -----------------------------------------------------------------------------
test("a persistently-401 endpoint fails after exactly one retry", async () => {
  let loginCalls = 0;
  let infoCalls = 0;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      loginCalls++;
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/workspace/info") {
      infoCalls++;
      // ALWAYS 401, even after a fresh login: the retry guard must stop here.
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  client.token = "stale-token";
  client.client.defaults.headers.common["Authorization"] = "Bearer stale-token";

  await assert.rejects(() => client.getWorkspace());

  // Original request + exactly ONE replay = 2 hits, never more (no loop).
  assert.equal(infoCalls, 2, "endpoint hit at most twice (one retry only)");
  assert.equal(loginCalls, 1, "re-login attempted exactly once");
});

test("a 401 on /auth/login itself is not retried", async () => {
  let loginCalls = 0;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      loginCalls++;
      // The login endpoint rejects credentials. The interceptor must NOT try
      // to "re-login to fix a failed login" — that would loop forever.
      sendJson(res, 401, { message: "Invalid credentials" });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "wrong-pw");

  // login() -> performLogin POSTs /auth/login, gets 401; the interceptor sees
  // isLoginRequest and rejects without retrying. So /auth/login is hit once.
  await assert.rejects(() => client.login());
  assert.equal(loginCalls, 1, "/auth/login must be attempted exactly once");
});

// -----------------------------------------------------------------------------
// 4) performLogin cookie parsing: base64 "=" padding survives intact, and a
//    cookie literally named authTokenRefresh is not mistaken for authToken.
// -----------------------------------------------------------------------------
test("a token with base64 '=' padding round-trips intact to the server", async () => {
  // A realistic JWT-ish value whose final segment ends in base64 "=" padding.
  const paddedToken = "header.payload.c2lnbmF0dXJl==";
  let sentBearer = null;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        // Include attributes AND a base64 value containing "=" so we verify the
        // parser keeps everything after the FIRST "=" up to the first ";".
        "Set-Cookie": `authToken=${paddedToken}; Path=/; HttpOnly; SameSite=Lax`,
      });
      return;
    }
    if (req.url === "/api/workspace/info") {
      sentBearer = req.headers["authorization"];
      sendJson(res, 200, { success: true, data: { id: "ws" } });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  await client.login();
  // The parsed token equals exactly what the server set (padding preserved).
  assert.equal(client.token, paddedToken);

  // And the client sends that exact token back on a subsequent request.
  await client.getWorkspace();
  assert.equal(sentBearer, `Bearer ${paddedToken}`);
});

test("an authTokenRefresh cookie is not mistaken for authToken", async () => {
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      // Set BOTH cookies. The exact-name match must pick authToken=real and
      // ignore authTokenRefresh=should-not-match (a prefix match would grab it).
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": [
          "authTokenRefresh=should-not-match; Path=/; HttpOnly",
          "authToken=real-token; Path=/; HttpOnly",
        ],
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  await client.login();
  assert.equal(client.token, "real-token");
});

test("a response with ONLY authTokenRefresh (no authToken) rejects login", async () => {
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authTokenRefresh=nope; Path=/; HttpOnly",
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  // No authToken cookie present -> performLogin throws.
  await assert.rejects(() => client.login(), /No authToken cookie/);
});

// -----------------------------------------------------------------------------
// 5) paginateAll loop guards.
// -----------------------------------------------------------------------------
test("paginateAll stops at the MAX_PAGES cap when hasNextPage is always true", async () => {
  let pageRequests = 0;
  const LIMIT = 100;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/spaces") {
      pageRequests++;
      // Always return a FULL page (== requested limit) AND hasNextPage:true.
      // Both the page-length check and the hasNextPage flag say "keep going",
      // so only the MAX_PAGES ceiling can stop the loop.
      const items = Array.from({ length: LIMIT }, (_, i) => ({
        id: `s-${pageRequests}-${i}`,
      }));
      sendJson(res, 200, {
        success: true,
        data: { items, meta: { hasNextPage: true } },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const all = await client.paginateAll("/spaces", {}, LIMIT);

  // MAX_PAGES is 50; the loop must terminate there, not run unbounded.
  assert.ok(
    pageRequests <= 50,
    `expected <= 50 page requests, got ${pageRequests}`,
  );
  assert.equal(pageRequests, 50, "should fetch exactly the MAX_PAGES cap");
  assert.equal(all.length, 50 * LIMIT, "accumulates one full page per request");
});

test("paginateAll stops early on a short page even if hasNextPage is true", async () => {
  let pageRequests = 0;
  const LIMIT = 100;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/spaces") {
      pageRequests++;
      // First page is full; second page is SHORT (fewer than limit). The short
      // page must stop the loop immediately even though hasNextPage stays true.
      const count = pageRequests === 1 ? LIMIT : 3;
      const items = Array.from({ length: count }, (_, i) => ({
        id: `s-${pageRequests}-${i}`,
      }));
      sendJson(res, 200, {
        success: true,
        data: { items, meta: { hasNextPage: true } },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const all = await client.paginateAll("/spaces", {}, LIMIT);

  assert.equal(pageRequests, 2, "stops right after the first short page");
  assert.equal(all.length, LIMIT + 3, "full page + short page accumulated");
});

test("paginateAll handles both {data:{items,meta}} and {items,meta} envelopes", async () => {
  // Bare envelope: { items, meta } with no { data } wrapper.
  const bareRequests = [];
  const { baseURL: bareURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/groups") {
      bareRequests.push(1);
      // Page 1: full page, hasNextPage true. Page 2: short page -> stop.
      if (bareRequests.length === 1) {
        sendJson(res, 200, {
          items: Array.from({ length: 100 }, (_, i) => ({ id: `g${i}` })),
          meta: { hasNextPage: true },
        });
      } else {
        sendJson(res, 200, {
          items: [{ id: "tail" }],
          meta: { hasNextPage: false },
        });
      }
      return;
    }
    sendJson(res, 404, {});
  });

  const bareClient = new DocmostClient(bareURL, "user@example.com", "pw");
  const bare = await bareClient.paginateAll("/groups", {}, 100);
  assert.equal(bare.length, 101, "bare {items,meta} envelope handled");
  assert.equal(bare[bare.length - 1].id, "tail");

  // Wrapped envelope: { data: { items, meta } }.
  const wrappedRequests = [];
  const { baseURL: wrappedURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/groups") {
      wrappedRequests.push(1);
      // Single short page -> stops after one request.
      sendJson(res, 200, {
        data: {
          items: [{ id: "w1" }, { id: "w2" }],
          meta: { hasNextPage: false },
        },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const wrappedClient = new DocmostClient(wrappedURL, "user@example.com", "pw");
  const wrapped = await wrappedClient.paginateAll("/groups", {}, 100);
  assert.equal(wrapped.length, 2, "wrapped {data:{items,meta}} envelope handled");
  assert.equal(wrappedRequests.length, 1, "single short page -> one request");
});
