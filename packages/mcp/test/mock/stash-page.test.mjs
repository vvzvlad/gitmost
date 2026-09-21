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

// A signature-valid PNG for the #629 embedded-raster diagram tests.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_RASTER = Buffer.concat([PNG_SIG, Buffer.from([1, 2, 3, 4])]);
// Build a `.drawio.svg` with (optionally) a browser-embedded PNG raster on root.
function drawioSvg({ raster } = {}) {
  const rasterAttr = raster ? ` data-raster="${raster}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${rasterAttr} ` +
    `content="&lt;mxfile/&gt;"><switch><foreignObject>caption</foreignObject>` +
    `<text>trunc</text></switch></svg>`
  );
}
function drawioPageDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "drawio",
        attrs: {
          src: "/api/files/dg-1/diagram.drawio.svg",
          attachmentId: "dg-1",
          title: "My diagram",
          width: 320,
          align: "center",
        },
      },
    ],
  };
}

// An excalidraw SVG (#632) — its captions are REAL <text>, so the SVG is valid
// on its own; optionally carrying a browser-embedded PNG raster on root.
function excalidrawSvg({ raster } = {}) {
  const rasterAttr = raster ? ` data-raster="${raster}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${rasterAttr} ` +
    `width="100" height="80"><text x="0" y="10">real caption</text></svg>`
  );
}
function excalidrawPageDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "excalidraw",
        attrs: {
          src: "/api/files/ex-1/diagram.excalidraw.svg",
          attachmentId: "ex-1",
          title: "My excalidraw",
          width: 240,
          align: "left",
        },
      },
    ],
  };
}

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

