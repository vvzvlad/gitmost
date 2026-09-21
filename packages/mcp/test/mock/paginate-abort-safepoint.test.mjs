// #487 commit 1 — the in-app tool cancellation safe-point inside paginateAll.
//
// The in-app tool host sets a composite abort signal on the client
// (setToolAbortSignal) before each tool call; paginateAll checks it at a
// safe-point BEFORE every sequential page fetch, so a Stop that lands mid-read
// stops the NEXT HTTP request from STARTING (a read tool can no longer paginate
// for minutes past a Stop). This pins the HONEST observable property against the
// REAL client + a real HTTP server: "after Stop, no NEW request starts".
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
function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(obj));
}
const openServers = [];
async function spawn(handler) {
  const server = await new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  openServers.push(server);
  const { port } = server.address();
  return { baseURL: `http://127.0.0.1:${port}/api` };
}
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
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

// A Stop that lands DURING pagination: the server aborts the client signal as it
// serves page 1 (more pages remain). The loop's next safe-point must throw before
// the page-2 request is sent.
test("paginateAll stops the NEXT request when the signal aborts mid-pagination", async () => {
  let requests = 0;
  const ac = new AbortController();
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/spaces") {
      requests++;
      // Simulate a user Stop that lands while page 1 is in flight.
      if (requests === 1) ac.abort(new Error("user stop"));
      sendJson(res, 200, {
        success: true,
        data: {
          items: [{ id: `p${requests}` }],
          meta: { hasNextPage: true, nextCursor: `c${requests}` },
        },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  client.setToolAbortSignal(ac.signal);

  await assert.rejects(
    () => client.paginateAll("/spaces", {}),
    /user stop/,
    "the aborted safe-point rejects with the signal's reason",
  );
  assert.equal(requests, 1, "page 2 never started after the Stop");
});

// A Stop that is already in effect before the read starts: zero requests fire.
test("paginateAll starts no request when the signal is already aborted", async () => {
  let requests = 0;
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/spaces") {
      requests++;
      sendJson(res, 200, {
        success: true,
        data: { items: [], meta: { hasNextPage: false, nextCursor: null } },
      });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "user@example.com", "pw");
  // Warm the auth so ensureAuthenticated does not itself POST after the abort.
  await client.ensureAuthenticated();
  const ac = new AbortController();
  ac.abort(new Error("already stopped"));
  client.setToolAbortSignal(ac.signal);

  await assert.rejects(() => client.paginateAll("/spaces", {}), /already stopped/);
  assert.equal(requests, 0, "no /spaces request started once already aborted");
});

// Without a tool signal (default), pagination is unaffected — the safe-point is a
// pure no-op, so pre-#487 behaviour is byte-identical.
test("paginateAll is unaffected when no tool signal is set", async () => {
  let requests = 0;
  const PAGES = {
    "": { items: [{ id: "a" }], nextCursor: "c1" },
    c1: { items: [{ id: "b" }], nextCursor: null },
  };
  const { baseURL } = await spawn(async (req, res) => {
    const raw = await readBody(req);
    if (handleLogin(req, res)) return;
    if (req.url === "/api/spaces") {
      requests++;
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
  const all = await client.paginateAll("/spaces", {});
  assert.equal(requests, 2, "both pages fetched with no signal set");
  assert.deepEqual(all.map((p) => p.id), ["a", "b"]);
});
