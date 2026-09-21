// Unit coverage for MediaMixin.uploadFile (issue #608) — the byte-fed upload
// primitive. The network (uploadAttachmentBuffer), the page-id resolution
// (resolvePageId) and the insert (insertNode) are all STUBBED on the instance,
// so these tests exercise ONLY uploadFile's own logic: base64 normalization,
// the size ceiling, mime/extension derivation, image-vs-attachment node choice,
// the resolve-before-upload ordering, insert delegation + failure handling, and
// anchor validation happening BEFORE the upload.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DocmostClient } from "../../build/client.js";

// A tiny VALID base64 string (4 chars -> 3 bytes) whose bytes are irrelevant:
// the served type comes from the file-name extension, never the content.
const B64 = "AAAA";

// Build a client whose auth/resolve/upload/insert seams are stubbed. `log`
// records the ordered sequence of stubbed calls so tests can assert ordering
// (resolvePageId MUST run before the upload). `uploadReturn` / `insertImpl`
// let each test shape the server/insert behaviour.
function makeClient({
  resolveTo = "page-uuid",
  uploadReturn = { id: "att-1", fileName: "server.bin", fileSize: 3 },
  insertImpl,
} = {}) {
  const client = new DocmostClient({
    apiUrl: "http://localhost/api",
    getToken: async () => "tok",
  });
  const log = [];
  const calls = { upload: [], insert: [] };

  client.ensureAuthenticated = async () => {
    log.push("auth");
  };
  client.resolvePageId = async (pageId) => {
    log.push("resolve:" + pageId);
    return resolveTo;
  };
  client.uploadAttachmentBuffer = async (pageId, buffer, fileName, mime) => {
    log.push("upload");
    calls.upload.push({ pageId, buffer, fileName, mime });
    return uploadReturn;
  };
  client.insertNode = async (pageId, input, opts) => {
    log.push("insert");
    calls.insert.push({ pageId, input, opts });
    if (insertImpl) return insertImpl(pageId, input, opts);
    return { success: true, inserted: true, position: opts.position, verify: { changed: true } };
  };

  return { client, log, calls };
}

// ---------------------------------------------------------------------------
// base64 normalization
// ---------------------------------------------------------------------------

test("valid base64, insert:false -> uploads, returns image node + src", async () => {
  const { client, calls } = makeClient({
    uploadReturn: { id: "id9", fileName: "x.png", fileSize: 3 },
  });
  const r = await client.uploadFile("p1", B64, "x.png");
  assert.equal(r.uploaded, true);
  assert.equal(r.inserted, false);
  assert.equal(r.attachmentId, "id9");
  assert.equal(r.mime, "image/png");
  assert.equal(r.src, "/api/files/id9/x.png");
  assert.equal(r.node.type, "image");
  assert.equal(r.node.attrs.attachmentId, "id9");
  // Server was called exactly once, with the resolved UUID + decoded bytes.
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].pageId, "page-uuid");
  assert.equal(calls.upload[0].buffer.length, 3);
});

test("data:<mime>;base64, prefix is stripped and the mime hint is captured", async () => {
  // No extension on the name and no opts.mime -> the mime hint drives the
  // canonical-extension append, and the served type is derived from it.
  const { client, calls } = makeClient({
    uploadReturn: { id: "id1", fileName: "pic.png", fileSize: 3 },
  });
  const r = await client.uploadFile("p1", "data:image/png;base64," + B64, "pic");
  assert.equal(r.mime, "image/png");
  assert.equal(r.node.type, "image");
  // The mime hint appended ".png" to the extension-less name before upload.
  assert.equal(calls.upload[0].fileName, "pic.png");
});

test("data:<mediatype>;<param>;base64, (media-type parameters) is accepted; bare media type is the hint", async () => {
  // A valid data URI may carry parameters (e.g. ;charset=utf-8) before ;base64.
  // It must NOT be rejected, and only the bare media type is captured as the hint.
  const { client, calls } = makeClient({
    uploadReturn: { id: "id2", fileName: "note.txt", fileSize: 5 },
  });
  const HELLO = Buffer.from("hello").toString("base64"); // aGVsbG8=
  const r = await client.uploadFile(
    "p1",
    "data:text/plain;charset=utf-8;base64," + HELLO,
    "note",
  );
  // The hint is the bare media type (params dropped) -> canonical ".txt" appended.
  assert.equal(calls.upload[0].fileName, "note.txt");
  assert.equal(r.node.type, "attachment");
  assert.equal(calls.upload.length, 1);
});

test("data: URI without ;base64 is REJECTED, server not called", async () => {
  const { client, calls } = makeClient();
  await assert.rejects(
    () => client.uploadFile("p1", "data:image/png,rawbytes", "x.png"),
    /not base64-encoded/,
  );
  assert.equal(calls.upload.length, 0);
});

test("invalid base64 charset is rejected, server not called", async () => {
  const { client, calls } = makeClient();
  await assert.rejects(
    () => client.uploadFile("p1", "not*valid*base64!", "x.png"),
    /not valid base64/,
  );
  assert.equal(calls.upload.length, 0);
});

