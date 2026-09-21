// Issue #437: central error diagnostics.
//
// Two surfaces are covered here:
//   1. formatDocmostAxiosError — the pure response-interceptor body that
//      rewrites an AxiosError's `.message` into an actionable diagnostic.
//   2. assertFullUuid — the fail-fast comment-id guard (absorbs #436) that must
//      throw BEFORE any network call.
// Plus an end-to-end pass over a real (offline) http server to prove the
// interceptor is wired, that a re-login retry leaves a success untouched, and
// that a persistent failure gets formatted — and that an invalid comment id
// short-circuits every comment tool with ZERO network traffic.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import axios, { AxiosError } from "axios";
import {
  DocmostClient,
  formatDocmostAxiosError,
  assertFullUuid,
} from "../../build/client.js";

// Build an AxiosError-shaped object the way the interceptor's rejection handler
// receives it. Using the real AxiosError ctor makes axios.isAxiosError() true.
function makeAxiosError({
  method = "post",
  url = "/comments/resolve",
  baseURL = "http://host.example/api",
  status,
  statusText,
  data,
  code,
  message = "Request failed",
}) {
  const config = { method, url, baseURL };
  const response =
    status === undefined
      ? undefined
      : { status, statusText, data, headers: {}, config };
  return new AxiosError(message, code, config, {}, response);
}

// ---------------------------------------------------------------------------
// formatDocmostAxiosError: message-body extraction rules.
// ---------------------------------------------------------------------------
test("class-validator message array is joined with '; '", () => {
  const err = makeAxiosError({
    status: 400,
    statusText: "Bad Request",
    data: { message: ["commentId must be a UUID", "resolved must be a boolean"] },
  });
  formatDocmostAxiosError(err);
  assert.equal(
    err.message,
    "POST /comments/resolve failed (400 Bad Request): commentId must be a UUID; resolved must be a boolean",
  );
});

test("a string message is used as-is", () => {
  const err = makeAxiosError({
    method: "post",
    url: "/comments/resolve",
    status: 400,
    statusText: "Bad Request",
    data: { message: "commentId must be a UUID" },
  });
  formatDocmostAxiosError(err);
  assert.equal(
    err.message,
    "POST /comments/resolve failed (400 Bad Request): commentId must be a UUID",
  );
});

test("falls back to data.error when message is absent", () => {
  const err = makeAxiosError({
    method: "get",
    url: "/pages/info",
    status: 403,
    statusText: "Forbidden",
    data: { error: "Forbidden" },
  });
  formatDocmostAxiosError(err);
  assert.equal(err.message, "GET /pages/info failed (403 Forbidden): Forbidden");
});

test("empty object body falls back to statusText", () => {
  const err = makeAxiosError({
    status: 404,
    statusText: "Not Found",
    url: "/comments/info",
    data: {},
  });
  formatDocmostAxiosError(err);
  assert.equal(err.message, "POST /comments/info failed (404 Not Found): Not Found");
});

test("HTML/string body is NEVER surfaced — only the statusText", () => {
  const html = "<html><body>502 Bad Gateway — nginx internals here</body></html>";
  const err = makeAxiosError({
    status: 502,
    statusText: "Bad Gateway",
    url: "/comments/create",
    data: html,
  });
  formatDocmostAxiosError(err);
  assert.equal(
    err.message,
    "POST /comments/create failed (502 Bad Gateway): Bad Gateway",
  );
  assert.ok(!err.message.includes("nginx"), "raw HTML body must not leak");
  assert.ok(!err.message.includes("<html>"), "raw HTML body must not leak");
});

test("Buffer body carrying JSON is parsed for its message", () => {
  const buf = Buffer.from(JSON.stringify({ message: "file too large" }), "utf8");
  const err = makeAxiosError({
    method: "get",
    url: "/files/abc/x.png",
    status: 413,
    statusText: "Payload Too Large",
    data: buf,
  });
  formatDocmostAxiosError(err);
  assert.equal(
    err.message,
    "GET /files/abc/x.png failed (413 Payload Too Large): file too large",
  );
});

test("Buffer body with non-JSON garbage falls back to statusText", () => {
  const buf = Buffer.from("<<< not json at all >>>", "utf8");
  const err = makeAxiosError({
    method: "get",
    url: "/files/abc/x.png",
    status: 500,
    statusText: "Internal Server Error",
    data: buf,
  });
  formatDocmostAxiosError(err);
  assert.equal(
    err.message,
    "GET /files/abc/x.png failed (500 Internal Server Error): Internal Server Error",
  );
  assert.ok(!err.message.includes("not json"), "raw buffer body must not leak");
});

