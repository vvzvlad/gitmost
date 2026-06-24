// Mock-HTTP test for the footnoteWarnings plumbing (#166). createPage is the
// representative path that is fully plain-HTTP (import + getPage) and so is
// mockable here; updatePage / importPageMarkdown attach footnoteWarnings with the
// IDENTICAL wiring (`analyzeFootnotes(...)` + spread-when-non-empty) but run their
// mutation over the Hocuspocus collab WebSocket, which this plain-HTTP harness
// does not stand up. The analyzer itself is unit-tested in footnote-analyze.test.
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

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(obj));
}

const openServers = [];
function spawn(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    openServers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}/api`);
    });
  });
}

after(async () => {
  await Promise.all(
    openServers.map((s) => new Promise((r) => s.close(r))),
  );
});

// A handler that imports a page, lets getPage read it back, and 404s everything
// else (listSidebarPages fails gracefully inside getPage).
function pageHandler() {
  return async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/import") {
      sendJson(res, 200, { data: { id: "new-1" } });
      return;
    }
    if (req.url === "/api/pages/update") {
      // The title-restore step after import.
      sendJson(res, 200, { data: { id: "new-1" } });
      return;
    }
    if (req.url === "/api/pages/info") {
      sendJson(res, 200, {
        data: {
          id: "new-1",
          slugId: "slug-1",
          title: "T",
          spaceId: "sp-1",
          content: { type: "doc", content: [] },
        },
      });
      return;
    }
    sendJson(res, 404, { message: "not found" });
  };
}

test("createPage attaches footnoteWarnings when the content has footnote problems", async () => {
  const baseURL = await spawn(pageHandler());
  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  // A dangling reference + a duplicate definition + a table marker.
  const content = [
    "Intro[^missing] and| cell[^t] |.",
    "",
    "[^d]: one",
    "[^d]: two",
    "[^t]: in table",
  ].join("\n");
  const result = await client.createPage("T", content, "sp-1");
  assert.ok(Array.isArray(result.footnoteWarnings), "footnoteWarnings present");
  const joined = result.footnoteWarnings.join("\n");
  assert.match(joined, /no matching definition/); // dangling [^missing]
  assert.match(joined, /defined more than once/); // duplicate [^d]
  // The page itself is still returned.
  assert.equal(result.success, true);
});

test("createPage omits footnoteWarnings when the content is clean", async () => {
  const baseURL = await spawn(pageHandler());
  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  const content = ["A[^a] and reuse[^a].", "", "[^a]: fine"].join("\n");
  const result = await client.createPage("T", content, "sp-1");
  assert.equal(
    "footnoteWarnings" in result,
    false,
    "no footnoteWarnings field on clean input",
  );
  assert.equal(result.success, true);
});