test("4-aligned invalid-charset base64 is rejected by the CHARSET guard (not the length guard)", async () => {
  // "ab!c" is length 4 (passes the mult-of-4 guard) but "!" is outside the
  // base64 alphabet. Without the charset guard, Node would silently truncate at
  // the bad char and upload garbage bytes. Assert the CHARSET-specific message so
  // this test genuinely locks the charset guard (mutating it to `if(false)` reds
  // this) rather than falling through to the length guard.
  const { client, calls } = makeClient();
  await assert.rejects(
    () => client.uploadFile("p1", "ab!c", "x.png"),
    /unexpected characters/,
  );
  assert.equal(calls.upload.length, 0);
});

test("base64 whose length is not a multiple of 4 is rejected", async () => {
  const { client, calls } = makeClient();
  await assert.rejects(
    () => client.uploadFile("p1", "AAA", "x.png"), // 3 chars, misaligned
    /multiple of 4/,
  );
  assert.equal(calls.upload.length, 0);
});

test("empty / whitespace-only content is rejected with an 'empty' error", async () => {
  const { client, calls } = makeClient();
  await assert.rejects(
    () => client.uploadFile("p1", "   \n  ", "x.png"),
    /empty/,
  );
  assert.equal(calls.upload.length, 0);
});

test("line-wrapped base64 (whitespace stripped before charset check) is accepted", async () => {
  const { client, calls } = makeClient();
  // Whitespace inside the payload must NOT fail the charset check.
  await client.uploadFile("p1", "AA\nAA", "x.png");
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].buffer.length, 3);
});

// ---------------------------------------------------------------------------
// size limit
// ---------------------------------------------------------------------------

test("over-limit buffer -> error naming HTTP_JSON_BODY_LIMIT, server NOT called", async () => {
  const { client, calls } = makeClient();
  const prev = process.env.MCP_MAX_UPLOAD_BYTES;
  process.env.MCP_MAX_UPLOAD_BYTES = "2"; // 2-byte ceiling; our payload is 3 bytes
  try {
    await assert.rejects(
      () => client.uploadFile("p1", B64, "x.png"),
      (e) => /HTTP_JSON_BODY_LIMIT/.test(e.message) && /1\.333/.test(e.message),
    );
  } finally {
    if (prev === undefined) delete process.env.MCP_MAX_UPLOAD_BYTES;
    else process.env.MCP_MAX_UPLOAD_BYTES = prev;
  }
  assert.equal(calls.upload.length, 0);
});

test("a non-positive MCP_MAX_UPLOAD_BYTES cannot DISABLE the limit (keeps default)", async () => {
  // Non-vacuity: with the limit disabled a huge buffer would upload; assert the
  // default still applies (0 is ignored). Build a >18 MiB payload of 'A's.
  const { client, calls } = makeClient();
  const prev = process.env.MCP_MAX_UPLOAD_BYTES;
  process.env.MCP_MAX_UPLOAD_BYTES = "0";
  // 19 MiB of base64 'A' chars decodes to ~14 MiB... make it clearly over 18 MiB
  // of DECODED bytes: 26 MiB of base64 -> ~19.5 MiB decoded.
  const big = "A".repeat(26 * 1024 * 1024);
  try {
    await assert.rejects(
      () => client.uploadFile("p1", big, "x.bin"),
      /HTTP_JSON_BODY_LIMIT/,
    );
  } finally {
    if (prev === undefined) delete process.env.MCP_MAX_UPLOAD_BYTES;
    else process.env.MCP_MAX_UPLOAD_BYTES = prev;
  }
  assert.equal(calls.upload.length, 0);
});

// ---------------------------------------------------------------------------
// mime / extension derivation
// ---------------------------------------------------------------------------

test("mime is derived from the file-name extension (server parity)", async () => {
  const { client, calls } = makeClient({
    uploadReturn: { id: "id2", fileName: "doc.pdf", fileSize: 3 },
  });
  const r = await client.uploadFile("p1", B64, "doc.pdf");
  assert.equal(r.mime, "application/pdf");
  // Effective mime is passed to the multipart upload too.
  assert.equal(calls.upload[0].mime, "application/pdf");
});

test("a desired mime's canonical extension is APPENDED when the name lacks it", async () => {
  const { client, calls } = makeClient({
    uploadReturn: { id: "id3", fileName: "report.pdf", fileSize: 3 },
  });
  const r = await client.uploadFile("p1", B64, "report", { mime: "application/pdf" });
  // "report" -> "report.pdf" before upload; effective mime derived from ext.
  assert.equal(calls.upload[0].fileName, "report.pdf");
  assert.equal(r.mime, "application/pdf");
});

test("unknown extension + no mime falls back to application/octet-stream", async () => {
  const { client } = makeClient({
    uploadReturn: { id: "id4", fileName: "blob.xyzzy", fileSize: 3 },
  });
  const r = await client.uploadFile("p1", B64, "blob.xyzzy");
  assert.equal(r.mime, "application/octet-stream");
  assert.equal(r.node.type, "attachment");
});

