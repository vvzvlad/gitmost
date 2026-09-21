// gitmost #328 Channel 2: DocmostClient.listComments hides RESOLVED THREADS
// wholesale by default (a resolved top-level comment AND every reply under it),
// returning `{ items, resolvedThreadsHidden }`. `includeResolved: true` returns
// the full feed. These tests stand a local http.createServer in for Docmost and
// mock the /auth/login + /comments (paginated) routes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocmostClient } from "../../build/client.js";

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

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(obj));
}

const openServers = [];
async function spawn(handler) {
  const { server, baseURL } = await startServer(handler);
  openServers.push(server);
  return { server, baseURL };
}

after(async () => {
  await Promise.all(openServers.map((s) => closeServer(s)));
});

// A minimal ProseMirror comment body (a paragraph of text).
const body = (t) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});

// Feed: an ACTIVE thread whose REPLY is resolved (root active, reply resolved —
// the thread must STAY, because a thread is gated only by its ROOT's resolvedAt)
// and a RESOLVED thread (root + reply).
const FEED = [
  {
    id: "a",
    pageId: "page-1",
    parentCommentId: null,
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    creatorId: "u1",
    content: body("active root"),
  },
  {
    id: "a1",
    pageId: "page-1",
    parentCommentId: "a",
    // A RESOLVED reply under an ACTIVE root: the thread is NOT hidden (only a
    // resolved ROOT hides a thread), so this reply survives the default filter.
    resolvedAt: "2026-02-15T00:00:00.000Z",
    createdAt: "2026-01-01T01:00:00.000Z",
    creatorId: "u1",
    content: body("resolved reply of an active thread"),
  },
  {
    id: "r",
    pageId: "page-1",
    parentCommentId: null,
    resolvedAt: "2026-02-01T00:00:00.000Z",
    createdAt: "2026-01-02T00:00:00.000Z",
    creatorId: "u1",
    content: body("resolved root"),
  },
  {
    id: "r1",
    pageId: "page-1",
    parentCommentId: "r",
    resolvedAt: null,
    createdAt: "2026-01-02T01:00:00.000Z",
    creatorId: "u1",
    content: body("resolved reply"),
  },
];

function commentsServer() {
  return spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/comments") {
      // Single page, no cursor.
      sendJson(res, 200, { data: { items: FEED, meta: { nextCursor: null } } });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });
}

test("default hides the resolved thread (root + its reply) and counts it", async () => {
  const { baseURL } = await commentsServer();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const result = await client.listComments("page-1");
  assert.equal(Array.isArray(result.items), true, "returns { items, ... }");
  const ids = result.items.map((c) => c.id).sort();
  assert.deepEqual(ids, ["a", "a1"], "only the active thread remains");
  assert.equal(result.resolvedThreadsHidden, 1, "one resolved thread hidden");
});

test("includeResolved:true returns EVERYTHING with zero hidden", async () => {
  const { baseURL } = await commentsServer();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const result = await client.listComments("page-1", true);
  const ids = result.items.map((c) => c.id).sort();
  assert.deepEqual(ids, ["a", "a1", "r", "r1"], "all four comments returned");
  assert.equal(result.resolvedThreadsHidden, 0, "nothing hidden with the flag");
});

test("the reply of a resolved thread is hidden with the thread", async () => {
  const { baseURL } = await commentsServer();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const result = await client.listComments("page-1");
  const ids = result.items.map((c) => c.id);
  assert.equal(ids.includes("r1"), false, "the resolved thread's reply is gone");
  assert.equal(ids.includes("r"), false, "the resolved root is gone");
});

test("an ACTIVE thread whose REPLY is resolved is NOT hidden", async () => {
  // A thread is gated only by its ROOT's resolvedAt. `a1` is a resolved reply
  // under the active root `a`, so both must survive the default filter and the
  // thread must not be counted as hidden.
  const { baseURL } = await commentsServer();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const result = await client.listComments("page-1");
  const ids = result.items.map((c) => c.id).sort();
  assert.equal(ids.includes("a"), true, "active root stays");
  assert.equal(ids.includes("a1"), true, "its resolved reply stays with the thread");
  assert.equal(result.resolvedThreadsHidden, 1, "only the resolved-root thread is hidden");
});
