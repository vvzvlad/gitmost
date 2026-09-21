// Mock-HTTP integration tests for the getPage conversion cache (issue #479).
// A local http.createServer stands in for Docmost (same harness style as
// get-page-context.test.mjs) so everything is deterministic and offline.
//
// Verifies end-to-end through the real client that:
//   - the FIRST getPage of a page is a MISS (mcp_getpage_cache_misses_total)
//     and converts the content (the server's convert-representative counter);
//   - a SECOND getPage of the same (pageId, updatedAt) is a HIT
//     (mcp_getpage_cache_hits_total) and returns BYTE-IDENTICAL output while
//     skipping the conversion;
//   - a changed updatedAt is a fresh key -> MISS again;
//   - the returned shape still resolves page + subpages.
import { test, after, mock } from "node:test";
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

// A small ProseMirror doc so the converter produces non-trivial markdown.
function makeDoc(text) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

// state.info counts /pages/info hits; state.updatedAt / state.text drive the
// content+version returned; state.sidebar counts sidebar-pages hits;
// state.subpages (when set) drives the child list the sidebar endpoint returns,
// so a test can vary the live subpages across two reads of the same page.
function spawn(state) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      await readBody(req);
      if (req.url === "/api/auth/login") {
        return sendJson(res, 200, { success: true }, {
          "Set-Cookie": "authToken=t; Path=/; HttpOnly",
        });
      }
      if (req.url === "/api/pages/info") {
        state.info++;
        return sendJson(res, 200, {
          success: true,
          data: {
            id: PAGE_UUID,
            slugId: "slug123456",
            title: "Cached Page",
            parentPageId: null,
            spaceId: SPACE_UUID,
            updatedAt: state.updatedAt,
            content: makeDoc(state.text),
          },
        });
      }
      if (req.url === "/api/pages/sidebar-pages") {
        state.sidebar++;
        const items = state.subpages ?? [
          { id: CHILD_UUID, title: "Child", hasChildren: false },
        ];
        return sendJson(res, 200, {
          success: true,
          data: {
            items,
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

test("first read MISS, second read HIT with byte-identical output; convert runs once", async () => {
  const state = { info: 0, sidebar: 0, updatedAt: "2026-01-01T00:00:00Z", text: "Hello world" };
  const baseURL = await spawn(state);
  const metrics = {};
  const client = makeClient(baseURL, metrics);

  const first = await client.getPage(PAGE_UUID);
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 1, "first read is a miss");
  assert.equal(metrics["mcp_getpage_cache_hits_total"] ?? 0, 0, "no hit yet");

  const second = await client.getPage(PAGE_UUID);
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 1, "second read is a hit");
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 1, "still one miss");

  // BYTE-IDENTICAL: the cache only skips recomputation, never changes output.
  assert.deepEqual(second, first, "cached result is identical to the uncached one");
  assert.equal(
    JSON.stringify(second),
    JSON.stringify(first),
    "serialized output is byte-identical",
  );

  // The page fetch + subpages fetch still happen every call (only the CPU
  // conversion is cached); both reads hit /pages/info and sidebar-pages.
  assert.equal(state.info, 2, "both reads still fetch /pages/info");
  assert.equal(state.sidebar, 2, "both reads still fetch subpages");

  // Shape sanity: content present, subpages resolved.
  assert.equal(typeof second.data.content, "string");
  assert.ok(second.data.content.includes("Hello world"));
  assert.deepEqual(second.data.subpages, [{ id: CHILD_UUID, title: "Child" }]);
});

test("a changed updatedAt is a fresh key -> MISS again, with the NEW content", async () => {
  const state = { info: 0, sidebar: 0, updatedAt: "2026-01-01T00:00:00Z", text: "Version one" };
  const baseURL = await spawn(state);
  const metrics = {};
  const client = makeClient(baseURL, metrics);

  const a = await client.getPage(PAGE_UUID); // miss
  const b = await client.getPage(PAGE_UUID); // hit
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 1);
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 1);
  assert.ok(a.data.content.includes("Version one"));

  // The page changes: new updatedAt AND new content.
  state.updatedAt = "2026-02-02T00:00:00Z";
  state.text = "Version two";

  const c = await client.getPage(PAGE_UUID); // miss on the new key
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 2, "changed version -> miss");
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 1, "no stale hit");
  assert.ok(c.data.content.includes("Version two"), "the NEW content is served");
  assert.ok(!c.data.content.includes("Version one"), "no stale markdown");

  const d = await client.getPage(PAGE_UUID); // hit on the new key
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 2, "the new snapshot caches too");
});

