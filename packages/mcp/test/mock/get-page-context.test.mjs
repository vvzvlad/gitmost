// Mock-HTTP tests for DocmostClient.getPageContext — the #443 "where am I /
// what's around" read tool. A local http.createServer stands in for Docmost
// (same harness style as pagination-cursor.test.mjs) so everything is
// deterministic and offline.
//
// Contract pinned here:
//   - Two requests: POST /pages/breadcrumbs (ancestor chain root->page, page
//     INCLUDED as the LAST element) + listSidebarPages (direct children).
//   - Split: last chain element -> `page`; the rest (root->parent) ->
//     `breadcrumbs`. A ROOT page (chain length 1) -> breadcrumbs: [].
//   - children: {pageId, title, hasChildren} in sidebar order.
//   - INVARIANT: only the UUID `pageId` is exposed, never `slugId`.
//   - A slugId input is resolved via /pages/info first (adds one request); a
//     UUID input short-circuits (stays at two requests).
//   - A bad/inaccessible pageId throws a CLEAR error, not an empty object.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocmostClient } from "../../build/client.js";

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
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

function handleLogin(req, res) {
  if (req.url === "/api/auth/login") {
    sendJson(res, 200, { success: true }, {
      "Set-Cookie": "authToken=t; Path=/; HttpOnly",
    });
    return true;
  }
  return false;
}

// Two real UUIDs so resolvePageId short-circuits (no /pages/info round-trip).
const ROOT_UUID = "00000000-0000-4000-8000-000000000001";
const MID_UUID = "00000000-0000-4000-8000-000000000002";
const PAGE_UUID = "00000000-0000-4000-8000-000000000003";
const CHILD_A = "00000000-0000-4000-8000-00000000000a";
const CHILD_B = "00000000-0000-4000-8000-00000000000b";

// Build a breadcrumbs response as the server sends it: root->page order, page
// LAST, wrapped in the {data,success} envelope. slugId/icon/position are present
// on the wire (they must NOT leak into the tool output).
function breadcrumbsEnvelope(chain) {
  return { success: true, data: chain };
}

