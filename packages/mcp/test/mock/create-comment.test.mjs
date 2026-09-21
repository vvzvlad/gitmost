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
    // #437: a parentCommentId must be a full canonical UUID.
    "019f499a-9f8c-7d68-b7be-ce100d7c6c56",
  );

  assert.equal(result.success, true, "a reply must resolve successfully");
  assert.ok(createPayload, "/comments/create must have been called");
  assert.equal(
    createPayload.parentCommentId,
    // #437: a parentCommentId must be a full canonical UUID.
    "019f499a-9f8c-7d68-b7be-ce100d7c6c56",
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

// -----------------------------------------------------------------------------
// 4) suggestedText + a DUPLICATE selection is refused BEFORE creating anything:
//    a suggestion must anchor to a unique location, so >=2 occurrences throws the
//    ambiguity error (the /pages/info pre-check short-circuits before create).
// -----------------------------------------------------------------------------
test("suggestedText with an ambiguous selection is refused before creating", async () => {
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
      // "target" appears in two blocks -> ambiguous for a suggestion.
      sendJson(res, 200, {
        data: {
          id: "page-1",
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "first target here" }] },
              { type: "paragraph", content: [{ type: "text", text: "second target here" }] },
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
        "target",
        undefined,
        "TARGET",
      ),
    /ambiguous/i,
    "an ambiguous suggestion selection must reject with the ambiguity error",
  );
  assert.ok(infoCalls >= 1, "the pre-check must read the page via /pages/info");
  assert.equal(
    createCalls,
    0,
    "/comments/create must NEVER be called for an ambiguous suggestion",
  );
});

// -----------------------------------------------------------------------------
// 5) suggestedText on a reply is refused immediately (before any HTTP).
// -----------------------------------------------------------------------------
test("suggestedText on a reply is rejected", async () => {
  let anyCall = 0;
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    anyCall++;
    sendJson(res, 200, { data: { id: "x" } });
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  await assert.rejects(
    () =>
      client.createComment(
        "page-1",
        "body",
        "inline",
        undefined,
        // #437: use a valid full UUID so the reply+suggestion rejection fires
        // (not the id-shape guard).
        "019f499a-9f8c-7d68-b7be-ce100d7c6c56",
        "replacement",
      ),
    /reply/i,
    "suggestedText on a reply must be rejected",
  );
  assert.equal(anyCall, 0, "no create/info call for a rejected reply suggestion");
});

// -----------------------------------------------------------------------------
// 6) suggestedText without a selection is refused immediately.
// -----------------------------------------------------------------------------
test("suggestedText without a selection is rejected", async () => {
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    sendJson(res, 200, { data: { id: "x" } });
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  await assert.rejects(
    () =>
      client.createComment(
        "page-1",
        "body",
        "inline",
        undefined,
        undefined,
        "replacement",
      ),
    /selection/i,
    "suggestedText without a selection must be rejected",
  );
});

// -----------------------------------------------------------------------------
// 7) suggestedText + a UNIQUE selection succeeds: the pre-check passes, the
//    create payload carries suggestedText, and the live anchoring step (stubbed
//    via the mutatePage seam) writes the comment mark exactly once.
// -----------------------------------------------------------------------------
test("suggestedText with a unique selection succeeds and forwards the payload", async () => {
  let createPayload = null;

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/info") {
      // "brave" is unique in the page.
      sendJson(res, 200, {
        data: {
          id: "11111111-1111-1111-1111-111111111111",
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Hello brave world" }] },
            ],
          },
        },
      });
      return;
    }
    if (req.url === "/api/comments/create") {
      createPayload = JSON.parse(raw);
      sendJson(res, 200, {
        data: {
          id: "cmt-ok-1",
          content: createPayload.content,
          selection: createPayload.selection,
          suggestedText: createPayload.suggestedText,
          type: createPayload.type,
        },
      });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });

  // Subclass to stub the collab write seam: no live Hocuspocus socket, but the
  // wrapper's uniqueness gate + applyAnchorInDoc still run against `doc`.
  class TestClient extends DocmostClient {
    async getCollabTokenWithReauth() {
      return "collab-token";
    }
    async resolvePageId(pageId) {
      return "11111111-1111-1111-1111-111111111111";
    }
    async mutatePage(pageId, collabToken, apiUrl, transform) {
      const doc = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello brave world" }] },
        ],
      };
      const out = transform(doc);
      return { doc: out, verify: { ok: true } };
    }
  }

  const client = new TestClient(baseURL, "user@example.com", "pw");

  const result = await client.createComment(
    "11111111-1111-1111-1111-111111111111",
    "please rename",
    "inline",
    "brave",
    undefined,
    "bold",
  );

  assert.equal(result.success, true, "a unique suggestion must resolve");
  assert.equal(result.anchored, true, "the comment must be anchored");
  assert.ok(createPayload, "/comments/create must have been called");
  assert.equal(
    createPayload.suggestedText,
    "bold",
    "the create payload must carry suggestedText for a top-level inline comment",
  );
  assert.equal(createPayload.selection, "brave");
  assert.equal(result.data.suggestedText, "bold", "filterComment surfaces suggestedText");
});

