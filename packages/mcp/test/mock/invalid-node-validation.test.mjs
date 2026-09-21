// Mock regression for the FAIL-FAST invalid-node validation (#409).
//
// A structural editor (patchNode / insertNode / updatePageJson) given a doc
// whose NESTED child has an absent/unknown `type` (the exact shape the Yjs
// encoder rejects with `Unknown node type: undefined`) must throw a RICH,
// path-anchored error BEFORE it ever opens a collab session or takes a page
// lock. We prove the fail-fast by standing up a collab stack whose HTTP handler
// records EVERY request: a correct fail-fast never even fetches the collab
// token (which `getCollabTokenWithReauth`, called AFTER the validation, would
// request), and never drives a document change on the Hocuspocus doc.
//
// The happy path (a well-formed doc) is exercised too: it must reach the collab
// write and succeed, so the gate is not over-eager.
//
// findInvalidNode's per-shape summaries are unit-tested in the package
// (test/find-invalid-node.test.ts); this exercises the END-TO-END wiring through
// the real client methods.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Hocuspocus } from "@hocuspocus/server";
import { DocmostClient } from "../../build/client.js";
import { buildYDoc } from "../../build/lib/collaboration.js";

// A minimal valid seed doc with a real block id, so the happy-path patchNode
// finds its target.
const SEED_ID = "seed-para-id";
function seedDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: SEED_ID },
        content: [{ type: "text", text: "seed" }],
      },
    ],
  };
}

// Stand up an HTTP server that authenticates + hands out a collab token AND
// upgrades /collab to a Hocuspocus instance seeded with the doc. `state` records
// whether the collab token was ever fetched (proving the write path was entered)
// and whether the Hocuspocus doc ever changed.
async function spawnCollabStack() {
  const state = { changed: false, collabTokenFetched: false };

  const hocuspocus = new Hocuspocus({
    quiet: true,
    async onLoadDocument() {
      return buildYDoc(seedDoc());
    },
    async onChange() {
      state.changed = true;
    },
  });

  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/api/auth/login") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "authToken=t; Path=/; HttpOnly",
        });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (req.url === "/api/auth/collab-token") {
        state.collabTokenFetched = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { token: "collab-jwt" } }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
  });

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

const PAGE = "11111111-1111-4111-8111-111111111111";

// A node whose NESTED text leaf is missing "type":"text" (dominant #409 shape).
const nestedTypelessNode = () => ({
  type: "paragraph",
  content: [{ text: "oops", marks: [] }],
});

// A node with a NESTED unknown type NAME (typo).
const nestedUnknownTypeNode = () => ({
  type: "paragraph",
  content: [{ type: "paragraf", content: [{ type: "text", text: "x" }] }],
});

test("patchNode fails fast on a nested typeless node — no collab connection", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  await assert.rejects(
    () => client.patchNode(PAGE, SEED_ID, { node: nestedTypelessNode() }),
    (err) => {
      assert.match(err.message, /patchNode: invalid node/);
      assert.match(err.message, /missing "type"/);
      assert.match(err.message, /content\[0\]/); // path-anchored
      return true;
    },
  );

  assert.equal(
    state.collabTokenFetched,
    false,
    "must NOT fetch a collab token — validation runs before getCollabTokenWithReauth",
  );
  assert.equal(state.changed, false, "the collab doc must never be written");
});

test("insertNode fails fast on a nested UNKNOWN type — no collab connection", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  await assert.rejects(
    () =>
      client.insertNode(
        PAGE,
        { node: nestedUnknownTypeNode() },
        {
          position: "append",
        },
      ),
    (err) => {
      assert.match(err.message, /insertNode: invalid node/);
      assert.match(err.message, /unknown node type "paragraf"/);
      return true;
    },
  );

  assert.equal(state.collabTokenFetched, false);
  assert.equal(state.changed, false);
});

test("updatePageJson fails fast on a nested typeless node — no collab connection", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const badDoc = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ text: "oops" }] }],
  };

  await assert.rejects(
    () => client.updatePageJson(PAGE, badDoc),
    (err) => {
      // updatePageJson runs validateDocStructure first (string-type check),
      // which already rejects a typeless node — so the message may come from
      // either guard, but the write must not happen.
      assert.match(err.message, /type/i);
      return true;
    },
  );

  assert.equal(state.collabTokenFetched, false);
  assert.equal(state.changed, false);
});

test("updatePageJson fails fast on a nested UNKNOWN type name — rich #409 message", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  // validateDocStructure passes (type is a string); assertValidNodeShape must
  // catch the unknown schema name and produce the rich path-anchored message.
  const badDoc = {
    type: "doc",
    content: [{ type: "paragraf", content: [{ type: "text", text: "x" }] }],
  };

  await assert.rejects(
    () => client.updatePageJson(PAGE, badDoc),
    (err) => {
      assert.match(err.message, /updatePageJson: invalid node/);
      assert.match(err.message, /unknown node type "paragraf"/);
      return true;
    },
  );

  assert.equal(state.collabTokenFetched, false);
  assert.equal(state.changed, false);
});

test("patchNode with a well-formed node proceeds to the collab write", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  const result = await client.patchNode(PAGE, SEED_ID, {
    node: {
      type: "paragraph",
      content: [{ type: "text", text: "replacement" }],
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.replaced, 1);
  assert.equal(
    state.collabTokenFetched,
    true,
    "a valid node must reach the collab write path",
  );
  assert.equal(state.changed, true, "the collab doc must be written");
});
