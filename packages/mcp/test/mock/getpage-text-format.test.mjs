// #502 READ: the getPage tool gains a `format:"text"` mode. It requests the
// server's flat, deterministic text rendering (the server's jsonToText path — the
// SAME serializer that feeds search), passing it through unchanged. This mock
// stands up a local http server (same harness style as getpage-conversion-cache)
// and asserts end-to-end that:
//   - format:"text" sends `format:"text"` in the /pages/info body and returns the
//     server's text string verbatim (no client-side markdown conversion);
//   - the DEFAULT (no format) still returns markdown-converted content;
//   - the text read resolves page + subpages like the markdown read.
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
function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(obj));
}

const openServers = [];
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

const PAGE_UUID = "00000000-0000-4000-8000-000000000010";
const SPACE_UUID = "00000000-0000-4000-8000-0000000000aa";
const CHILD_UUID = "00000000-0000-4000-8000-0000000000bb";

// The deterministic text the SERVER's jsonToText would produce for this page.
const SERVER_TEXT = "Title line\nsecond block\n[image]\n[table 2x3]";

function makeDoc(text) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function spawn(state) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const body = await readBody(req);
      if (req.url === "/api/auth/login") {
        return sendJson(res, 200, { success: true }, { "Set-Cookie": "authToken=t; Path=/; HttpOnly" });
      }
      if (req.url === "/api/pages/info") {
        const parsed = body ? JSON.parse(body) : {};
        state.lastInfoBody = parsed;
        // Emulate the server: when format:"text" is requested, `content` is the
        // flat text string; otherwise it is the raw ProseMirror JSON.
        const content = parsed.format === "text" ? SERVER_TEXT : makeDoc("Title line");
        return sendJson(res, 200, {
          success: true,
          data: {
            id: PAGE_UUID,
            slugId: "slug123456",
            title: "Text Page",
            parentPageId: null,
            spaceId: SPACE_UUID,
            updatedAt: "2026-01-01T00:00:00Z",
            content,
          },
        });
      }
      if (req.url === "/api/pages/sidebar-pages") {
        return sendJson(res, 200, {
          success: true,
          data: {
            items: [{ id: CHILD_UUID, title: "Child", hasChildren: false }],
            meta: { hasNextPage: false, nextCursor: null },
          },
        });
      }
      return sendJson(res, 404, { message: "not found" });
    });
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}/api`);
    });
  });
}

function makeClient(baseURL) {
  return new DocmostClient({ apiUrl: baseURL, getToken: async () => "access" });
}

test('getPage(format:"text") requests text and returns the server text verbatim', async () => {
  const state = {};
  const client = makeClient(await spawn(state));

  const result = await client.getPage(PAGE_UUID, "text");
  assert.equal(state.lastInfoBody.format, "text", "the info request carried format:text");
  assert.equal(result.success, true);
  assert.equal(result.data.content, SERVER_TEXT, "returns the server's flat text unchanged");
  // Deterministic placeholders are surfaced to the agent.
  assert.ok(result.data.content.includes("[image]"));
  assert.ok(result.data.content.includes("[table 2x3]"));
  // No client-side markdown artifacts leaked in.
  assert.ok(!result.data.content.includes("{{SUBPAGES}}"));
  // Subpages still resolve for context.
  assert.deepEqual(result.data.subpages, [{ id: CHILD_UUID, title: "Child" }]);
});

test('getPage default (no format) still returns markdown, not text', async () => {
  const state = {};
  const client = makeClient(await spawn(state));

  const result = await client.getPage(PAGE_UUID);
  assert.equal(state.lastInfoBody.format, undefined, "default read sends no format");
  assert.ok(result.data.content.includes("Title line"), "markdown content converted client-side");
  assert.notEqual(result.data.content, SERVER_TEXT);
});