test("a slugId read and a UUID read of the same page share one cache entry", async () => {
  // resolvePageId maps the slugId -> UUID via /pages/info; the cache keys on the
  // canonical UUID (resultData.id), so both inputs land on the same entry.
  const state = { info: 0, sidebar: 0, updatedAt: "2026-01-01T00:00:00Z", text: "Shared" };
  const baseURL = await spawn(state);
  const metrics = {};
  const client = makeClient(baseURL, metrics);

  await client.getPage(PAGE_UUID);          // miss (keyed on UUID)
  await client.getPage("slug123456");        // the server returns the same id -> HIT
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 1, "one conversion total");
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 1, "slugId read hits the UUID entry");
});

test("on a conversion HIT, the {{SUBPAGES}} block reflects the LIVE subpages, not the cached ones", async () => {
  // The whole byte-identity guarantee: the cache stores the conversion output
  // BEFORE the {{SUBPAGES}} substitution, so a re-read of an UNCHANGED page still
  // splices the FRESH subpage list. The page body itself contains {{SUBPAGES}}
  // (converts to a literal placeholder); getPage replaces it with the live list.
  const CHILD_A = "00000000-0000-4000-8000-0000000000a1";
  const CHILD_B = "00000000-0000-4000-8000-0000000000b2";
  const state = {
    info: 0,
    sidebar: 0,
    updatedAt: "2026-01-01T00:00:00Z", // FIXED across both reads -> conversion cache HIT
    text: "Body before {{SUBPAGES}} body after",
    subpages: [{ id: CHILD_A, title: "Alpha", hasChildren: false }],
  };
  const baseURL = await spawn(state);
  const metrics = {};
  const client = makeClient(baseURL, metrics);

  // Read 1: MISS (converts). The substitution runs with list A.
  const first = await client.getPage(PAGE_UUID);
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 1, "first read converts (miss)");
  assert.ok(first.data.content.includes("[Alpha](page:" + CHILD_A + ")"), "list A spliced in");
  assert.ok(!first.data.content.includes("{{SUBPAGES}}"), "placeholder consumed");

  // The subpages change while the PAGE CONTENT/updatedAt do NOT: same conversion
  // cache key -> a HIT that skips the CPU walk, but the live substitution must
  // still run on the NEW list B.
  state.subpages = [{ id: CHILD_B, title: "Beta", hasChildren: false }];

  const second = await client.getPage(PAGE_UUID);
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 1, "second read is a conversion HIT");
  assert.equal(metrics["mcp_getpage_cache_misses_total"], 1, "no second conversion");

  // The cache did NOT freeze the subpages block: list B is present, list A gone.
  assert.ok(second.data.content.includes("[Beta](page:" + CHILD_B + ")"), "live list B spliced in on a HIT");
  assert.ok(!second.data.content.includes("Alpha"), "stale list A is NOT frozen into the output");
  assert.deepEqual(second.data.subpages, [{ id: CHILD_B, title: "Beta" }], "subpages field reflects list B");
});

test("a cache HIT SKIPS the convertProseMirrorToMarkdown CPU walk (called once across MISS+HIT)", async () => {
  // The single reason the cache exists: on a hit the expensive PM-tree walk must
  // NOT run. The miss counter alone can't prove this — a broken hit branch that
  // re-converted (same output, misses=1) would leave every other assert green.
  // So spy directly on the conversion seam and assert the call COUNT.
  const state = { info: 0, sidebar: 0, updatedAt: "2026-01-01T00:00:00Z", text: "Body text" };
  const baseURL = await spawn(state);
  const metrics = {};
  const client = makeClient(baseURL, metrics);

  // Spy on the seam that wraps convertProseMirrorToMarkdown; it still delegates,
  // so output stays real and byte-identical — we only count invocations.
  const spy = mock.method(client, "convertPageMarkdown");

  await client.getPage(PAGE_UUID); // MISS -> converts once
  assert.equal(spy.mock.callCount(), 1, "the miss converts exactly once");

  await client.getPage(PAGE_UUID); // HIT -> must NOT convert again
  assert.equal(
    spy.mock.callCount(),
    1,
    "the hit skips the conversion: still exactly one call across MISS+HIT",
  );
  assert.equal(metrics["mcp_getpage_cache_hits_total"], 1, "and it was recorded as a hit");

  spy.mock.restore();
});