test("path separators in fileName are stripped to a basename", async () => {
  const { client, calls } = makeClient({
    uploadReturn: { id: "id5", fileName: "x.png", fileSize: 3 },
  });
  await client.uploadFile("p1", B64, "/etc/../secret/x.png");
  assert.equal(calls.upload[0].fileName, "x.png");
});

// ---------------------------------------------------------------------------
// image-vs-attachment node choice
// ---------------------------------------------------------------------------

test("PDF -> attachment node with the exact attrs shape", async () => {
  const { client } = makeClient({
    uploadReturn: { id: "att7", fileName: "d.pdf", fileSize: 42 },
  });
  const r = await client.uploadFile("p1", B64, "d.pdf");
  assert.equal(r.node.type, "attachment");
  assert.deepEqual(r.node.attrs, {
    url: "/api/files/att7/d.pdf",
    name: "d.pdf",
    mime: "application/pdf",
    size: 42,
    attachmentId: "att7",
  });
});

test("`as:'file'` forces an attachment node even for an image mime", async () => {
  const { client } = makeClient({
    uploadReturn: { id: "att8", fileName: "x.png", fileSize: 3 },
  });
  const r = await client.uploadFile("p1", B64, "x.png", { as: "file" });
  assert.equal(r.node.type, "attachment");
  assert.equal(r.node.attrs.mime, "image/png");
});

test("src + node use the SERVER-returned fileName, not the raw input", async () => {
  // The server may rename (dedup); the node/src must follow the server name so
  // the /files/:id/:fileName route resolves.
  const { client } = makeClient({
    uploadReturn: { id: "att9", fileName: "renamed-by-server.png", fileSize: 3 },
  });
  const r = await client.uploadFile("p1", B64, "original.png");
  assert.equal(r.src, "/api/files/att9/renamed-by-server.png");
  assert.equal(r.node.attrs.src, "/api/files/att9/renamed-by-server.png");
});

// ---------------------------------------------------------------------------
// ordering: resolvePageId BEFORE upload
// ---------------------------------------------------------------------------

test("resolvePageId runs BEFORE the upload, and the resolved UUID is uploaded", async () => {
  const { client, log, calls } = makeClient({ resolveTo: "canonical-uuid" });
  await client.uploadFile("some-slug-id", B64, "x.png");
  // Ordering: auth -> resolve -> upload.
  assert.deepEqual(log.slice(0, 3), ["auth", "resolve:some-slug-id", "upload"]);
  // The UPLOAD used the resolved UUID, never the raw slug (orphan avoidance).
  assert.equal(calls.upload[0].pageId, "canonical-uuid");
});

// ---------------------------------------------------------------------------
// insert delegation
// ---------------------------------------------------------------------------

test("insert:true success -> inserted:true + placement mapped from insertNode.position", async () => {
  const { client, calls } = makeClient({
    insertImpl: (_p, _i, opts) => ({ inserted: true, position: opts.position, verify: { changed: true } }),
  });
  const r = await client.uploadFile("p1", B64, "x.png", {
    insert: true,
    position: "after",
    anchorText: "Intro",
  });
  assert.equal(r.inserted, true);
  assert.equal(r.placement, "after"); // insertNode returns `position`; mapped -> placement
  assert.deepEqual(r.verify, { changed: true });
  // insertNode was called with the resolved UUID and the node.
  assert.equal(calls.insert[0].pageId, "page-uuid");
  assert.ok(calls.insert[0].input.node);
});

test("insert failure -> inserted:false + insertError, upload PRESERVED", async () => {
  const { client } = makeClient({
    insertImpl: () => {
      throw new Error("anchor not found");
    },
  });
  const r = await client.uploadFile("p1", B64, "x.png", {
    insert: true,
    position: "after",
    anchorText: "missing",
  });
  assert.equal(r.inserted, false);
  assert.match(r.insertError, /anchor not found/);
  // The upload result is NOT lost.
  assert.equal(r.attachmentId, "att-1");
  assert.ok(r.src);
  assert.ok(r.node);
});

// ---------------------------------------------------------------------------
// anchor validation BEFORE upload
// ---------------------------------------------------------------------------

test("insert before/after with NO anchor -> error BEFORE upload", async () => {
  const { client, calls } = makeClient();
  await assert.rejects(
    () => client.uploadFile("p1", B64, "x.png", { insert: true, position: "after" }),
    /exactly one of anchorText or anchorNodeId/,
  );
  // Nothing was uploaded (validation happens before the network).
  assert.equal(calls.upload.length, 0);
});

test("insert before/after with BOTH anchors -> error BEFORE upload", async () => {
  const { client, calls } = makeClient();
  await assert.rejects(
    () =>
      client.uploadFile("p1", B64, "x.png", {
        insert: true,
        position: "before",
        anchorText: "a",
        anchorNodeId: "b",
      }),
    /exactly one of anchorText or anchorNodeId/,
  );
  assert.equal(calls.upload.length, 0);
});

test("append position needs no anchor and inserts fine", async () => {
  const { client, calls } = makeClient();
  const r = await client.uploadFile("p1", B64, "x.png", { insert: true });
  assert.equal(r.inserted, true);
  assert.equal(r.placement, "append");
  assert.equal(calls.insert[0].opts.position, "append");
});