// -----------------------------------------------------------------------------
// 8) suggestedText where the DOC has TYPOGRAPHIC text and the agent selection is
//    ASCII: the stored selection sent to /comments/create MUST be the doc's RAW
//    typographic substring (what the mark covers), NOT the agent's ASCII input.
//    This is the F1 contract that makes "Apply" succeed instead of a spurious
//    409 (apply compares the stored selection to the marked doc text strictly).
// -----------------------------------------------------------------------------
test("suggestedText: the stored selection is the doc's RAW typographic substring, not the ASCII input", async () => {
  let createPayload = null;

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/info") {
      // The doc holds SMART quotes; the agent will select the ASCII form.
      sendJson(res, 200, {
        data: {
          id: "22222222-2222-2222-2222-222222222222",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "he said “hello” loudly" }],
              },
            ],
          },
        },
      });
      return;
    }
    if (req.url === "/api/comments/create") {
      createPayload = JSON.parse(raw);
      sendJson(res, 200, {
        data: {
          id: "cmt-typo-1",
          content: createPayload.content,
          selection: createPayload.selection,
          suggestedText: createPayload.suggestedText,
          type: createPayload.type,
        },
      });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });

  class TestClient extends DocmostClient {
    async getCollabTokenWithReauth() {
      return "collab-token";
    }
    async resolvePageId() {
      return "22222222-2222-2222-2222-222222222222";
    }
    async mutatePage(pageId, collabToken, apiUrl, transform) {
      const doc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "he said “hello” loudly" }],
          },
        ],
      };
      const out = transform(doc);
      return { doc: out, verify: { ok: true } };
    }
  }

  const client = new TestClient(baseURL, "user@example.com", "pw");

  const result = await client.createComment(
    "22222222-2222-2222-2222-222222222222",
    "please change",
    "inline",
    '"hello"', // ASCII quotes — the doc has smart quotes
    undefined,
    "goodbye",
  );

  assert.equal(result.success, true);
  assert.equal(result.anchored, true);
  assert.ok(createPayload, "/comments/create must have been called");
  assert.equal(
    createPayload.selection,
    "“hello”",
    "the stored selection must be the doc's RAW typographic substring, not the ASCII input",
  );
  assert.equal(createPayload.suggestedText, "goodbye");
});

// -----------------------------------------------------------------------------
// 8b) #496: the DEBOUNCED REST snapshot (pages/info) DIFFERS from the LIVE collab
//     doc (mutatePage) — the doc moved on in the debounce window. The stored
//     selection is captured from the snapshot at create time, but the mark is set
//     in the live doc, so apply would 409 forever. After anchoring, the client
//     re-reads the RAW substring under the mark from the LIVE doc and POSTs it to
//     /comments/resync-suggestion-anchor so the stored expectedText matches.
// -----------------------------------------------------------------------------
test("suggestion: re-syncs the stored selection to the LIVE doc substring when the REST snapshot lagged", async () => {
  let createPayload = null;
  let resyncPayload = null;

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/info") {
      // DEBOUNCED snapshot: ASCII quotes (stale — the live doc has since been
      // typographically corrected).
      sendJson(res, 200, {
        data: {
          id: "33333333-3333-3333-3333-333333333333",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: 'he said "hello" loudly' }],
              },
            ],
          },
        },
      });
      return;
    }
    if (req.url === "/api/comments/create") {
      createPayload = JSON.parse(raw);
      sendJson(res, 200, {
        data: {
          id: "cmt-resync-1",
          content: createPayload.content,
          selection: createPayload.selection,
          suggestedText: createPayload.suggestedText,
          type: createPayload.type,
        },
      });
      return;
    }
    if (req.url === "/api/comments/resync-suggestion-anchor") {
      resyncPayload = JSON.parse(raw);
      sendJson(res, 200, { data: { id: "cmt-resync-1" } });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });

  class TestClient extends DocmostClient {
    async getCollabTokenWithReauth() {
      return "collab-token";
    }
    async resolvePageId() {
      return "33333333-3333-3333-3333-333333333333";
    }
    async mutatePage(pageId, collabToken, apiUrl, transform) {
      // LIVE doc: SMART quotes (what the mark is actually set over).
      const doc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "he said “hello” loudly" }],
          },
        ],
      };
      const out = transform(doc);
      return { doc: out, verify: { ok: true } };
    }
  }

  const client = new TestClient(baseURL, "user@example.com", "pw");

  const result = await client.createComment(
    "33333333-3333-3333-3333-333333333333",
    "please change",
    "inline",
    '"hello"', // ASCII quotes
    undefined,
    "goodbye",
  );

  assert.equal(result.success, true);
  assert.equal(result.anchored, true);
  // Create stored the STALE snapshot substring (ASCII quotes).
  assert.equal(createPayload.selection, '"hello"');
  // …then the client re-synced to the LIVE marked substring (smart quotes).
  assert.ok(resyncPayload, "/comments/resync-suggestion-anchor must be called");
  assert.equal(resyncPayload.commentId, "cmt-resync-1");
  assert.equal(resyncPayload.selection, "“hello”");
  // The returned comment reflects the corrected anchor.
  assert.equal(result.data.selection, "“hello”");
});

