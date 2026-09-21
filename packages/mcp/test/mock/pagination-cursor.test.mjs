// Mock-HTTP tests for the cursor-pagination migration in DocmostClient (#442).
//
// The server switched its list endpoints from OFFSET (`page`) to CURSOR
// (`cursor`/`nextCursor`) pagination, and the global ValidationPipe silently
// strips the obsolete `page` field — so the old offset loops re-fetched page
// one forever (hasNextPage stuck true), dropping every item past the first
// page. These tests pin the new cursor behaviour and the immovable-cursor
// guard that prevents a silent spin/duplication if the protocol drifts again.
//
// A local http.createServer stands in for Docmost so everything stays
// deterministic and offline (same harness style as reauth.test.mjs).
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

// A login handler shared by every server below.
function handleLogin(req, res) {
  if (req.url === "/api/auth/login") {
    sendJson(res, 200, { success: true }, {
      "Set-Cookie": "authToken=t; Path=/; HttpOnly",
    });
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// 1) listSidebarPages: collects every cursor page; #requests == #pages.
// -----------------------------------------------------------------------------
test("listSidebarPages walks all cursor pages and collects every item", async () => {
  // Three pages keyed by the cursor the client sends back.
  const PAGES = {
    "": { items: [{ id: "a" }, { id: "b" }], nextCursor: "c1" },
    c1: { items: [{ id: "c" }, { id: "d" }], nextCursor: "c2" },
    c2: { items: [{ id: "e" }], nextCursor: null },
  };
  let requests = 0;
  const sentLimits = [];

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/sidebar-pages") {
      requests++;
      const body = JSON.parse(raw || "{}");
      sentLimits.push(body.limit);
      const page = PAGES[body.cursor ?? ""] ?? { items: [], nextCursor: null };
      sendJson(res, 200, {
        success: true,
        data: {
          items: page.items,
          meta: {
            hasNextPage: page.nextCursor != null,
            nextCursor: page.nextCursor,
          },
        },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const all = await client.listSidebarPages("space-1");

  assert.equal(requests, 3, "one request per cursor page");
  assert.deepEqual(
    all.map((p) => p.id),
    ["a", "b", "c", "d", "e"],
    "all items across all pages collected in order",
  );
  assert.ok(
    sentLimits.every((l) => l === 100),
    "requests limit:100 (server-side max)",
  );
});

// -----------------------------------------------------------------------------
// 2) REGRESSION on the bug class: server IGNORES the cursor param and always
//    returns page one with hasNextPage:true -> the immovable-cursor guard must
//    terminate the loop with no duplicates, NOT spin to MAX_PAGES.
// -----------------------------------------------------------------------------
test("listSidebarPages terminates (no dups) when the server ignores the cursor", async () => {
  let requests = 0;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/sidebar-pages") {
      requests++;
      // Always the SAME first page with hasNextPage:true and the SAME cursor,
      // exactly as a server that no longer understands our pagination param.
      sendJson(res, 200, {
        success: true,
        data: {
          items: [{ id: "x1" }, { id: "x2" }],
          meta: { hasNextPage: true, nextCursor: "stuck" },
        },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const all = await client.listSidebarPages("space-1");

  // Request 1 (no cursor) gets "stuck"; request 2 (cursor "stuck") gets "stuck"
  // again -> guard trips. Far below the MAX_PAGES=50 ceiling; no runaway dups.
  assert.equal(requests, 2, "stops as soon as the cursor stops moving");
  assert.equal(all.length, 4, "no runaway accumulation / duplication");
});

// -----------------------------------------------------------------------------
// 3a) enumerateSpacePages happy path: a SINGLE /pages/tree request.
// -----------------------------------------------------------------------------
test("enumerateSpacePages (via listPages tree) uses one /pages/tree request", async () => {
  let treeRequests = 0;
  let sidebarRequests = 0;
  let treeBody = null;

  const NODES = [
    { id: "r1", slugId: "r1s", title: "Root 1", parentPageId: null, hasChildren: true, spaceId: "space-1", position: "a", icon: null, canEdit: true },
    { id: "c1", slugId: "c1s", title: "Child 1", parentPageId: "r1", hasChildren: false, spaceId: "space-1", position: "a", icon: null, canEdit: true },
    { id: "r2", slugId: "r2s", title: "Root 2", parentPageId: null, hasChildren: false, spaceId: "space-1", position: "b", icon: null, canEdit: true },
  ];

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/tree") {
      treeRequests++;
      treeBody = JSON.parse(raw || "{}");
      sendJson(res, 200, { success: true, data: { items: NODES } });
      return;
    }
    if (req.url === "/api/pages/sidebar-pages") {
      sidebarRequests++;
      sendJson(res, 200, { success: true, data: { items: [], meta: {} } });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  // listPages tree:true -> enumerateSpacePages(spaceId) -> { tree, truncated }.
  const { tree, truncated } = await client.listPages("space-1", 50, true);

  assert.equal(treeRequests, 1, "exactly one /pages/tree request for the space");
  assert.equal(sidebarRequests, 0, "no per-node sidebar BFS requests");
  assert.deepEqual(treeBody, { spaceId: "space-1" }, "space scope posts spaceId only");
  // The uncapped /pages/tree path is never truncated (#486).
  assert.equal(truncated, false, "primary /pages/tree path is not truncated");
  // buildPageTree nests c1 under r1; two roots at the top level.
  assert.equal(tree.length, 2, "two root nodes");
  const r1 = tree.find((n) => n.id === "r1");
  assert.equal(r1.children.length, 1, "child nested under its root");
  assert.equal(r1.children[0].id, "c1");
});

// -----------------------------------------------------------------------------
// 3b) enumerateSpacePages fallback: /pages/tree 404 -> cursor BFS via sidebar.
// -----------------------------------------------------------------------------
test("enumerateSpacePages falls back to the cursor BFS on /pages/tree 404", async () => {
  let treeRequests = 0;
  const sidebarCalls = [];

  // Root level: one root with children. Child level (pageId=r1): one leaf.
  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/tree") {
      treeRequests++;
      // Stock upstream Docmost has no /pages/tree.
      sendJson(res, 404, { message: "Not Found" });
      return;
    }
    if (req.url === "/api/pages/sidebar-pages") {
      const body = JSON.parse(raw || "{}");
      sidebarCalls.push(body.pageId ?? "<root>");
      if (!body.pageId) {
        sendJson(res, 200, {
          success: true,
          data: {
            items: [
              { id: "r1", title: "Root", parentPageId: null, hasChildren: true },
            ],
            meta: { hasNextPage: false, nextCursor: null },
          },
        });
      } else if (body.pageId === "r1") {
        sendJson(res, 200, {
          success: true,
          data: {
            items: [
              { id: "c1", title: "Leaf", parentPageId: "r1", hasChildren: false },
            ],
            meta: { hasNextPage: false, nextCursor: null },
          },
        });
      } else {
        sendJson(res, 200, {
          success: true,
          data: { items: [], meta: { hasNextPage: false, nextCursor: null } },
        });
      }
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const { tree, truncated } = await client.listPages("space-1", 50, true);

  assert.ok(treeRequests >= 1, "the tree endpoint was attempted first");
  assert.deepEqual(
    sidebarCalls,
    ["<root>", "r1"],
    "fell back to the sidebar BFS: roots then the root's children",
  );
  // Small fallback walk well under the node cap -> not truncated (#486).
  assert.equal(truncated, false, "fallback BFS below the cap is not truncated");
  assert.equal(tree.length, 1, "one root in the built tree");
  assert.equal(tree[0].children[0].id, "c1", "leaf nested via the BFS");
});

// -----------------------------------------------------------------------------
// 3c) enumerateSpacePages fallback SUBTREE: /pages/tree 404 + a rootPageId ->
//     the ROOT page itself must be seeded (via getPageRaw) so its own comments
//     aren't dropped. listSidebarPages(spaceId, root) returns only the root's
//     CHILDREN, so without the seed the root would be absent. (Finding 1.)
// -----------------------------------------------------------------------------
test("enumerateSpacePages fallback subtree seeds the ROOT page itself", async () => {
  const sidebarCalls = [];
  let infoRequests = 0;
  const commentedPages = [];

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/tree") {
      // Stock upstream Docmost -> fall back to the BFS.
      sendJson(res, 404, { message: "Not Found" });
      return;
    }
    if (req.url === "/api/pages/info") {
      // getPageRaw for the root seed. Shape mirrors a real page-info response.
      infoRequests++;
      sendJson(res, 200, {
        success: true,
        data: { id: "root", title: "Root", spaceId: "space-1", hasChildren: true },
      });
      return;
    }
    if (req.url === "/api/pages/sidebar-pages") {
      const body = JSON.parse(raw || "{}");
      sidebarCalls.push(body.pageId ?? "<root>");
      // Children of the root: one leaf. (Root itself is NOT in this list.)
      const items =
        body.pageId === "root"
          ? [{ id: "leaf", title: "Leaf", parentPageId: "root", hasChildren: false }]
          : [];
      sendJson(res, 200, {
        success: true,
        data: { items, meta: { hasNextPage: false, nextCursor: null } },
      });
      return;
    }
    if (req.url === "/api/comments") {
      const body = JSON.parse(raw || "{}");
      commentedPages.push(body.pageId);
      const items =
        body.pageId === "root"
          ? [{ id: "cm1", createdAt: "2030-01-01T00:00:00.000Z", content: null }]
          : [];
      sendJson(res, 200, {
        success: true,
        data: { items, meta: { nextCursor: null } },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  // checkNewComments(space, since, parentPageId) exercises the subtree fallback.
  const result = await client.checkNewComments(
    "space-1",
    "2020-01-01T00:00:00.000Z",
    "root",
  );

  assert.equal(infoRequests, 1, "root was seeded via one getPageRaw");
  assert.equal(sidebarCalls[0], "root", "BFS walked the root's children");
  assert.ok(
    commentedPages.includes("root"),
    "the ROOT page is in scope (its comments were fetched) — not dropped",
  );
  assert.ok(commentedPages.includes("leaf"), "the descendant is in scope too");
  assert.equal(result.checkedPages, 2, "root + one descendant scanned");
  assert.equal(result.totalNewComments, 1, "the root's fresh comment found");
});

// -----------------------------------------------------------------------------
// 5) listComments immovable-cursor guard: the server IGNORES the cursor and
//    keeps returning the same nextCursor -> the loop must terminate (no
//    infinite loop, no duplicates), not spin forever. (Finding 4.)
// -----------------------------------------------------------------------------
test("listComments terminates (no dups) when the server ignores the cursor", async () => {
  let requests = 0;

  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/comments") {
      requests++;
      // Always the SAME page with the SAME nextCursor, as a server that no
      // longer advances the cursor would.
      sendJson(res, 200, {
        success: true,
        data: {
          items: [{ id: "cm1", createdAt: "2030-01-01T00:00:00.000Z", content: null }],
          meta: { nextCursor: "stuck" },
        },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const { items } = await client.listComments("page-1", true);

  // Request 1 (no cursor) gets "stuck"; request 2 (cursor "stuck") gets "stuck"
  // again -> guard trips. Bounded far below MAX_PAGES=50, no runaway dups.
  assert.equal(requests, 2, "stops as soon as the cursor stops moving");
  assert.equal(items.length, 2, "no runaway accumulation / duplication");
});

// -----------------------------------------------------------------------------
// 4) checkNewComments subtree: the root is included in scope WITHOUT a
//    separate getPageRaw (/pages/info) request for the parent.
// -----------------------------------------------------------------------------
test("checkNewComments subtree includes the root without a separate getPageRaw", async () => {
  let pageInfoRequests = 0;
  let treeBody = null;
  const commentedPages = [];

  // /pages/tree (subtree) returns the parent itself plus a descendant, exactly
  // as getPageAndDescendants seeds with id = parentPageId.
  const NODES = [
    { id: "parent", title: "Parent", parentPageId: null, hasChildren: true },
    { id: "kid", title: "Kid", parentPageId: "parent", hasChildren: false },
  ];

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/tree") {
      treeBody = JSON.parse(raw || "{}");
      sendJson(res, 200, { success: true, data: { items: NODES } });
      return;
    }
    if (req.url === "/api/pages/info") {
      // If checkNewComments still fetched the parent separately this would fire.
      pageInfoRequests++;
      sendJson(res, 200, { success: true, data: { id: "parent" } });
      return;
    }
    if (req.url === "/api/comments") {
      const body = JSON.parse(raw || "{}");
      commentedPages.push(body.pageId);
      // One fresh comment on the parent, none elsewhere.
      const items =
        body.pageId === "parent"
          ? [{ id: "cm1", createdAt: "2030-01-01T00:00:00.000Z", content: null }]
          : [];
      sendJson(res, 200, {
        success: true,
        data: { items, meta: { nextCursor: null } },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const result = await client.checkNewComments(
    "space-1",
    "2020-01-01T00:00:00.000Z",
    "parent",
  );

  assert.equal(pageInfoRequests, 0, "no separate getPageRaw for the root");
  assert.deepEqual(treeBody, { pageId: "parent" }, "subtree scope posts pageId");
  assert.ok(
    commentedPages.includes("parent"),
    "the root itself is in scope (comments fetched for it)",
  );
  assert.ok(commentedPages.includes("kid"), "descendants are in scope too");
  assert.equal(result.checkedPages, 2, "root + one descendant scanned");
  assert.equal(result.totalNewComments, 1, "the root's fresh comment found");
});

// -----------------------------------------------------------------------------
// 6) checkNewComments parallelism (#490): the per-page comment fetches run with
//    bounded concurrency (not one-at-a-time), and the results still preserve the
//    page order deterministically regardless of which fetch finishes first.
// -----------------------------------------------------------------------------
test("checkNewComments fetches pages concurrently (bounded) and preserves order", async () => {
  // A subtree with 12 descendants so the scan has plenty to parallelize.
  const NODES = [{ id: "parent", title: "Parent", parentPageId: null, hasChildren: true }];
  for (let i = 0; i < 12; i++) {
    NODES.push({ id: `k${i}`, title: `Kid ${i}`, parentPageId: "parent", hasChildren: false });
  }

  let inFlight = 0;
  let maxInFlight = 0;

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/tree") {
      sendJson(res, 200, { success: true, data: { items: NODES } });
      return;
    }
    if (req.url === "/api/comments") {
      const body = JSON.parse(raw || "{}");
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Hold the response briefly so concurrent fetches actually overlap.
      setTimeout(() => {
        inFlight--;
        // Every page carries one fresh comment so ordering is observable.
        sendJson(res, 200, {
          success: true,
          data: {
            items: [
              { id: `c-${body.pageId}`, createdAt: "2030-01-01T00:00:00.000Z", content: null },
            ],
            meta: { nextCursor: null },
          },
        });
      }, 25);
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const result = await client.checkNewComments(
    "space-1",
    "2020-01-01T00:00:00.000Z",
    "parent",
  );

  // 13 pages (parent + 12 kids) were scanned; each had a fresh comment.
  assert.equal(result.checkedPages, 13, "all pages scanned");
  assert.equal(result.totalNewComments, 13, "one fresh comment per page");
  // Parallelism: more than one request was in flight at once, but never above the
  // cap (6). A serial implementation would show maxInFlight === 1.
  assert.ok(maxInFlight > 1, `expected concurrent fetches, saw max ${maxInFlight}`);
  assert.ok(maxInFlight <= 6, `concurrency must be bounded, saw ${maxInFlight}`);
  // Deterministic order: results follow the page-enumeration order (parent first).
  assert.equal(result.comments[0].pageId, "parent", "results preserve page order");
  assert.deepEqual(
    result.comments.map((r) => r.pageId),
    ["parent", ...Array.from({ length: 12 }, (_, i) => `k${i}`)],
    "result order matches the enumeration order regardless of finish order",
  );
});

// -----------------------------------------------------------------------------
// 7) checkNewComments partial failure (#490): the concurrent scan is resilient —
//    if ONE page's /comments fetch rejects (deleted mid-scan, a transient 500),
//    that page is skipped and the WHOLE scan still resolves with every other
//    page's fresh comments. A single failing fetch must never reject the batch
//    (Promise.all in mapWithConcurrency would otherwise abort all of it) nor
//    corrupt the deterministic order of the pages that DID succeed.
// -----------------------------------------------------------------------------
test("checkNewComments skips a page whose fetch fails and still reports the rest", async () => {
  const NODES = [{ id: "parent", title: "Parent", parentPageId: null, hasChildren: true }];
  for (let i = 0; i < 5; i++) {
    NODES.push({ id: `k${i}`, title: `Kid ${i}`, parentPageId: "parent", hasChildren: false });
  }
  // The one page whose comment fetch blows up (500 -> listComments rejects).
  const FAILING = "k2";

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/pages/tree") {
      sendJson(res, 200, { success: true, data: { items: NODES } });
      return;
    }
    if (req.url === "/api/comments") {
      const body = JSON.parse(raw || "{}");
      if (body.pageId === FAILING) {
        // A transient server error on exactly one page's fetch.
        sendJson(res, 500, { success: false, message: "boom" });
        return;
      }
      sendJson(res, 200, {
        success: true,
        data: {
          items: [
            { id: `c-${body.pageId}`, createdAt: "2030-01-01T00:00:00.000Z", content: null },
          ],
          meta: { nextCursor: null },
        },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  // Must RESOLVE (not reject) despite one page's fetch failing.
  const result = await client.checkNewComments(
    "space-1",
    "2020-01-01T00:00:00.000Z",
    "parent",
  );

  // Every page in scope was still scanned (the failing one counts as checked).
  assert.equal(result.checkedPages, 6, "all pages scanned incl. the failing one");
  // The failing page contributes nothing; the other 5 each report one comment.
  assert.equal(result.pagesWithNewComments, 5, "the failing page is dropped");
  assert.equal(result.totalNewComments, 5, "only the succeeding pages' comments");
  const reportedIds = result.comments.map((r) => r.pageId);
  assert.ok(!reportedIds.includes(FAILING), "the failing page is absent from results");
  // Order of the survivors is still the deterministic enumeration order (the hole
  // left by the failing page is closed without reordering the rest).
  assert.deepEqual(
    reportedIds,
    ["parent", "k0", "k1", "k3", "k4"],
    "survivors keep enumeration order with the failing page removed",
  );
});