test("an oversized Buffer body is not parsed (size cap) — statusText only", () => {
  // A >4KB JSON buffer: even though it IS valid JSON with a message, the size
  // cap means we do not attempt to parse it, so only the statusText survives.
  const big = { message: "x".repeat(5000) };
  const buf = Buffer.from(JSON.stringify(big), "utf8");
  const err = makeAxiosError({
    method: "get",
    url: "/files/abc/x.png",
    status: 500,
    statusText: "Internal Server Error",
    data: buf,
  });
  formatDocmostAxiosError(err);
  assert.equal(
    err.message,
    "GET /files/abc/x.png failed (500 Internal Server Error): Internal Server Error",
  );
});

// ---------------------------------------------------------------------------
// formatDocmostAxiosError: no-response and path/method handling.
// ---------------------------------------------------------------------------
test("no response uses error.code + path + 'no response from server'", () => {
  const err = makeAxiosError({
    method: "post",
    url: "/comments/create",
    status: undefined,
    code: "ECONNREFUSED",
    message: "connect ECONNREFUSED 127.0.0.1:3000",
  });
  formatDocmostAxiosError(err);
  assert.equal(
    err.message,
    "POST /comments/create failed: ECONNREFUSED (no response from server)",
  );
});

test("no response with no code falls back to a neutral reason (raw message not leaked — it may embed host:port)", () => {
  const err = makeAxiosError({
    method: "post",
    url: "/comments/create",
    status: undefined,
    // A raw axios network message like "connect ECONNREFUSED 127.0.0.1:3000"
    // embeds the host; #437's invariant is that it never reaches the message.
    message: "connect ECONNREFUSED 10.0.0.5:3000",
  });
  formatDocmostAxiosError(err);
  assert.equal(
    err.message,
    "POST /comments/create failed: network error (no response from server)",
  );
  // And the host must NOT appear anywhere in the model-visible message.
  assert.ok(!err.message.includes("10.0.0.5"));
});

test("path drops the host and the query string", () => {
  const err = makeAxiosError({
    method: "post",
    url: "/comments/resolve?token=secret&x=1",
    baseURL: "https://docs.example.com/api",
    status: 400,
    statusText: "Bad Request",
    data: { message: "bad" },
  });
  formatDocmostAxiosError(err);
  assert.equal(
    err.message,
    "POST /comments/resolve failed (400 Bad Request): bad",
  );
  assert.ok(!err.message.includes("secret"), "query string must not leak");
  assert.ok(!err.message.includes("docs.example.com"), "host must not leak");
});

// ---------------------------------------------------------------------------
// formatDocmostAxiosError: length cap + guard flag + pass-through.
// ---------------------------------------------------------------------------
test("the overall message is capped at ~300 chars", () => {
  const err = makeAxiosError({
    status: 400,
    statusText: "Bad Request",
    data: { message: "y".repeat(1000) },
  });
  formatDocmostAxiosError(err);
  assert.ok(err.message.length <= 300, `expected <=300, got ${err.message.length}`);
  assert.ok(err.message.endsWith("…"), "a truncated message ends with an ellipsis");
});

test("a formatted error is not re-processed (guard flag)", () => {
  const err = makeAxiosError({
    status: 400,
    statusText: "Bad Request",
    data: { message: "first" },
  });
  formatDocmostAxiosError(err);
  const once = err.message;
  assert.equal(err._docmostFormatted, true);
  // Mutate the body and re-run: the guard makes it a no-op.
  err.response.data = { message: "second" };
  formatDocmostAxiosError(err);
  assert.equal(err.message, once, "the guard flag prevents double-processing");
});

test("a non-axios error is passed through untouched", () => {
  const plain = new Error("boom");
  formatDocmostAxiosError(plain);
  assert.equal(plain.message, "boom");
  assert.equal(plain._docmostFormatted, undefined);
});

// ---------------------------------------------------------------------------
// assertFullUuid.
// ---------------------------------------------------------------------------
const GOOD_UUID = "019f499a-9f8c-7d68-b7be-ce100d7c6c56";

test("assertFullUuid accepts a full canonical UUID (any version nibble)", () => {
  assert.doesNotThrow(() => assertFullUuid("resolveComment", "commentId", GOOD_UUID));
  // A v4 id also passes (version/variant-agnostic).
  assert.doesNotThrow(() =>
    assertFullUuid("get_comment", "commentId", "3d5b7c1e-2f4a-4b6c-8d9e-0f1a2b3c4d5e"),
  );
});

