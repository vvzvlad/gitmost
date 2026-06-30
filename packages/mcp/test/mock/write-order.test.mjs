// Mock-HTTP regression for the body-before-title write order (#159 finding #10,
// PR #185 review pt 3). `updatePage` / `updatePageJson` must write the page BODY
// (collab) BEFORE the title (REST POST /pages/update), so a failed body write
// never leaves a NEW title over the OLD body (split-brain). We point the client
// at a mock server that serves auth + collab-token but has NO WebSocket upgrade
// handler, so the collab body write fails fast; we then assert the title was
// never POSTed. With the pre-fix (title-first) order, /pages/update WOULD be hit
// before the body failed.
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
function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

const openServers = [];
async function spawn(handler) {
  const { server, baseURL } = await startServer(handler);
  openServers.push(server);
  return { server, baseURL };
}
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

// A mock server that authenticates and hands out a collab token, tracks whether
// the title endpoint was hit, but has NO WS upgrade handler -> collab fails fast.
function makeServer() {
  const state = { titlePosted: false };
  const handler = async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(
        res,
        200,
        { success: true },
        {
          "Set-Cookie": "authToken=t; Path=/; HttpOnly",
        },
      );
      return;
    }
    if (req.url === "/api/auth/collab-token") {
      sendJson(res, 200, { data: { token: "collab-jwt" } });
      return;
    }
    if (req.url === "/api/pages/info") {
      // Resolve the pageId -> canonical UUID (#260) so the test exercises the
      // real body-write failure (no WS upgrade) rather than a resolve failure.
      sendJson(res, 200, {
        data: { id: "11111111-1111-4111-8111-111111111111", slugId: "page-1" },
      });
      return;
    }
    if (req.url === "/api/pages/update") {
      state.titlePosted = true;
      sendJson(res, 200, { data: {} });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  };
  return { state, handler };
}

test("updatePage does NOT POST the title when the body (collab) write fails (#159)", async () => {
  const { state, handler } = makeServer();
  const { baseURL } = await spawn(handler);
  const client = new DocmostClient(baseURL, "u@e.com", "pw");

  await assert.rejects(() =>
    client.updatePage("page-1", "# Heading\n\nsome body", "New Title"),
  );
  assert.equal(
    state.titlePosted,
    false,
    "title must NOT be posted when the body write failed (body-first order)",
  );
});

test("updatePageJson does NOT POST the title when the body (collab) write fails (#159)", async () => {
  const { state, handler } = makeServer();
  const { baseURL } = await spawn(handler);
  const client = new DocmostClient(baseURL, "u@e.com", "pw");

  const doc = { type: "doc", content: [{ type: "paragraph" }] };
  await assert.rejects(() => client.updatePageJson("page-1", doc, "New Title"));
  assert.equal(
    state.titlePosted,
    false,
    "title must NOT be posted when the body write failed (body-first order)",
  );
});
