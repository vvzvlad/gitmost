// #647 §G/§H — the migrated full-overwrite tools (updatePageJson /
// updatePageMarkdown) go through the SERVER-side write-CAS over REST
// (/pages/update replace+baseHash), NOT the old collab seam. A mock HTTP server
// asserts: baseHash is mandatory when writing content; the guarded POST carries
// operation:'replace' + baseHash; a 409 maps to a typed ConflictError carrying
// currentHash; and getPageJson/getPage surface baseHash from /pages/info.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocmostClient } from "../../build/client.js";
import { ConflictError } from "../../build/client/conflict-error.js";

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
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
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

const UUID = "11111111-1111-4111-8111-111111111111";

// Mock server: auth + /pages/info (returns content + contentHash) + /pages/update
// whose behaviour is driven by `opts.updateStatus` (200 applied, or 409 conflict).
function makeServer(opts = {}) {
  const state = { updates: [], infoCalls: 0 };
  const handler = async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/auth/login") {
      return sendJson(res, 200, { success: true }, { "Set-Cookie": "authToken=t; Path=/; HttpOnly" });
    }
    if (req.url === "/api/pages/info") {
      state.infoCalls++;
      // #647 review — simulate the live-content fetch failing (500) or coming
      // back with NO usable content, to exercise the fail-closed regraft guard.
      if (opts.infoStatus) {
        return sendJson(res, opts.infoStatus, { message: "info boom" });
      }
      return sendJson(res, 200, {
        data: {
          id: UUID,
          slugId: "page-1",
          title: "T",
          content: opts.infoContent === undefined
            ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "live" }] }] }
            : opts.infoContent,
          contentHash: opts.serverHash ?? "server-hash-abc",
          updatedAt: "2020-01-01T00:00:00.000Z",
          spaceId: "space-1",
        },
      });
    }
    if (req.url === "/api/pages/update") {
      state.updates.push(body);
      if (opts.updateStatus === 409) {
        return sendJson(res, 409, { message: "changed", currentHash: opts.currentHash ?? "current-xyz" });
      }
      return sendJson(res, 200, { data: { id: UUID, contentHash: "new-hash-999" } });
    }
    // sidebar pages (getPage subpages fetch) → empty
    if (req.url === "/api/pages/sidebar-pages" || req.url === "/api/pages/recent") {
      return sendJson(res, 200, { data: { items: [] } });
    }
    return sendJson(res, 404, { message: "not found" });
  };
  return { state, handler };
}

test("updatePageJson REFUSES to write content without baseHash", async () => {
  const { handler } = makeServer();
  const client = new DocmostClient(await spawn(handler), "u@e.com", "pw");
  const doc = { type: "doc", content: [{ type: "paragraph" }] };
  await assert.rejects(
    () => client.updatePageJson("page-1", doc),
    /baseHash is required/,
  );
});

test("updatePageJson with baseHash POSTs a guarded replace and succeeds", async () => {
  const { state, handler } = makeServer();
  const client = new DocmostClient(await spawn(handler), "u@e.com", "pw");
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }] };
  const res = await client.updatePageJson("page-1", doc, undefined, "base-777");
  assert.equal(res.success, true);
  const upd = state.updates.find((u) => u.operation === "replace");
  assert.ok(upd, "a replace was POSTed to /pages/update");
  assert.equal(upd.operation, "replace");
  assert.equal(upd.format, "json");
  assert.equal(upd.baseHash, "base-777");
  assert.equal(upd.pageId, UUID, "pageId resolved to the canonical UUID");
});

test("updatePageJson maps a 409 to a typed ConflictError carrying currentHash", async () => {
  const { handler } = makeServer({ updateStatus: 409, currentHash: "H-current" });
  const client = new DocmostClient(await spawn(handler), "u@e.com", "pw");
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] };
  const err = await client.updatePageJson("page-1", doc, undefined, "stale-base").catch((e) => e);
  assert.ok(err instanceof ConflictError, "throws ConflictError");
  assert.equal(err.currentHash, "H-current");
});

test("updatePageMarkdown REFUSES to write without baseHash", async () => {
  const { handler } = makeServer();
  const client = new DocmostClient(await spawn(handler), "u@e.com", "pw");
  await assert.rejects(
    () => client.updatePage("page-1", "# hi\n\nbody"),
    /baseHash is required/,
  );
});

test("updatePageMarkdown with baseHash imports + guarded-replaces (format json)", async () => {
  const { state, handler } = makeServer();
  const client = new DocmostClient(await spawn(handler), "u@e.com", "pw");
  const res = await client.updatePage("page-1", "# Title\n\nHello world", undefined, "base-md");
  assert.equal(res.success, true);
  const upd = state.updates.find((u) => u.operation === "replace");
  assert.ok(upd, "a replace was POSTed");
  assert.equal(upd.format, "json", "markdown is imported client-side and sent as json");
  assert.equal(upd.baseHash, "base-md", "the AGENT's baseHash drives the CAS, not the info-fetch hash");
  assert.ok(state.infoCalls >= 1, "fetched live content for resolved-comment regraft");
});

test("updatePageMarkdown FAILS CLOSED (no write) when the live-content fetch errors", async () => {
  // The regraft needs the live doc to recover hidden resolved-comment anchors
  // (#337); if that fetch fails we must NOT write a body missing them.
  const { state, handler } = makeServer({ infoStatus: 500 });
  const client = new DocmostClient(await spawn(handler), "u@e.com", "pw");
  // Pass the canonical UUID so resolvePageId short-circuits (no network) and the
  // regraft's live-content fetch is the ONLY /pages/info call — i.e. the 500 hits
  // exactly the fail-closed guard under test, not id resolution.
  await assert.rejects(
    () => client.updatePage(UUID, "# Title\n\nHello world", undefined, "base-md"),
    /live content|No write was attempted/,
  );
  assert.equal(
    state.updates.length,
    0,
    "no guarded replace (PUT) is attempted when the live fetch fails",
  );
});

test("updatePageMarkdown FAILS CLOSED (no write) when the live fetch returns no usable content", async () => {
  const { state, handler } = makeServer({ infoContent: null });
  const client = new DocmostClient(await spawn(handler), "u@e.com", "pw");
  await assert.rejects(
    () => client.updatePage(UUID, "# Title\n\nHello world", undefined, "base-md"),
    /no usable content|No write was attempted/,
  );
  assert.equal(
    state.updates.length,
    0,
    "no guarded replace (PUT) is attempted when the live content is missing",
  );
});

test("updatePageMarkdown still WRITES when the live fetch returns an empty (but present) doc", async () => {
  // A legitimately-empty live doc is present content (no resolved comments to
  // lose) — the regraft is a no-op and the guarded write proceeds as normal.
  const { state, handler } = makeServer({ infoContent: { type: "doc", content: [] } });
  const client = new DocmostClient(await spawn(handler), "u@e.com", "pw");
  const res = await client.updatePage(UUID, "# Title\n\nHello world", undefined, "base-md");
  assert.equal(res.success, true);
  assert.ok(state.updates.find((u) => u.operation === "replace"), "a replace was POSTed");
});

test("getPageJson returns baseHash from /pages/info contentHash", async () => {
  const { handler } = makeServer({ serverHash: "hash-from-info" });
  const client = new DocmostClient(await spawn(handler), "u@e.com", "pw");
  const out = await client.getPageJson("page-1");
  assert.equal(out.baseHash, "hash-from-info");
});
