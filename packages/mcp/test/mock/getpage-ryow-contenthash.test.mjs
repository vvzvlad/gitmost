// #647 refinement A — getPage's conversion cache MUST be keyed by the server's
// `contentHash`, NOT `updatedAt`. On the live branch the server serves FRESH
// content under a debounce-stale `updatedAt`; keying by `updatedAt` would cache
// the fresh markdown under the old key and the NEXT read would hit that stale
// entry (no read-your-own-writes). Keying by `contentHash` invalidates exactly
// when content changes.
//
// A local http.createServer stands in for Docmost (same harness style as
// getpage-conversion-cache.test.mjs), fully offline/deterministic.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocmostClient } from "../../build/client.js";

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(obj));
}

const openServers = [];
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

const PAGE_UUID = "00000000-0000-4000-8000-000000000010";
const SPACE_UUID = "00000000-0000-4000-8000-0000000000aa";
const CHILD_UUID = "00000000-0000-4000-8000-0000000000bb";

function makeDoc(text) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

// state.text/state.contentHash drive the content+hash; state.updatedAt is held
// FIXED across a test to simulate the debounce-stale row. state.sawIncludeHash
// records whether getPage asked for the hash.
function spawn(state) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const raw = await readBody(req);
      if (req.url === "/api/auth/login") {
        return sendJson(res, 200, { success: true }, {
          "Set-Cookie": "authToken=t; Path=/; HttpOnly",
        });
      }
      if (req.url === "/api/pages/info") {
        const body = raw ? JSON.parse(raw) : {};
        if (body.includeContentHash) state.sawIncludeHash = true;
        const data = {
          id: PAGE_UUID,
          slugId: "slug123456",
          title: "RYOW Page",
          parentPageId: null,
          spaceId: SPACE_UUID,
          updatedAt: state.updatedAt,
          content: makeDoc(state.text),
        };
        // The server returns contentHash only when asked (opt-in), coherent with
        // the content it returns.
        if (body.includeContentHash) data.contentHash = state.contentHash;
        return sendJson(res, 200, { success: true, data });
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

function makeClient(baseURL, metrics) {
  return new DocmostClient({
    apiUrl: baseURL,
    getToken: async () => "access",
    onMetric: (name, value) => {
      metrics[name] = (metrics[name] ?? 0) + value;
    },
  });
}

test("getPage requests includeContentHash", async () => {
  const state = { updatedAt: "2026-01-01T00:00:00Z", text: "hello", contentHash: "h1" };
  const client = makeClient(await spawn(state), {});
  await client.getPage(PAGE_UUID);
  assert.equal(state.sawIncludeHash, true, "getPage asks the server for the content hash");
});

test("RYOW: content changes under a FIXED updatedAt -> fresh markdown (keyed by contentHash)", async () => {
  const state = { updatedAt: "2026-01-01T00:00:00Z", text: "Version one", contentHash: "hash-v1" };
  const metrics = {};
  const client = makeClient(await spawn(state), metrics);

  const a = await client.getPage(PAGE_UUID); // miss on hash-v1
  assert.ok(a.data.content.includes("Version one"));
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 1);

  const b = await client.getPage(PAGE_UUID); // hit on hash-v1 (unchanged)
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 1, "unchanged content -> hit");
  assert.ok(b.data.content.includes("Version one"));

  // A write lands: content + hash change, but updatedAt is STILL the stale DB row.
  state.text = "Version two";
  state.contentHash = "hash-v2";
  // updatedAt deliberately unchanged.

  const c = await client.getPage(PAGE_UUID);
  // The whole point: keyed by contentHash, this is a MISS on the new hash and
  // returns FRESH markdown. Keyed by updatedAt it would have been a stale HIT.
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 2, "new contentHash -> miss (RYOW)");
  assert.ok(c.data.content.includes("Version two"), "read-your-own-writes: fresh content");
  assert.ok(!c.data.content.includes("Version one"), "no stale markdown served");

  const d = await client.getPage(PAGE_UUID); // hit on hash-v2
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 2, "the new snapshot caches under its hash");
  assert.ok(d.data.content.includes("Version two"));
});

test("falls back to updatedAt when the server returns no contentHash (older server)", async () => {
  const state = { updatedAt: "2026-01-01T00:00:00Z", text: "Legacy", contentHash: undefined };
  const metrics = {};
  const client = makeClient(await spawn(state), metrics);

  await client.getPage(PAGE_UUID); // miss (keyed by updatedAt fallback)
  await client.getPage(PAGE_UUID); // hit (same updatedAt)
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 1);
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 1, "still cacheable via updatedAt fallback");

  state.updatedAt = "2026-03-03T00:00:00Z";
  state.text = "Legacy changed";
  const c = await client.getPage(PAGE_UUID);
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 2, "changed updatedAt -> miss");
  assert.ok(c.data.content.includes("Legacy changed"));
});