test("stashPage reverts an image evicted by the DOC put itself (after-put reconcile, B1)", async () => {
  // Both images (1000 bytes each) survive the image phase: total 2000 <= cap
  // 2500. The doc, however, serializes large (a node with a ~700-byte string
  // attr), so putting it (newest) tips total over the cap and FIFO-evicts the
  // OLDEST image (img0) — an eviction caused by the doc put itself, which only
  // the after-put reconciliation can catch. The loop then reverts img0, drops
  // the stale doc blob, and re-puts the corrected doc (now total = img1 +
  // docSize <= cap, so img1 survives).
  const BIG = Buffer.alloc(1000, 0x41);
  const sandbox = makeSandbox({ maxTotal: 2500 });
  const doc = {
    type: "doc",
    content: [
      { type: "image", attrs: { src: "/api/files/att-0/pic.png", attachmentId: "att-0" } },
      { type: "image", attrs: { src: "/api/files/att-1/pic.png", attachmentId: "att-1" } },
      // Bulk the doc JSON up so the doc put crosses the cap on its own. Stays in
      // the doc across reverts, so each re-serialization is similarly large.
      { type: "paragraph", attrs: { filler: "x".repeat(700) }, content: [] },
    ],
  };
  const client = await buildClient(sandbox, { doc, fileBytes: BIG });

  const result = await client.stashPage("page-1");

  // The doc put evicted exactly one image -> reverted + counted as failed.
  assert.deepEqual(result.images, { mirrored: 1, failed: 1 });

  // Use the LAST json put: the first (stale) doc referenced the now-dead blob
  // and was itself evicted; the corrected re-put is the one that stands.
  const docPut = sandbox.puts.filter((p) => p.mime === "application/json").at(-1);
  const stashed = JSON.parse(docPut.buf.toString("utf8"));
  const imgs = stashed.content.content.filter((n) => n.type === "image");
  let live = 0;
  let reverted = 0;
  for (const img of imgs) {
    const src = img.attrs.src;
    if (src.startsWith("https://sb.test/api/sb/")) {
      assert.ok(sandbox.has(src), `final doc references evicted blob ${src}`);
      live++;
    } else {
      assert.match(src, /^\/api\/files\/att-\d+\/pic\.png$/);
      reverted++;
    }
  }
  assert.equal(live, 1);
  assert.equal(reverted, 1);
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

// --- draw.io diagram rasterization (#629) ----------------------------------

test("stashPage rasterizes a drawio node with a valid embedded raster (#629)", async () => {
  const sandbox = makeSandbox();
  const raster = `data:image/png;base64,${PNG_RASTER.toString("base64")}`;
  const svg = drawioSvg({ raster });
  const client = await buildClient(sandbox, {
    doc: drawioPageDoc(),
    fileBytes: Buffer.from(svg, "utf-8"),
    fileHeaders: { "Content-Type": "image/svg+xml" },
  });

  const result = await client.stashPage("page-1");

  assert.equal(result.diagrams.rasterized, 1);
  assert.equal(result.diagrams.degraded, 0);

  // The sandbox blob for the diagram is a PNG (89 50 4E 47), NOT the SVG.
  const pngPut = sandbox.puts.find((p) => p.mime === "image/png");
  assert.ok(pngPut, "a PNG blob was stored");
  assert.deepEqual([...pngPut.buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  // The SVG itself was never stored.
  assert.ok(!sandbox.puts.some((p) => p.buf.toString("utf8").includes("<svg")));

  // The drawio node became an image node pointing at the sandbox PNG, carrying
  // alt <- title, width and align.
  const docPut = sandbox.puts.find((p) => p.mime === "application/json");
  const stashed = JSON.parse(docPut.buf.toString("utf8"));
  const node = stashed.content.content[0];
  assert.equal(node.type, "image");
  assert.equal(node.attrs.src, pngPut ? `https://sb.test/api/sb/${pngPut.id}` : "");
  assert.equal(node.attrs.alt, "My diagram");
  assert.equal(node.attrs.width, 320);
  assert.equal(node.attrs.align, "center");
});

test("stashPage degrades a non-migrated diagram (no raster) without throwing (#629)", async () => {
  const sandbox = makeSandbox();
  const svg = drawioSvg(); // NO data-raster
  const client = await buildClient(sandbox, {
    doc: drawioPageDoc(),
    fileBytes: Buffer.from(svg, "utf-8"),
    fileHeaders: { "Content-Type": "image/svg+xml" },
  });

  const result = await client.stashPage("page-1");

  assert.equal(result.diagrams.rasterized, 0);
  assert.equal(result.diagrams.degraded, 1);
  // No PNG blob stored; the node stays a drawio node with its ORIGINAL src.
  assert.ok(!sandbox.puts.some((p) => p.mime === "image/png"));
  const docPut = sandbox.puts.find((p) => p.mime === "application/json");
  const node = JSON.parse(docPut.buf.toString("utf8")).content.content[0];
  assert.equal(node.type, "drawio");
  assert.equal(node.attrs.src, "/api/files/dg-1/diagram.drawio.svg");
});

test("stashPage never stores a FAKE (non-PNG) data-raster as image/png (#629)", async () => {
  const sandbox = makeSandbox();
  // A valid data-URI prefix but the bytes are NOT a PNG -> signature check fails.
  const fake = `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`;
  const svg = drawioSvg({ raster: fake });
  const client = await buildClient(sandbox, {
    doc: drawioPageDoc(),
    fileBytes: Buffer.from(svg, "utf-8"),
    fileHeaders: { "Content-Type": "image/svg+xml" },
  });

  const result = await client.stashPage("page-1");

  // Rejected as invalid -> degraded, and NOTHING put as image/png.
  assert.equal(result.diagrams.rasterized, 0);
  assert.equal(result.diagrams.degraded, 1);
  assert.ok(!sandbox.puts.some((p) => p.mime === "image/png"));
  const docPut = sandbox.puts.find((p) => p.mime === "application/json");
  const node = JSON.parse(docPut.buf.toString("utf8")).content.content[0];
  assert.equal(node.type, "drawio");
});

test("stashPage HARD-FAILS if a synthesized diagram raster is FIFO-evicted (#629)", async () => {
  // Two distinct diagrams, each rasterizing to a ~2000-byte PNG. With a tight
  // cap, storing the doc (newest) FIFO-evicts a synthesized raster the doc now
  // references as an image -> a hard failure (throw + clean up), never a silent
  // revert to a broken state.
  const BIG_RASTER = Buffer.concat([PNG_SIG, Buffer.alloc(4000, 0x42)]);
  const raster = `data:image/png;base64,${BIG_RASTER.toString("base64")}`;
  const sandbox = makeSandbox({ maxTotal: 5000 });
  const doc = {
    type: "doc",
    content: [
      { type: "drawio", attrs: { src: "/api/files/dg-0/d.drawio.svg", attachmentId: "dg-0" } },
      { type: "drawio", attrs: { src: "/api/files/dg-1/d.drawio.svg", attachmentId: "dg-1" } },
    ],
  };
  const client = await buildClient(sandbox, {
    doc,
    fileBytes: Buffer.from(drawioSvg({ raster }), "utf-8"),
    fileHeaders: { "Content-Type": "image/svg+xml" },
  });

  await assert.rejects(() => client.stashPage("page-1"), /synthesized diagram raster/);
});

// --- excalidraw diagram rasterization + SVG-mirror degrade (#632) -----------

test("stashPage rasterizes an excalidraw node with a valid embedded raster (#632)", async () => {
  const sandbox = makeSandbox();
  const raster = `data:image/png;base64,${PNG_RASTER.toString("base64")}`;
  const svg = excalidrawSvg({ raster });
  const client = await buildClient(sandbox, {
    doc: excalidrawPageDoc(),
    fileBytes: Buffer.from(svg, "utf-8"),
    fileHeaders: { "Content-Type": "image/svg+xml" },
  });

  const result = await client.stashPage("page-1");

  assert.equal(result.diagrams.rasterized, 1);
  assert.equal(result.diagrams.degraded, 0);

  // The stored diagram blob is the PNG, not the SVG.
  const pngPut = sandbox.puts.find((p) => p.mime === "image/png");
  assert.ok(pngPut, "a PNG blob was stored");
  assert.deepEqual([...pngPut.buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(!sandbox.puts.some((p) => p.mime === "image/svg+xml"));

  // The excalidraw node became an image node pointing at the sandbox PNG.
  const docPut = sandbox.puts.find((p) => p.mime === "application/json");
  const node = JSON.parse(docPut.buf.toString("utf8")).content.content[0];
  assert.equal(node.type, "image");
  assert.equal(node.attrs.src, `https://sb.test/api/sb/${pngPut.id}`);
  assert.equal(node.attrs.alt, "My excalidraw");
  assert.equal(node.attrs.width, 240);
  assert.equal(node.attrs.align, "left");
});

test("stashPage degrades an excalidraw node with NO raster to a MIRRORED SVG image (not dropped, no throw) (#632)", async () => {
  const sandbox = makeSandbox();
  const svg = excalidrawSvg(); // NO data-raster
  const client = await buildClient(sandbox, {
    doc: excalidrawPageDoc(),
    fileBytes: Buffer.from(svg, "utf-8"),
    fileHeaders: { "Content-Type": "image/svg+xml" },
  });

  const result = await client.stashPage("page-1");

  // Counted as degraded (no raster), but NOT dropped and NOT a hard throw.
  assert.equal(result.diagrams.rasterized, 0);
  assert.equal(result.diagrams.degraded, 1);

  // The SVG was mirrored into the sandbox as image/svg+xml; no PNG synthesized.
  const svgPut = sandbox.puts.find((p) => p.mime === "image/svg+xml");
  assert.ok(svgPut, "the excalidraw SVG was mirrored into the sandbox");
  assert.ok(svgPut.buf.toString("utf8").includes("<text"));
  assert.ok(!sandbox.puts.some((p) => p.mime === "image/png"));

  // The excalidraw node became an IMAGE node pointing at the mirrored SVG blob
  // (so habr renders it instead of dropping an unknown excalidraw node).
  const docPut = sandbox.puts.find((p) => p.mime === "application/json");
  const node = JSON.parse(docPut.buf.toString("utf8")).content.content[0];
  assert.equal(node.type, "image");
  assert.equal(node.attrs.src, `https://sb.test/api/sb/${svgPut.id}`);
  assert.equal(node.attrs.alt, "My excalidraw");
});

test("stashPage rejects a FAKE (non-PNG) excalidraw raster and falls to the SVG-image degrade (#632)", async () => {
  const sandbox = makeSandbox();
  // Valid data-URI prefix but non-PNG bytes -> signature check fails.
  const fake = `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`;
  const svg = excalidrawSvg({ raster: fake });
  const client = await buildClient(sandbox, {
    doc: excalidrawPageDoc(),
    fileBytes: Buffer.from(svg, "utf-8"),
    fileHeaders: { "Content-Type": "image/svg+xml" },
  });

  const result = await client.stashPage("page-1");

  // The fake raster is NOT stored as image/png; instead the valid SVG is mirrored.
  assert.equal(result.diagrams.rasterized, 0);
  assert.equal(result.diagrams.degraded, 1);
  assert.ok(!sandbox.puts.some((p) => p.mime === "image/png"));
  assert.ok(sandbox.puts.some((p) => p.mime === "image/svg+xml"));
  const docPut = sandbox.puts.find((p) => p.mime === "application/json");
  const node = JSON.parse(docPut.buf.toString("utf8")).content.content[0];
  assert.equal(node.type, "image");
});

test("stashPage reverts an evicted excalidraw SVG-mirror to an in-place degrade, never a throw (#632)", async () => {
  // A no-raster excalidraw SVG mirror is a SOFT mirror: if its sandbox blob is
  // FIFO-evicted by the doc put, the node reverts to the original excalidraw
  // node (in-place degrade) — NOT the hard failure a synthesized PNG raster
  // triggers. One big SVG (~4000 bytes) + a bulked doc over a tight cap forces
  // the doc put to evict the SVG blob.
  const BIG_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg"><text>` +
    "x".repeat(4000) +
    `</text></svg>`;
  const sandbox = makeSandbox({ maxTotal: 4200 });
  const doc = {
    type: "doc",
    content: [
      {
        type: "excalidraw",
        attrs: { src: "/api/files/ex-9/d.excalidraw.svg", attachmentId: "ex-9", title: "T" },
      },
      // Bulk the doc so its put crosses the cap and evicts the SVG blob.
      { type: "paragraph", attrs: { filler: "y".repeat(600) }, content: [] },
    ],
  };
  const client = await buildClient(sandbox, {
    doc,
    fileBytes: Buffer.from(BIG_SVG, "utf-8"),
    fileHeaders: { "Content-Type": "image/svg+xml" },
  });

  // Must NOT throw (excalidraw SVG mirrors soft-revert).
  const result = await client.stashPage("page-1");
  assert.equal(result.diagrams.degraded, 1);

  // The final stored doc reverted the node back to an excalidraw node with its
  // ORIGINAL src (in-place degrade), referencing no dead sandbox blob.
  const docPut = sandbox.puts.filter((p) => p.mime === "application/json").at(-1);
  const node = JSON.parse(docPut.buf.toString("utf8")).content.content[0];
  assert.equal(node.type, "excalidraw");
  assert.equal(node.attrs.src, "/api/files/ex-9/d.excalidraw.svg");
});
