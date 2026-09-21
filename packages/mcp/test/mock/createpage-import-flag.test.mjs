// #502 BLOCKER 1 (client half): the MCP `createPage` tool builds its body as an
// AGENT-authored markdown file and POSTs it to the server `/pages/import`
// endpoint. It must send the `disableMarkdownExtensions=true` multipart field so
// the SERVER importer runs with math + fuzzy-autolink OFF (a human file upload
// omits the field and keeps them ON). This mock http server captures the raw
// multipart body and asserts the field is present.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocmostClient } from "../../build/client.js";

function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(obj));
}
function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

const openServers = [];
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

const NEW_ID = "00000000-0000-4000-8000-000000000042";
const SPACE = "00000000-0000-4000-8000-0000000000aa";

function spawn(state) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const raw = await readRaw(req);
      if (req.url === "/api/auth/login") {
        return sendJson(res, 200, { success: true }, { "Set-Cookie": "authToken=t; Path=/; HttpOnly" });
      }
      if (req.url === "/api/pages/import") {
        state.importBody = raw; // the raw multipart payload
        return sendJson(res, 200, { data: { id: NEW_ID } });
      }
      if (req.url === "/api/pages/update") {
        return sendJson(res, 200, { data: { id: NEW_ID } });
      }
      if (req.url === "/api/pages/info") {
        return sendJson(res, 200, {
          data: {
            id: NEW_ID,
            slugId: "slugnew1234",
            title: "T",
            spaceId: SPACE,
            updatedAt: "2026-01-01T00:00:00Z",
            content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
          },
        });
      }
      if (req.url === "/api/pages/sidebar-pages") {
        return sendJson(res, 200, { data: { items: [], meta: { hasNextPage: false, nextCursor: null } } });
      }
      return sendJson(res, 404, { message: "not found" });
    });
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}/api`);
    });
  });
}

test("createPage sends disableMarkdownExtensions=true in the /pages/import multipart", async () => {
  const state = {};
  const baseURL = await spawn(state);
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  await client.createPage("My Config", "ticket $x=1$ at www.host.com", SPACE);

  assert.ok(state.importBody, "the import endpoint received a body");
  // The multipart payload carries the field name and its "true" value.
  assert.match(state.importBody, /name="disableMarkdownExtensions"/);
  assert.match(state.importBody, /name="disableMarkdownExtensions"[\s\S]*?\r?\n\r?\ntrue\r?\n/);
  // The agent body itself is still sent as the file part.
  assert.match(state.importBody, /ticket \$x=1\$ at www\.host\.com/);
});
