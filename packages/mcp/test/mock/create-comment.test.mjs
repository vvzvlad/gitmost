// Mock-HTTP orchestration tests for DocmostClient.createComment. createComment
// is inline-only and anchored: a top-level comment REQUIRES a selection that
// can be anchored in the document (a failure rolls the comment back and throws),
// while a reply inherits its parent's anchor and is stored as the historical
// "page" type. These tests stand a local http.createServer in for Docmost and
// only mock plain-HTTP routes — they deliberately avoid the live anchoring step
// (the Hocuspocus collab WebSocket) by either short-circuiting BEFORE creation
// (cases 1 and 2) or exercising the reply path that skips anchoring (case 3).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocmostClient } from "../../build/client.js";

// Read a request body to completion (drain the stream and parse JSON when used).
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
// 1) Top-level comment without a selection throws and creates nothing.
// -----------------------------------------------------------------------------
test("a top-level comment without a selection throws and never POSTs /comments/create", async () => {
  let createCalls = 0;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/comments/create") {
      createCalls++;
      sendJson(res, 200, { data: { id: "should-not-happen" } });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  await assert.rejects(
    () => client.createComment("page-1", "body", "inline", undefined),
    /selection/i,
    "a missing selection must reject with a 'selection required' error",
  );
  assert.equal(
    createCalls,
    0,
    "/comments/create must NEVER be called when the selection is missing",
  );
});

// -----------------------------------------------------------------------------
// 2) Top-level comment whose selection is absent from the page throws BEFORE
//    creating anything (the getPageJson / /pages/info pre-check short-circuits).
// -----------------------------------------------------------------------------
test("a top-level comment whose selection is absent from the page throws before creating", async () => {
  let createCalls = 0;
  let infoCalls = 0;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/info") {
      infoCalls++;
      // A page whose body does NOT contain the requested selection text.
      sendJson(res, 200, {
        data: {
          id: "page-1",
          slugId: "slug-1",
          title: "Page",
          spaceId: "sp-1",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "hello world" }],
              },
            ],
          },
        },
      });
      return;
    }
    if (req.url === "/api/comments/create") {
      createCalls++;
      sendJson(res, 200, { data: { id: "should-not-happen" } });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  await assert.rejects(
    () =>
      client.createComment(
        "page-1",
        "body",
        "inline",
        "this text is not present",
      ),
    /could not find the selection/i,
    "an unanchorable selection must reject with a 'could not find the selection' error",
  );
  assert.ok(infoCalls >= 1, "the pre-check must read the page via /pages/info");
  assert.equal(
    createCalls,
    0,
    "/comments/create must NEVER be called when the pre-check fails",
  );
});

// -----------------------------------------------------------------------------
// 3) A reply (parentCommentId set) creates successfully WITHOUT a selection,
//    WITHOUT anchoring, and is stored as type "page" — the pre-check/anchoring
//    (and thus /pages/info) is skipped entirely.
// -----------------------------------------------------------------------------
test("a reply creates without selection or anchoring and is stored as type 'page'", async () => {
  let createPayload = null;
  let infoCalls = 0;

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/info") {
      infoCalls++;
      sendJson(res, 200, { data: { id: "page-1", content: { type: "doc", content: [] } } });
      return;
    }
    if (req.url === "/api/comments/create") {
      createPayload = JSON.parse(raw);
      sendJson(res, 200, {
        data: {
          id: "c-reply-1",
          content: createPayload.content,
          parentCommentId: createPayload.parentCommentId,
          type: createPayload.type,
        },
      });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const result = await client.createComment(
    "page-1",
    "reply body",
    "inline",
    undefined,
    "parent-123",
  );

  assert.equal(result.success, true, "a reply must resolve successfully");
  assert.ok(createPayload, "/comments/create must have been called");
  assert.equal(
    createPayload.parentCommentId,
    "parent-123",
    "the reply payload must carry the parentCommentId",
  );
  assert.equal(
    createPayload.type,
    "page",
    "a reply must be stored as the historical 'page' type, not 'inline'",
  );
  assert.equal(
    "selection" in createPayload,
    false,
    "a reply payload must NOT carry a selection field",
  );
  assert.equal(
    infoCalls,
    0,
    "a reply must skip the pre-check/anchoring (no /pages/info read)",
  );
});
