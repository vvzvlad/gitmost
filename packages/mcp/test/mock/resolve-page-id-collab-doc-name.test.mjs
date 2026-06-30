// Mock collab regression for the #260 data-loss bug: the MCP must open every
// collaboration document by the page's CANONICAL UUID (`page.<uuid>`) — the same
// name the web editor uses — even when the agent supplies a public slugId.
//
// Root cause: the agent commonly passes a 10-char slugId (from URLs/listings) as
// pageId. The web tab opens `page.<uuid>`, but the MCP used to pass the slugId
// straight into the collab doc name (`page.<slugId>`), so one DB page ended up
// with TWO independent Yjs documents whose debounced stores clobbered each other
// — the agent's edit was silently lost on reload.
//
// We stand up a real Hocuspocus server (like ambiguous-node-id.test.mjs) and
// capture the EXACT documentName each connection requests via onLoadDocument.
// The /pages/info mock resolves the slugId -> uuid, and counts its own hits so we
// can also prove the UUID short-circuit + cache (no redundant resolve round-trip).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Hocuspocus } from "@hocuspocus/server";
import { DocmostClient } from "../../build/client.js";
import { buildYDoc } from "../../build/lib/collaboration.js";

const SLUG = "dwzDdgPep2"; // 10-char nanoid public id (no dashes)
const UUID = "11111111-1111-4111-8111-111111111111"; // canonical page.id

// A simple one-paragraph document; "hello world" gives editPageText a match and
// insertFootnote an anchor. No table node, so tableInsertRow aborts with
// "no table found" — but the collab doc was still OPENED by then, which is what
// we assert (the doc NAME is fixed at connect time, before any transform runs).
function seedDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [{ type: "text", text: "hello world" }],
      },
    ],
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

// Stand up an HTTP server that authenticates, hands out a collab token, serves
// /pages/info (slugId -> uuid resolution), and upgrades /collab to a Hocuspocus
// instance whose onLoadDocument records the requested documentName.
async function spawnCollabStack() {
  const state = { docNames: [], pagesInfoCalls: [] };

  const hocuspocus = new Hocuspocus({
    quiet: true,
    async onLoadDocument({ documentName }) {
      state.docNames.push(documentName);
      return buildYDoc(seedDoc());
    },
  });

  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    if (req.url === "/api/auth/login") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (req.url === "/api/auth/collab-token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { token: "collab-jwt" } }));
      return;
    }
    if (req.url === "/api/pages/info") {
      let pageId;
      try {
        pageId = JSON.parse(raw)?.pageId;
      } catch {
        pageId = undefined;
      }
      state.pagesInfoCalls.push(pageId);
      // Always resolve to the SAME canonical record, mirroring the server's
      // findById (which accepts either the uuid or the slugId).
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            id: UUID,
            slugId: SLUG,
            title: "Doc",
            spaceId: "space-1",
            content: seedDoc(),
          },
        }),
      );
      return;
    }
    // Title writes (/pages/update) and anything else: succeed quietly.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: {} }));
  });

  // buildCollabWsUrl maps http://host:port/api -> ws://host:port/collab.
  server.on("upgrade", (request, socket, head) => {
    if (!request.url || !request.url.startsWith("/collab")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      hocuspocus.handleConnection(ws, request);
    });
  });

  const baseURL = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}/api`);
    });
  });

  openStacks.push({ server, hocuspocus });
  return { state, baseURL };
}

const openStacks = [];
after(async () => {
  await Promise.all(
    openStacks.map(
      ({ server, hocuspocus }) =>
        new Promise((resolve) => {
          server.close(() => {
            Promise.resolve(hocuspocus.destroy?.()).finally(resolve);
          });
        }),
    ),
  );
});

test("editPageText with a slugId opens the collab doc by the resolved UUID (#260)", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const res = await client.editPageText(SLUG, [
    { find: "hello", replace: "hi" },
  ]);
  assert.equal(res.success, true);

  assert.ok(
    state.docNames.includes(`page.${UUID}`),
    `collab doc must be opened as page.${UUID}, got ${JSON.stringify(state.docNames)}`,
  );
  assert.ok(
    !state.docNames.includes(`page.${SLUG}`),
    "collab doc must NEVER be opened by the slugId (that is the data-loss bug)",
  );
  // The slugId had to be resolved via /pages/info at least once.
  assert.ok(state.pagesInfoCalls.length >= 1);
});

test("tableInsertRow with a slugId opens the collab doc by the resolved UUID (#260)", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  // No table in the seed doc, so this aborts with "no table found" — but the
  // collab doc has ALREADY been opened (by UUID) before the transform decides.
  await assert.rejects(
    () => client.tableInsertRow(SLUG, "#0", ["a", "b"]),
    /no table/i,
  );

  assert.deepEqual(
    state.docNames,
    [`page.${UUID}`],
    "tableInsertRow must open the collab doc by the resolved UUID",
  );
});

test("the generic mutate (insert_footnote) with a slugId opens by the resolved UUID (#260)", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const res = await client.insertFootnote(SLUG, "world", "a note");
  assert.equal(res.success, true);

  assert.deepEqual(
    state.docNames,
    [`page.${UUID}`],
    "insert_footnote (via the mutatePage seam) must open the collab doc by UUID",
  );
});

test("a UUID input is passed through unchanged and triggers NO /pages/info fetch (short-circuit)", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const res = await client.editPageText(UUID, [
    { find: "hello", replace: "hi" },
  ]);
  assert.equal(res.success, true);

  assert.deepEqual(state.docNames, [`page.${UUID}`]);
  assert.equal(
    state.pagesInfoCalls.length,
    0,
    "a UUID input must short-circuit resolvePageId with no /pages/info round-trip",
  );
});

test("a repeated slugId edit resolves the UUID only once (cache)", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  // Each mock connection re-seeds a fresh "hello world" doc (the mock does not
  // persist across connects), so both edits target "hello". The cache assertion
  // only concerns the slugId->uuid resolution, not the document content.
  await client.editPageText(SLUG, [{ find: "hello", replace: "hi" }]);
  await client.editPageText(SLUG, [{ find: "hello", replace: "hey" }]);

  assert.deepEqual(state.docNames, [`page.${UUID}`, `page.${UUID}`]);
  assert.equal(
    state.pagesInfoCalls.length,
    1,
    "the slugId->uuid resolution must be cached across edits on the same page",
  );
});