// -----------------------------------------------------------------------------
// 8c) #496: when the REST snapshot and the LIVE doc AGREE, no resync round-trip
//     is made (the common case must stay a single write).
// -----------------------------------------------------------------------------
test("suggestion: no resync call when the snapshot already matches the live doc", async () => {
  let resyncCalls = 0;

  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/info") {
      sendJson(res, 200, {
        data: {
          id: "44444444-4444-4444-4444-444444444444",
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Hello brave world" }] },
            ],
          },
        },
      });
      return;
    }
    if (req.url === "/api/comments/create") {
      const p = JSON.parse(raw);
      sendJson(res, 200, {
        data: { id: "cmt-nosync-1", content: p.content, selection: p.selection, suggestedText: p.suggestedText, type: p.type },
      });
      return;
    }
    if (req.url === "/api/comments/resync-suggestion-anchor") {
      resyncCalls++;
      sendJson(res, 200, { data: {} });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });

  class TestClient extends DocmostClient {
    async getCollabTokenWithReauth() {
      return "collab-token";
    }
    async resolvePageId() {
      return "44444444-4444-4444-4444-444444444444";
    }
    async mutatePage(pageId, collabToken, apiUrl, transform) {
      const doc = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello brave world" }] },
        ],
      };
      const out = transform(doc);
      return { doc: out, verify: { ok: true } };
    }
  }

  const client = new TestClient(baseURL, "user@example.com", "pw");
  const result = await client.createComment(
    "44444444-4444-4444-4444-444444444444",
    "rename",
    "inline",
    "brave",
    undefined,
    "bold",
  );

  assert.equal(result.anchored, true);
  assert.equal(resyncCalls, 0, "matching snapshot must NOT trigger a resync round-trip");
});

// -----------------------------------------------------------------------------
// 8) #408: a not-found selection error QUOTES the closest block text so the
//    model can self-correct instead of blind-retrying.
// -----------------------------------------------------------------------------
test("a not-found selection error includes a 'Closest block text' hint", async () => {
  let createCalls = 0;
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/info") {
      sendJson(res, 200, {
        data: {
          id: "page-1",
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "The quick brown fox jumps" }] },
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
    () => client.createComment("page-1", "body", "inline", "quick brown cat"),
    /Closest block text: "The quick brown fox jumps"/,
    "a not-found selection must quote the closest block text",
  );
  assert.equal(createCalls, 0, "/comments/create must NOT be called on a miss");
});

// -----------------------------------------------------------------------------
// 9) #408: a selection that straddles two blocks gets the explicit
//    "spans multiple blocks" message instead of a bare not-found.
// -----------------------------------------------------------------------------
test("a selection spanning multiple blocks gets the explicit spans-multiple-blocks message", async () => {
  let createCalls = 0;
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/info") {
      sendJson(res, 200, {
        data: {
          id: "page-1",
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "the quick brown" }] },
              { type: "paragraph", content: [{ type: "text", text: "fox jumps over" }] },
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
    () => client.createComment("page-1", "body", "inline", "brown fox"),
    /spans multiple blocks/,
    "a cross-block selection must report the spans-multiple-blocks hint",
  );
  assert.equal(createCalls, 0, "/comments/create must NOT be called on a miss");
});
