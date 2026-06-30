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
// Import the SAME page-lock module instance that build/client.js imports. ESM
// caches modules by resolved URL, so this `withPageLock` shares the very
// per-page mutex map (`chains`) the client uses — letting the replaceImage test
// probe which key the operation actually locks on (see that test for details).
import { withPageLock } from "../../build/lib/page-lock.js";

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

// Same shape as seedDoc but with one image node carrying attachmentId "att-old"
// (mirrors what client.addImage emits). replaceImage scans the live doc for this
// node, so it must survive the Yjs round-trip with attachmentId intact.
function seedDocWithImage() {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [{ type: "text", text: "hello world" }],
      },
      {
        type: "image",
        attrs: {
          src: "/api/files/att-old/old.png",
          attachmentId: "att-old",
          size: 10,
          align: "center",
          width: null,
        },
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
// opts.seed: a function returning the ProseMirror doc the collab server loads
// (defaults to seedDoc). opts.onUpload: an optional async hook invoked when
// /files/upload is hit, letting a test GATE the upload (hold replaceImage inside
// its page lock). Existing callers pass no opts and are unaffected.
async function spawnCollabStack(opts = {}) {
  const seed = opts.seed ?? seedDoc;
  const state = { docNames: [], pagesInfoCalls: [] };

  const hocuspocus = new Hocuspocus({
    quiet: true,
    async onLoadDocument({ documentName }) {
      state.docNames.push(documentName);
      return buildYDoc(seed());
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
    if (req.url && req.url.endsWith(".png")) {
      // Serve image bytes for fetchRemoteImage (replaceImage downloads the new
      // image before uploading it). Any non-empty image/* body is enough;
      // fetchRemoteImage does not validate PNG magic bytes.
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }
    if (req.url === "/api/files/upload") {
      // Optional gate: a test can hold replaceImage parked here (inside its page
      // lock, after the scan) to probe the lock key. Default: respond at once.
      if (opts.onUpload) await opts.onUpload();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: { id: "att-new", fileName: "replacement.png", fileSize: 8 },
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

// PR#265 reviewer finding F1. replaceImage is the one path where the resolved
// UUID gates BOTH (a) the collab-doc OPEN (mutateLiveContentUnlocked ->
// page.<uuid>) AND (b) the per-page mutex key withPageLock(uuid). The lock
// serializes the whole scan -> upload -> write against other writes to the same
// page (which now also lock by the resolved UUID), closing a TOCTOU/orphan-
// attachment window. A regression that re-keys this lock by the raw slugId would
// desync it from mutatePageContent's UUID key and silently reopen that window.
// This test pins both invariants and FAILS under either regression:
//   - open by slugId  -> assertion (a) sees page.<slug> in docNames;
//   - lock by slugId   -> assertion (b)'s UUID-keyed probe is no longer blocked.
test("replaceImage opens by the resolved UUID AND keys its page lock by that UUID, not the slugId (#260 / PR#265 F1)", async () => {
  // A gate that holds the /files/upload response open, so replaceImage parks
  // INSIDE its page lock (after the read-only scan, mid-upload) until released.
  let releaseUpload;
  const uploadReleased = new Promise((r) => (releaseUpload = r));
  let uploadHit;
  const uploadStarted = new Promise((r) => (uploadHit = r));

  const { state, baseURL } = await spawnCollabStack({
    seed: seedDocWithImage,
    onUpload: async () => {
      uploadHit(); // replaceImage is now holding its page lock...
      await uploadReleased; // ...and stays parked until the test releases it.
    },
  });
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  // Kick off the replace but DO NOT await: it resolves SLUG->UUID, takes
  // withPageLock(UUID), scan-opens page.<UUID>, finds the seeded "att-old"
  // image, then blocks in uploadImage on our gate while still holding the lock.
  // The image URL is served as image/png by the mock (the ".png" route above).
  const imageUrl = `${baseURL}/x.png`;
  const replacePromise = client.replaceImage(SLUG, "att-old", imageUrl);

  await uploadStarted; // deterministic: replaceImage now holds its page lock.

  // (a) OPEN BY UUID: the only collab doc opened so far (the scan pass) used the
  // canonical UUID, never the slugId. (The write pass opens a second time after
  // we release the gate; asserted at the end.)
  assert.deepEqual(
    state.docNames,
    [`page.${UUID}`],
    "replaceImage must scan-open the collab doc by the resolved UUID, never the slugId",
  );

  // (b) LOCK KEY == UUID (the distinct invariant). We share the SAME page-lock
  // module instance as build/client.js, so enqueuing on key=UUID contends on the
  // very chain replaceImage holds. Because replaceImage is deterministically
  // parked mid-upload (still holding the lock), a UUID-keyed probe MUST stay
  // queued; it cannot run until the lock frees. The contention here is pure
  // in-memory promise-chain microtask scheduling (no timers, no socket I/O), so
  // a single macrotask flush is a sufficient and deterministic observation.
  // If replaceImage were reverted to lock by the slugId, the UUID chain would be
  // free and this probe would run during the flush -> probeRan === true -> FAIL.
  let probeRan = false;
  const probeDone = withPageLock(UUID, async () => {
    probeRan = true;
  });
  // setImmediate runs after the microtask queue fully drains, so a probe on a
  // FREE chain would already have run by the time this resolves.
  await new Promise((r) => setImmediate(r));
  assert.equal(
    probeRan,
    false,
    "a probe on key=UUID must stay blocked while replaceImage holds the lock; " +
      "if it ran, replaceImage locked by a different key (e.g. the raw slugId)",
  );

  // Non-vacuity guard: a probe on an UNRELATED key DOES run after the same
  // single flush. This proves the flush actually executes queued callbacks, so
  // probeRan === false above means "blocked", not "the flush never ran anyone".
  let freeRan = false;
  const freeDone = withPageLock(`page.free-${UUID}`, async () => {
    freeRan = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(
    freeRan,
    true,
    "sanity: a probe on a FREE key must run after one flush (the UUID probe was blocked by the held key, not by an inert flush)",
  );

  // Release the gate; replaceImage finishes and the queued UUID probe can run.
  releaseUpload();
  const res = await replacePromise;
  await probeDone;
  await freeDone;

  assert.equal(res.success, true);
  assert.equal(res.replaced, 1, "the one seeded image must be repointed");
  // Both opens (scan pass + write pass) used the UUID; the slugId never appears.
  assert.deepEqual(state.docNames, [`page.${UUID}`, `page.${UUID}`]);
  assert.ok(
    !state.docNames.includes(`page.${SLUG}`),
    "replaceImage must NEVER open the collab doc by the slugId (the #260 bug)",
  );
});
