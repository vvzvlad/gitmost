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
// stashed (and verify the doc body never leaves via the return value). Models
// the real store's FIFO eviction + cap + the has/evict probes so B1 (self-
// eviction reconciliation and doc-put-throw cleanup) is testable. Default
// maxTotal is effectively unlimited so the happy-path tests behave as before.
//
// `throwOnJson` forces the final document put to throw, standing in for "doc
// exceeds the cap".
function makeSandbox({ maxTotal = Infinity, throwOnJson = false } = {}) {
  const puts = [];
  const evicted = [];
  // id -> size, in insertion order (Map preserves it) so the oldest is first.
  const live = new Map();
  let total = 0;
  const idOf = (uri) => uri.substring(uri.lastIndexOf("/") + 1);
  return {
    puts,
    evicted,
    put(buf, mime) {
      if (throwOnJson && mime === "application/json") {
        throw new Error("doc blob exceeds the sandbox cap");
      }
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const id = `id-${puts.length}`;
      puts.push({ buf, mime, sha256, id });
      live.set(id, buf.length);
      total += buf.length;
      // FIFO-evict the oldest live blobs until this put fits under the cap.
      while (total > maxTotal && live.size > 0) {
        const oldest = live.keys().next().value;
        if (oldest === id) break; // never evict the blob we just stored
        total -= live.get(oldest);
        live.delete(oldest);
        evicted.push(oldest);
      }
      return { uri: `https://sb.test/api/sb/${id}`, sha256, size: buf.length };
    },
    has(uri) {
      return live.has(idOf(uri));
    },
    evict(uri) {
      const id = idOf(uri);
      if (live.has(id)) {
        total -= live.get(id);
        live.delete(id);
      }
      evicted.push(id);
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
// internal file bytes. `fileStatus` lets a test force the file fetch to fail;
// `doc` overrides the served page; `fileBytes`/`fileHeaders` shape the file
// response (used by the empty-body / missing-Content-Type branch tests).
async function buildClient(
  sandbox,
  {
    fileStatus = 200,
    doc = pageDoc(),
    fileBytes = IMAGE_BYTES,
    fileHeaders = { "Content-Type": "image/png" },
  } = {},
) {
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
      res.end(JSON.stringify({ data: { id: "page-1", title: "T", content: doc } }));
      return;
    }
    if (req.url.startsWith("/api/files/")) {
      if (fileStatus !== 200) {
        res.writeHead(fileStatus);
        res.end();
        return;
      }
      res.writeHead(200, fileHeaders);
      res.end(fileBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new DocmostClient({
    apiUrl: baseURL,
    email: "u@example.com",
    password: "pw",
    sandbox: {
      put: (buf, mime) => sandbox.put(buf, mime),
      has: (uri) => sandbox.has(uri),
      evict: (uri) => sandbox.evict(uri),
    },
  });
}

// A page with several DISTINCT internal images (each a unique attachment id) so
// each is its own sandbox blob — needed to exercise FIFO self-eviction.
function multiImageDoc(n) {
  return {
    type: "doc",
    content: Array.from({ length: n }, (_, i) => ({
      type: "image",
      attrs: { src: `/api/files/att-${i}/pic.png`, attachmentId: `att-${i}` },
    })),
  };
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

test("stashPage reverts a FIFO-evicted image and counts it as failed (B1)", async () => {
  // 3 distinct images of S=4000 bytes each; doc JSON is far smaller than one
  // image. With a cap of 4500: storing img1 evicts img0, storing img2 evicts
  // img1 — so only img2 survives the loop (img0 + img1 reverted). The doc
  // (4000 + a few hundred bytes <= 4500) then fits alongside the survivor, so it
  // does NOT trigger further eviction. The stored doc must therefore reference
  // exactly one live blob and revert the other two to their internal srcs.
  const BIG = Buffer.alloc(4000, 0x41);
  const sandbox = makeSandbox({ maxTotal: 4500 });
  const client = await buildClient(sandbox, {
    doc: multiImageDoc(3),
    fileBytes: BIG,
  });

  const result = await client.stashPage("page-1");

  // Two images were evicted before the doc was stored -> counted as failed.
  assert.deepEqual(result.images, { mirrored: 1, failed: 2 });

  // Inspect the stashed doc: no node may point at an evicted (now-dead) blob,
  // and every reverted node carries its ORIGINAL internal src again.
  const docPut = sandbox.puts.find((p) => p.mime === "application/json");
  const stashed = JSON.parse(docPut.buf.toString("utf8"));
  const imgs = stashed.content.content.filter((n) => n.type === "image");
  let live = 0;
  let reverted = 0;
  for (const img of imgs) {
    const src = img.attrs.src;
    if (src.startsWith("https://sb.test/api/sb/")) {
      assert.ok(sandbox.has(src), `doc references evicted blob ${src}`);
      live++;
    } else {
      // Reverted to the original internal src.
      assert.match(src, /^\/api\/files\/att-\d+\/pic\.png$/);
      reverted++;
    }
  }
  assert.equal(live, 1);
  assert.equal(reverted, 2);
});

test("stashPage frees image blobs when the doc put throws (B1)", async () => {
  // Two distinct images mirror fine; the final JSON doc put throws (doc exceeds
  // cap). stashPage must reject AND evict every image blob it stored this op.
  const sandbox = makeSandbox({ throwOnJson: true });
  const client = await buildClient(sandbox, { doc: multiImageDoc(2) });

  await assert.rejects(() => client.stashPage("page-1"));

  // Both image blobs were stored, then evicted on the doc-put failure.
  const imagePuts = sandbox.puts.filter((p) => p.mime === "image/png");
  assert.equal(imagePuts.length, 2);
  for (const p of imagePuts) {
    assert.ok(sandbox.evicted.includes(p.id), `image ${p.id} was not freed`);
  }
});

test("stashPage counts an empty file response as failed (B1/fetchInternalFile)", async () => {
  const sandbox = makeSandbox();
  const client = await buildClient(sandbox, {
    fileBytes: Buffer.alloc(0),
    fileHeaders: { "Content-Type": "image/png", "Content-Length": "0" },
  });

  const result = await client.stashPage("page-1");

  // The single internal image (deduped) yielded an empty body -> failed.
  assert.deepEqual(result.images, { mirrored: 0, failed: 1 });
  // Only the doc blob was stored.
  assert.equal(sandbox.puts.filter((p) => p.mime === "image/png").length, 0);
});

test("stashPage mirrors a file with no Content-Type as octet-stream (fetchInternalFile)", async () => {
  const sandbox = makeSandbox();
  // No Content-Type header at all -> fetchInternalFile defaults to octet-stream.
  const client = await buildClient(sandbox, { fileHeaders: {} });

  const result = await client.stashPage("page-1");

  assert.equal(result.images.mirrored, 1);
  const imagePut = sandbox.puts.find((p) => p.mime !== "application/json");
  assert.ok(imagePut, "expected an image put");
  assert.equal(imagePut.mime, "application/octet-stream");
});