test("assertFullUuid rejects a truncated prefix", () => {
  assert.throws(
    () => assertFullUuid("resolveComment", "commentId", "019f499a"),
    (e) =>
      e.message.startsWith(
        "resolveComment: 'commentId' must be the FULL comment UUID",
      ) &&
      e.message.includes("got '019f499a'") &&
      e.message.includes("Copy the id verbatim"),
  );
});

test("assertFullUuid rejects garbage and empty string", () => {
  assert.throws(
    () => assertFullUuid("deleteComment", "commentId", "not-a-uuid"),
    /must be the FULL comment UUID.*got 'not-a-uuid'/s,
  );
  assert.throws(
    () => assertFullUuid("updateComment", "commentId", ""),
    /must be the FULL comment UUID.*got ''/s,
  );
});

// ---------------------------------------------------------------------------
// End-to-end over an offline http server: interceptor wiring + re-login.
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${port}/api` });
    });
  });
}
function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(obj));
}
const openServers = [];
async function spawn(handler) {
  const { server, baseURL } = await startServer(handler);
  openServers.push(server);
  return { baseURL };
}
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

test("a 400 on a JSON endpoint is reformatted by the wired interceptor", async () => {
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/info") {
      sendJson(res, 400, { message: "pageId should not be empty" });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "u@example.com", "pw");
  await assert.rejects(
    () => client.getPageRaw("x"),
    (e) => {
      assert.ok(axios.isAxiosError(e), "still an AxiosError (mutation, not a subclass)");
      assert.equal(e.response?.status, 400, "error.response?.status still readable");
      assert.equal(
        e.message,
        "POST /pages/info failed (400 Bad Request): pageId should not be empty",
      );
      return true;
    },
  );
});

test("401 -> re-login -> successful retry: the SUCCESS message is untouched", async () => {
  let infoCalls = 0;
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=fresh; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/workspace/info") {
      infoCalls++;
      if (infoCalls === 1) sendJson(res, 401, { message: "Unauthorized" });
      else sendJson(res, 200, { success: true, data: { id: "ws" } });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "u@example.com", "pw");
  client.token = "stale";
  client.client.defaults.headers.common["Authorization"] = "Bearer stale";

  const result = await client.getWorkspace();
  assert.equal(result.success, true, "the retried request resolved successfully");
  assert.equal(infoCalls, 2, "401 then a successful replay");
});

test("401 -> re-login -> persistent failure: formatted AND retry guard intact", async () => {
  let infoCalls = 0;
  let loginCalls = 0;
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      loginCalls++;
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=fresh; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/workspace/info") {
      infoCalls++;
      // Always 401, even after a fresh login: the _retry guard must stop here.
      sendJson(res, 401, { message: "token still invalid" });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "u@example.com", "pw");
  client.token = "stale";
  client.client.defaults.headers.common["Authorization"] = "Bearer stale";

  await assert.rejects(
    () => client.getWorkspace(),
    (e) => {
      assert.equal(
        e.message,
        "POST /workspace/info failed (401 Unauthorized): token still invalid",
      );
      return true;
    },
  );
  // The _retry guard is intact: exactly one replay (2 hits), one re-login.
  assert.equal(infoCalls, 2, "endpoint hit at most twice (one retry only)");
  assert.equal(loginCalls, 1, "re-login attempted exactly once");
});

// ---------------------------------------------------------------------------
// assertFullUuid application points: NO network call when the id is invalid.
// A server that counts EVERY request proves the guard short-circuits before
// even the login round-trip.
// ---------------------------------------------------------------------------
test("all 5 comment-id call sites reject a bad id with ZERO network traffic", async () => {
  let requests = 0;
  const { baseURL } = await spawn(async (req, res) => {
    requests++;
    await readBody(req);
    sendJson(res, 200, { success: true });
  });

  const client = new DocmostClient(baseURL, "u@example.com", "pw");
  const bad = "019f499a"; // truncated

  await assert.rejects(() => client.resolveComment(bad, true), /resolveComment: 'commentId'/);
  await assert.rejects(() => client.updateComment(bad, "hi"), /updateComment: 'commentId'/);
  await assert.rejects(() => client.deleteComment(bad), /deleteComment: 'commentId'/);
  await assert.rejects(() => client.getComment(bad), /get_comment: 'commentId'/);
  // createComment validates parentCommentId only when provided.
  await assert.rejects(
    () => client.createComment("page-1", "body", "inline", "sel", bad),
    /createComment: 'parentCommentId'/,
  );

  assert.equal(requests, 0, "no request (not even /auth/login) may be issued for a bad id");
});
