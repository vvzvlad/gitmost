// Server round-trip test for the stash_page MCP tool result shape. The in-app
// path returns the full documented `{ uri, size, sha256, images }` object, but
// the MCP transport must deliver the SAME shape: a resource_link (primary
// payload) PLUS a `structuredContent` mirror carrying sha256 + image counts.
// This connects a real MCP Client to the server over a linked in-memory
// transport pair and asserts both halves of the result, end to end.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { createDocmostMcpServer } from "../../build/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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

const openServers = [];
async function spawn(handler) {
  const { server, baseURL } = await startServer(handler);
  openServers.push(server);
  return baseURL;
}
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

// Minimal in-memory sandbox sink: store the blob and return a uri + sha256 +
// size, with has/evict probes the client's reconciliation may call.
function makeSandbox() {
  const live = new Map();
  const idOf = (uri) => uri.substring(uri.lastIndexOf("/") + 1);
  let n = 0;
  return {
    put(buf) {
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const id = `id-${n++}`;
      live.set(id, buf.length);
      return { uri: `https://sb.test/api/sb/${id}`, sha256, size: buf.length };
    },
    has(uri) {
      return live.has(idOf(uri));
    },
    evict(uri) {
      live.delete(idOf(uri));
    },
  };
}

const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

// One internal image (so images.mirrored === 1) inside a normal page doc.
function pageDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "image",
        attrs: { src: "/api/files/att-1/pic.png", attachmentId: "att-1" },
      },
    ],
  };
}

// Mock Docmost: login, page info, internal file bytes — same pattern as
// stash-page.test.mjs.
async function buildBaseURL() {
  return spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "authToken=tok; HttpOnly",
      });
      res.end(JSON.stringify({ token: "tok" }));
      return;
    }
    if (req.url === "/api/pages/info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ data: { id: "page-1", title: "T", content: pageDoc() } }),
      );
      return;
    }
    if (req.url.startsWith("/api/files/")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(IMAGE_BYTES);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test("stash_page MCP tool returns a resource_link AND a structuredContent mirror", async () => {
  const baseURL = await buildBaseURL();
  const sandbox = makeSandbox();
  const server = createDocmostMcpServer({
    apiUrl: baseURL,
    email: "u@example.com",
    password: "pw",
    sandbox,
  });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);

  try {
    const res = await client.callTool({
      name: "stash_page",
      arguments: { pageId: "page-1" },
    });

    // Primary payload: a resource_link pointing at the sandbox doc blob.
    const link = res.content[0];
    assert.equal(link.type, "resource_link");
    assert.match(link.uri, /^https:\/\/sb\.test\/api\/sb\//);

    // structuredContent mirrors the full documented shape.
    const sc = res.structuredContent;
    assert.equal(typeof sc, "object");
    assert.equal(sc.uri, link.uri); // same blob as the link
    assert.match(sc.sha256, /^[0-9a-f]{64}$/); // 64-hex ETag
    assert.equal(typeof sc.size, "number");
    assert.deepEqual(sc.images, { mirrored: 1, failed: 0 });

    // Deep-equal the whole structured payload against what the mock implies.
    assert.deepEqual(sc, {
      uri: link.uri,
      sha256: sc.sha256,
      size: sc.size,
      images: { mirrored: 1, failed: 0 },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
