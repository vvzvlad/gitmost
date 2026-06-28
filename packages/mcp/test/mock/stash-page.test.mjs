// Mock-HTTP test for DocmostClient.stashPage: a local http server stands in for
// Docmost so the whole flow stays deterministic and offline. Asserts the tool
// (1) serializes the page into the sandbox and returns ONLY a link (uri + sha256
// + size), never the body; (2) mirrors INTERNAL image srcs into the sandbox and
// rewrites them to the sandbox uri; (3) leaves EXTERNAL http(s) srcs untouched;
// (4) de-duplicates a repeated internal src to a single blob; (5) counts a
// failed image fetch without aborting the document.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
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

const openServers = [];
async function spawn(handler) {
  const { server, baseURL } = await startServer(handler);
  openServers.push(server);
  return baseURL;
}
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

// In-memory sandbox sink mirroring the host binding: store the blob, return a
// uri + sha256 + size. Records every put so the test can inspect what was
// stashed (and verify the doc body never leaves via the return value).
function makeSandbox() {
  const puts = [];
  return {
    puts,
    put(buf, mime) {
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const id = `id-${puts.length}`;
      puts.push({ buf, mime, sha256 });
      return { uri: `https://sb.test/api/sb/${id}`, sha256, size: buf.length };
    },
  };
}

const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // "PNG" header-ish

function pageDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "image",
        attrs: { src: "/api/files/att-1/pic.png", attachmentId: "att-1", width: 100 },
      },
      // Same internal src again -> must dedup to ONE blob, both rewritten.
      {
        type: "image",
        attrs: { src: "/api/files/att-1/pic.png", attachmentId: "att-1", width: 50 },
      },
      // External CDN image -> must be left untouched.
      {
        type: "image",
        attrs: { src: "https://cdn.example.com/remote.png" },
      },
    ],
  };
}

// Build a client wired to a server that logs in, serves the page, and serves the
// internal file bytes. `fileStatus` lets a test force the file fetch to fail.
async function buildClient(sandbox, { fileStatus = 200 } = {}) {
  const baseURL = await spawn(async (req, res) => {
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
      res.end(JSON.stringify({ data: { id: "page-1", title: "T", content: pageDoc() } }));
      return;
    }
    if (req.url.startsWith("/api/files/att-1/")) {
      if (fileStatus !== 200) {
        res.writeHead(fileStatus);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(IMAGE_BYTES);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new DocmostClient({
    apiUrl: baseURL,
    email: "u@example.com",
    password: "pw",
    sandbox: { put: (buf, mime) => sandbox.put(buf, mime) },
  });
}

test("stashPage stores the doc + mirrors/rewrites internal images, returns only a link", async () => {
  const sandbox = makeSandbox();
  const client = await buildClient(sandbox);

  const result = await client.stashPage("page-1");

  // Returns ONLY a link shape — never the document body.
  assert.equal(typeof result.uri, "string");
  assert.match(result.uri, /^https:\/\/sb\.test\/api\/sb\//);
  assert.equal(typeof result.sha256, "string");
  assert.equal(typeof result.size, "number");
  assert.ok(!("doc" in result) && !("content" in result) && !("body" in result));
  assert.deepEqual(result.images, { mirrored: 1, failed: 0 });

  // One image blob (dedup) + one doc blob = 2 puts.
  assert.equal(sandbox.puts.length, 2);
  const imagePut = sandbox.puts[0];
  const docPut = sandbox.puts[1];
  assert.equal(imagePut.mime, "image/png");
  assert.ok(imagePut.buf.equals(IMAGE_BYTES));
  assert.equal(docPut.mime, "application/json");

  // The returned uri/sha256 are the DOCUMENT blob's.
  assert.equal(result.sha256, docPut.sha256);

  // Inspect the stashed document: internal srcs rewritten, external untouched.
  const stashed = JSON.parse(docPut.buf.toString("utf8"));
  const imgs = stashed.content.content.filter((n) => n.type === "image");
  assert.equal(imgs[0].attrs.src, "https://sb.test/api/sb/id-0");
  assert.equal(imgs[1].attrs.src, "https://sb.test/api/sb/id-0"); // same blob (dedup)
  assert.equal(imgs[2].attrs.src, "https://cdn.example.com/remote.png"); // external kept
});

test("stashPage counts a failed image fetch without aborting the document", async () => {
  const sandbox = makeSandbox();
  const client = await buildClient(sandbox, { fileStatus: 500 });

  const result = await client.stashPage("page-1");

  assert.deepEqual(result.images, { mirrored: 0, failed: 1 });
  // Only the doc blob was stored (image fetch failed).
  assert.equal(sandbox.puts.length, 1);
  assert.equal(sandbox.puts[0].mime, "application/json");

  // The failed internal src is LEFT as-is so nothing is silently dropped.
  const stashed = JSON.parse(sandbox.puts[0].buf.toString("utf8"));
  const imgs = stashed.content.content.filter((n) => n.type === "image");
  assert.equal(imgs[0].attrs.src, "/api/files/att-1/pic.png");
});

test("stashPage throws a clear error when no sandbox is configured", async () => {
  const baseURL = await spawn(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({}));
  });
  const client = new DocmostClient({
    apiUrl: baseURL,
    email: "u@example.com",
    password: "pw",
  });
  await assert.rejects(() => client.stashPage("page-1"), /not configured/);
});
