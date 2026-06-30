// Mock collab regression for the AMBIGUOUS-id refusal in patch_node / delete_node
// (#159, PR #185 review pt 1). When a page has TWO blocks sharing one attrs.id
// (Docmost duplicates block ids on copy/paste), the transform's
// `if (replaced !== 1) return null` / `if (deleted !== 1) return null` guard must
// SKIP the collab write, and the call must then reject with an "ambiguous" error.
//
// The replaceNodeById/deleteNodeById counts and assertUnambiguousMatch are unit-
// tested in isolation (test/unit/node-ops.test.mjs); this exercises the END-TO-END
// wiring through the real client method + a live Hocuspocus collab doc, so a
// regression that loosened the guard (e.g. back to `=== 0`) would be caught here
// where the isolated unit tests would not.
//
// Unlike the other mock tests (which deliberately avoid the collab WebSocket), this
// one DOES stand up a real Hocuspocus server seeded with a duplicate-id document,
// so the transform actually runs against a live two-match doc.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Hocuspocus } from "@hocuspocus/server";
import { DocmostClient } from "../../build/client.js";
import { buildYDoc } from "../../build/lib/collaboration.js";

// A document with TWO paragraphs sharing the SAME attrs.id — the duplicate-id
// shape replaceNodeById/deleteNodeById report as `count === 2` (ambiguous).
const DUP_ID = "dup-block-id";
function seedDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: DUP_ID },
        content: [{ type: "text", text: "first copy" }],
      },
      {
        type: "paragraph",
        attrs: { id: DUP_ID },
        content: [{ type: "text", text: "second copy" }],
      },
    ],
  };
}

// Stand up an HTTP server that authenticates + hands out a collab token AND
// upgrades /collab to a Hocuspocus instance seeded with the duplicate-id doc.
// `state.changed` flips true the instant Hocuspocus applies ANY client document
// update — it must stay false, proving the ambiguous write was never sent. (We
// track onChange, which fires synchronously per update, NOT onStoreDocument,
// which is debounced and would not fire before the test tears the server down —
// making a real clobbering write look clean.)
async function spawnCollabStack() {
  const state = { changed: false };

  const hocuspocus = new Hocuspocus({
    quiet: true,
    // Seed every requested document with a fresh duplicate-id Y.Doc, encoded with
    // the SAME docmost extensions the client reads with (so attrs.id round-trips).
    async onLoadDocument() {
      return buildYDoc(seedDoc());
    },
    // Fires immediately on any client-driven document update. A real (clobbering)
    // write would trip this; the ambiguous guard must keep it from firing.
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { token: "collab-jwt" } }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
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

test("patch_node REFUSES an ambiguous (duplicate) id without writing to collab", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  await assert.rejects(
    () =>
      client.patchNode("11111111-1111-4111-8111-111111111111", DUP_ID, {
        type: "paragraph",
        content: [{ type: "text", text: "replacement" }],
      }),
    /ambiguous/i,
    "patch_node must reject a duplicate-id target with an 'ambiguous' error",
  );

  assert.equal(
    state.changed,
    false,
    "the collab document must NEVER be written when the id is ambiguous",
  );
});

test("delete_node REFUSES an ambiguous (duplicate) id without writing to collab", async () => {
  const { state, baseURL } = await spawnCollabStack();
  const client = new DocmostClient(baseURL, "user@example.com", "pw");

  await assert.rejects(
    () => client.deleteNode("22222222-2222-4222-8222-222222222222", DUP_ID),
    /ambiguous/i,
    "delete_node must reject a duplicate-id target with an 'ambiguous' error",
  );

  assert.equal(
    state.changed,
    false,
    "the collab document must NEVER be written when the id is ambiguous",
  );
});