// -----------------------------------------------------------------------------
// 1) 3rd-level page: page = last chain element; breadcrumbs = the two ancestors
//    root->parent; children mapped {pageId,title,hasChildren} in order; no leak;
//    exactly two requests for a UUID input.
// -----------------------------------------------------------------------------
test("getPageContext: 3rd-level page splits chain, maps children, no slugId leak, 2 requests", async () => {
  let breadcrumbReqs = 0;
  let sidebarReqs = 0;
  let infoReqs = 0;
  let breadcrumbBody = null;

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/info") {
      infoReqs++;
      sendJson(res, 404, {});
      return;
    }
    if (req.url === "/api/pages/breadcrumbs") {
      breadcrumbReqs++;
      breadcrumbBody = JSON.parse(raw || "{}");
      // root -> parent -> page (page LAST). slugId/icon/position on the wire.
      sendJson(
        res,
        200,
        breadcrumbsEnvelope([
          { id: ROOT_UUID, slugId: "rootSlug", title: "Infrastructure", spaceId: "sp1", position: "a", icon: null, parentPageId: null, hasChildren: true },
          { id: MID_UUID, slugId: "midSlug", title: "Datacenter A", spaceId: "sp1", position: "a", icon: null, parentPageId: ROOT_UUID, hasChildren: true },
          { id: PAGE_UUID, slugId: "pageSlug", title: "Rack 12", spaceId: "sp1", position: "b", icon: null, parentPageId: MID_UUID, hasChildren: true },
        ]),
      );
      return;
    }
    if (req.url === "/api/pages/sidebar-pages") {
      sidebarReqs++;
      const body = JSON.parse(raw || "{}");
      assert.equal(body.pageId, PAGE_UUID, "children scoped to the page UUID");
      assert.equal(body.spaceId, "sp1", "children scoped to the page's space");
      sendJson(res, 200, {
        success: true,
        data: {
          items: [
            { id: CHILD_A, slugId: "aSlug", title: "Servers", parentPageId: PAGE_UUID, hasChildren: true, position: "a" },
            { id: CHILD_B, slugId: "bSlug", title: "Network", parentPageId: PAGE_UUID, hasChildren: false, position: "b" },
          ],
          meta: { hasNextPage: false, nextCursor: null },
        },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const result = await client.getPageContext(PAGE_UUID);

  assert.equal(infoReqs, 0, "UUID input short-circuits resolvePageId (no /pages/info)");
  assert.equal(breadcrumbReqs, 1, "exactly one breadcrumbs request");
  assert.equal(sidebarReqs, 1, "exactly one sidebar request");
  assert.deepEqual(breadcrumbBody, { pageId: PAGE_UUID }, "breadcrumbs posts the UUID");

  // page = the LAST chain element.
  assert.deepEqual(result.page, {
    pageId: PAGE_UUID,
    title: "Rack 12",
    spaceId: "sp1",
  });
  // breadcrumbs = root->parent (the chain minus the page itself).
  assert.deepEqual(result.breadcrumbs, [
    { pageId: ROOT_UUID, title: "Infrastructure" },
    { pageId: MID_UUID, title: "Datacenter A" },
  ]);
  // children mapped in order, hasChildren coerced to boolean.
  assert.deepEqual(result.children, [
    { pageId: CHILD_A, title: "Servers", hasChildren: true },
    { pageId: CHILD_B, title: "Network", hasChildren: false },
  ]);

  // No slugId anywhere in the output.
  const dump = JSON.stringify(result);
  assert.ok(!dump.includes("Slug"), "no slugId leaks into the output");
  assert.ok(!/\bslugId\b/.test(dump), "no slugId key in the output");
});

// -----------------------------------------------------------------------------
// 2) ROOT page: chain has ONE element (the page itself) -> breadcrumbs: [].
// -----------------------------------------------------------------------------
test("getPageContext: a root page has breadcrumbs: []", async () => {
  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/breadcrumbs") {
      // A root page: the CTE returns only the page itself.
      sendJson(
        res,
        200,
        breadcrumbsEnvelope([
          { id: ROOT_UUID, slugId: "rootSlug", title: "Infrastructure", spaceId: "sp1", parentPageId: null, hasChildren: false },
        ]),
      );
      return;
    }
    if (req.url === "/api/pages/sidebar-pages") {
      sendJson(res, 200, {
        success: true,
        data: { items: [], meta: { hasNextPage: false, nextCursor: null } },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const result = await client.getPageContext(ROOT_UUID);

  assert.deepEqual(result.page, {
    pageId: ROOT_UUID,
    title: "Infrastructure",
    spaceId: "sp1",
  });
  assert.deepEqual(result.breadcrumbs, [], "root page: no ancestors");
  assert.deepEqual(result.children, [], "no children");
});

// -----------------------------------------------------------------------------
// 3) A slugId input is resolved via /pages/info first (one extra request), then
//    breadcrumbs/sidebar use the resolved UUID.
// -----------------------------------------------------------------------------
test("getPageContext: a slugId input is resolved via /pages/info", async () => {
  let infoReqs = 0;
  let infoBody = null;
  let breadcrumbBody = null;

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/info") {
      infoReqs++;
      infoBody = JSON.parse(raw || "{}");
      // getPageRaw: slugId -> canonical UUID.
      sendJson(res, 200, {
        success: true,
        data: { id: PAGE_UUID, slugId: "pageSlug", title: "Rack 12", spaceId: "sp1" },
      });
      return;
    }
    if (req.url === "/api/pages/breadcrumbs") {
      breadcrumbBody = JSON.parse(raw || "{}");
      sendJson(
        res,
        200,
        breadcrumbsEnvelope([
          { id: ROOT_UUID, slugId: "rootSlug", title: "Infrastructure", spaceId: "sp1", parentPageId: null },
          { id: PAGE_UUID, slugId: "pageSlug", title: "Rack 12", spaceId: "sp1", parentPageId: ROOT_UUID },
        ]),
      );
      return;
    }
    if (req.url === "/api/pages/sidebar-pages") {
      sendJson(res, 200, {
        success: true,
        data: { items: [], meta: { hasNextPage: false, nextCursor: null } },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const result = await client.getPageContext("pageSlug");

  assert.equal(infoReqs, 1, "slugId resolved via one /pages/info");
  assert.deepEqual(infoBody, { pageId: "pageSlug" }, "resolve posts the raw slugId");
  assert.deepEqual(
    breadcrumbBody,
    { pageId: PAGE_UUID },
    "breadcrumbs posts the RESOLVED uuid, not the slugId",
  );
  assert.equal(result.page.pageId, PAGE_UUID, "page.pageId is the UUID");
  assert.deepEqual(result.breadcrumbs, [
    { pageId: ROOT_UUID, title: "Infrastructure" },
  ]);
});

// -----------------------------------------------------------------------------
// 4) >20 children: cursor pagination returns ALL of them, no dupes (regression
//    on the #442 bug class — getPageContext must not re-introduce a cap).
// -----------------------------------------------------------------------------
test("getPageContext: a page with >20 children returns ALL of them (no cap, no dupes)", async () => {
  // 45 children spread over three cursor pages.
  const all = Array.from({ length: 45 }, (_, i) => ({
    id: `child-${i}`,
    slugId: `slug-${i}`,
    title: `Child ${i}`,
    parentPageId: PAGE_UUID,
    hasChildren: i % 2 === 0,
  }));
  const PAGES = {
    "": { items: all.slice(0, 20), nextCursor: "c1" },
    c1: { items: all.slice(20, 40), nextCursor: "c2" },
    c2: { items: all.slice(40), nextCursor: null },
  };

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/breadcrumbs") {
      sendJson(
        res,
        200,
        breadcrumbsEnvelope([
          { id: PAGE_UUID, slugId: "pageSlug", title: "Big Parent", spaceId: "sp1", parentPageId: null },
        ]),
      );
      return;
    }
    if (req.url === "/api/pages/sidebar-pages") {
      const body = JSON.parse(raw || "{}");
      const page = PAGES[body.cursor ?? ""] ?? { items: [], nextCursor: null };
      sendJson(res, 200, {
        success: true,
        data: {
          items: page.items,
          meta: { hasNextPage: page.nextCursor != null, nextCursor: page.nextCursor },
        },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const result = await client.getPageContext(PAGE_UUID);

  assert.equal(result.children.length, 45, "all 45 children returned");
  const ids = result.children.map((c) => c.pageId);
  assert.equal(new Set(ids).size, 45, "no duplicate children");
  assert.deepEqual(ids, all.map((c) => c.id), "children in server order across cursor pages");
  assert.equal(result.children[0].hasChildren, true, "hasChildren preserved (child 0)");
  assert.equal(result.children[1].hasChildren, false, "hasChildren preserved (child 1)");
});

// -----------------------------------------------------------------------------
// 5) A nonexistent / inaccessible pageId -> a CLEAR error, NOT an empty object.
// -----------------------------------------------------------------------------
test("getPageContext: a bad/inaccessible pageId throws a clear error (not {})", async () => {
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/breadcrumbs") {
      // Server rejects an unknown/forbidden page.
      sendJson(res, 404, { message: "Page not found" });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  await assert.rejects(
    () => client.getPageContext(PAGE_UUID),
    (err) => {
      assert.ok(err instanceof Error, "throws an Error");
      return true;
    },
    "a 404 from breadcrumbs propagates as a thrown error, not a hollow {}",
  );
});

// -----------------------------------------------------------------------------
// 6) An empty breadcrumbs chain (should never happen — the endpoint always
//    includes the page itself) is treated as not-found, not a hollow {page:...}.
// -----------------------------------------------------------------------------
test("getPageContext: an empty breadcrumbs chain throws (defensive)", async () => {
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/breadcrumbs") {
      sendJson(res, 200, breadcrumbsEnvelope([]));
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  await assert.rejects(
    () => client.getPageContext(PAGE_UUID),
    /not found or inaccessible/,
    "an empty chain is a clear error, not {}",
  );
});
