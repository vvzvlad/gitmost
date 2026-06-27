// Mock-HTTP orchestration tests for the footnote WRITE wrappers on DocmostClient
// (issue #228):
//  - insertFootnote (#11): the required-argument guards reject BEFORE any write,
//    and never touch the collab/mutate path.
//  - transformPage / docmost_transform (#13): the auto-canonicalize step
//    (`result = canonicalizeFootnotes(raw)`) runs after every transform, so a
//    transform that introduces an orphan footnote definition is silently tidied
//    away — observable as an EMPTY diff in a dryRun preview.
//
// These stand a local http.createServer in for Docmost and only exercise plain
// HTTP routes (login / comments / pages.info), deliberately avoiding the live
// Hocuspocus collab WebSocket: the insertFootnote guards short-circuit before it,
// and docmost_transform's dryRun preview never opens it. The collab mutate path
// itself — abort-via-throw on a missing anchor with NO persisted write, and the
// reused-vs-new response shaping — is covered in
// test/mock/insert-footnote-wrapper.test.mjs (which overrides the mutatePage
// seam to drive the transform), not here.
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
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(obj));
}
const openServers = [];
async function spawn(handler) {
  const { server, baseURL } = await startServer(handler);
  openServers.push(server);
  return { baseURL };
}
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

const ref = (id) => ({ type: "footnoteReference", attrs: { id } });
const def = (id, text) => ({
  type: "footnoteDefinition",
  attrs: { id },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

// ---------------------------------------------------------------------------
// #11 insertFootnote guards: missing anchorText / text reject and never write.
// ---------------------------------------------------------------------------
test("insertFootnote rejects a missing anchorText before any write", async () => {
  const otherRoutes = [];
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      return sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
    }
    otherRoutes.push(req.url);
    sendJson(res, 404, { message: "not found" });
  });
  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  await assert.rejects(
    () => client.insertFootnote("page-1", "   ", "a note"),
    /anchorText is required/i,
  );
  assert.deepEqual(otherRoutes, [], "must not hit any write route");
});

test("insertFootnote rejects an empty text before any write", async () => {
  const otherRoutes = [];
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      return sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
    }
    otherRoutes.push(req.url);
    sendJson(res, 404, { message: "not found" });
  });
  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  await assert.rejects(
    () => client.insertFootnote("page-1", "anchor", "   "),
    /text is required/i,
  );
  assert.deepEqual(otherRoutes, [], "must not hit any write route");
});

// ---------------------------------------------------------------------------
// #13 docmost_transform auto-canonicalization: a transform that adds an orphan
// footnote definition produces NO net change (the canonicalizer drops it), so a
// dryRun preview reports an empty diff. Without the auto-canonicalize step the
// orphan would survive and the diff would be non-empty.
// ---------------------------------------------------------------------------
test("transformPage dryRun auto-canonicalizes footnotes (orphan def is dropped)", async () => {
  // A page already in canonical footnote state (refs b,a; defs b,a).
  const pageContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "x" }, ref("b"), ref("a")] },
      { type: "footnotesList", content: [def("b", "B"), def("a", "A")] },
    ],
  };
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      return sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
    }
    if (req.url === "/api/comments") {
      return sendJson(res, 200, { data: { items: [], meta: { nextCursor: null } } });
    }
    if (req.url === "/api/pages/info") {
      return sendJson(res, 200, {
        data: { id: "page-1", slugId: "s", title: "P", spaceId: "sp", content: pageContent },
      });
    }
    sendJson(res, 404, { message: "not found" });
  });
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  // The transform appends an ORPHAN definition (id "z", no matching reference).
  const transformJs = `(doc) => {
    const list = doc.content.find((n) => n.type === "footnotesList");
    list.content.push({
      type: "footnoteDefinition",
      attrs: { id: "z" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "orphan" }] }],
    });
    return doc;
  }`;

  const result = await client.transformPage("page-1", transformJs, { dryRun: true });
  assert.equal(result.pushed, false);
  // Auto-canonicalize dropped the orphan, so the doc is unchanged => empty diff.
  assert.equal(result.diff.summary.inserted, 0, "orphan def must be canonicalized away");
  assert.equal(result.diff.summary.deleted, 0);
});
