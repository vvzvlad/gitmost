// Unit coverage for StashMixin.downloadFile (issue #613) — the external-MCP
// primitive that hands an INTERNAL Docmost attachment's bytes back to the agent
// in a caller-chosen shape. The network (fetchInternalFile), the auth
// (ensureAuthenticated), the blob sandbox (sandboxPut) and the metrics sink
// (onMetric) are all STUBBED, so these tests exercise ONLY downloadFile's own
// logic: src form validation (SSRF / SPA-catch-all), the base64 ceiling and its
// clamp, the early-abort fetch bound, the auto branch rule, the sandbox
// per-blob delivery caps, best-effort metadata parsing, and the download-volume
// metric.
//
// Non-vacuity: every rejection test asserts the network stub was NOT called (or,
// for the sandbox caps, that sandboxPut was NOT called) — so a mutation that
// drops the guard reddens instead of silently over-fetching.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DocmostClient } from "../../build/client.js";

// A well-formed internal attachment src. The first path segment MUST be a UUID
// (that is the fileId == attachmentId), the second the file name.
const ID = "11111111-2222-4333-8444-555555555555";
const SRC = `/api/files/${ID}/photo.png`;

const MIB = 1024 * 1024;
const DEFAULT_BASE64_CAP = 1 * MIB; // downloadFile's default base64 ceiling
// The FALLBACK per-blob caps: what downloadFile uses when the host reports no
// caps through the sandbox sink (standalone/stdio). They are the upstream
// defaults of the server's SANDBOX_MAX_BYTES / SANDBOX_MAX_IMAGE_BYTES env vars;
// a host that reports its REAL (possibly operator-raised) caps overrides them —
// see the "host-reported caps" block below.
const DEFAULT_SANDBOX_MAX_BYTES = 8 * MIB; // non-image per-blob cap
const DEFAULT_SANDBOX_MAX_IMAGE_BYTES = 20 * MIB; // image per-blob cap

// Build a client whose auth / loopback fetch / sandbox / metrics seams are
// stubbed. `calls` records every stubbed interaction so tests can assert both
// what happened and what did NOT (the non-vacuity checks).
// `sandboxCaps` (optional) makes the stub sink REPORT its per-blob caps, exactly
// as SandboxStore.asSink() does on the real host.
function makeClient({
  sandbox = true,
  sandboxCaps,
  buffer = Buffer.from("hello bytes"),
  mime = "image/png",
  fetchImpl,
} = {}) {
  const calls = { fetch: [], put: [], metric: [] };
  const config = {
    apiUrl: "http://localhost/api",
    getToken: async () => "tok",
    onMetric: (name, value, labels) => {
      calls.metric.push({ name, value, labels });
    },
  };
  if (sandbox) {
    config.sandbox = {
      put: (buf, m) => {
        calls.put.push({ size: buf.length, mime: m });
        return {
          uri: `http://localhost/api/sandbox/blob-${calls.put.length}`,
          sha256: "a".repeat(64),
          size: buf.length,
        };
      },
      ...(sandboxCaps ?? {}),
    };
  }
  const client = new DocmostClient(config);

  client.ensureAuthenticated = async () => {};
  // The ONLY network seam downloadFile touches. Records the src AND the maxBytes
  // bound it was given (the early-abort contract).
  client.fetchInternalFile = async (src, maxBytes) => {
    calls.fetch.push({ src, maxBytes });
    if (fetchImpl) return fetchImpl(src, maxBytes);
    return { buffer, mime };
  };

  return { client, calls };
}

// ---------------------------------------------------------------------------
// format: 'base64' — bytes round-trip + metadata  (AC #2)
// ---------------------------------------------------------------------------

test("base64: bytes round-trip exactly, with mime/fileName/attachmentId/size", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  const { client, calls } = makeClient({ buffer: bytes, mime: "image/png" });

  const r = await client.downloadFile(SRC, { format: "base64" });

  assert.equal(r.kind, "base64");
  // The decoded payload is byte-identical to what the server served.
  assert.deepEqual(Buffer.from(r.base64, "base64"), bytes);
  assert.equal(r.mime, "image/png");
  assert.equal(r.fileName, "photo.png");
  assert.equal(r.attachmentId, ID);
  assert.equal(r.size, bytes.length);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].src, SRC);
  // base64 never touches the sandbox.
  assert.equal(calls.put.length, 0);
});

test("base64: the bare /files/... form is accepted too", async () => {
  const { client } = makeClient({ buffer: Buffer.from("x") });
  const r = await client.downloadFile(`/files/${ID}/photo.png`, {
    format: "base64",
  });
  assert.equal(r.kind, "base64");
  assert.equal(r.attachmentId, ID);
});

// ---------------------------------------------------------------------------
// format: 'url' — the ANONYMOUS sandbox URL  (AC #3)
// ---------------------------------------------------------------------------

test("url: stashes the bytes into the sandbox and returns the anonymous uri + sha256", async () => {
  const bytes = Buffer.alloc(3 * MIB, 7); // > base64 cap, well under the caps
  const { client, calls } = makeClient({
    buffer: bytes,
    mime: "application/pdf",
  });

  const r = await client.downloadFile(SRC, { format: "url" });

  assert.equal(r.kind, "url");
  assert.match(r.uri, /sandbox\/blob-1$/); // the anonymous URL the sandbox minted
  assert.equal(r.sha256, "a".repeat(64));
  assert.equal(r.mime, "application/pdf");
  assert.equal(r.size, bytes.length);
  assert.equal(r.fileName, "photo.png");
  assert.equal(r.attachmentId, ID);
  // The bytes were handed to the sandbox EXACTLY once, with the served mime.
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].size, bytes.length);
  assert.equal(calls.put[0].mime, "application/pdf");
  // No base64 payload leaks into the result (the whole point of this branch).
  assert.equal(r.base64, undefined);
});

test("url: a SMALL file is still delivered as a url when explicitly asked (format wins over size)", async () => {
  const { client, calls } = makeClient({ buffer: Buffer.from("tiny") });
  const r = await client.downloadFile(SRC, { format: "url" });
  assert.equal(r.kind, "url"); // NOT base64, even though it would fit
  assert.equal(calls.put.length, 1);
});

test("url: without a configured sandbox -> clear 'not configured' error, no null-deref (AC #8)", async () => {
  const { client, calls } = makeClient({ sandbox: false });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "url" }),
    /blob sandbox is not configured/,
  );
  assert.equal(calls.put.length, 0);
});

// ---------------------------------------------------------------------------
// format: 'auto' — the branch rule  (AC #4)
// ---------------------------------------------------------------------------

test("auto: a file under the base64 ceiling -> base64 (default format is auto)", async () => {
  const bytes = Buffer.alloc(512 * 1024, 1); // 512 KiB < 1 MiB cap
  const { client, calls } = makeClient({ buffer: bytes, mime: "image/png" });

  const r = await client.downloadFile(SRC); // no opts at all -> auto
  assert.equal(r.kind, "base64");
  assert.equal(r.size, bytes.length);
  assert.equal(calls.put.length, 0); // sandbox untouched
});

test("auto: a 3 MiB PDF (over the base64 ceiling, under the 8 MiB cap) -> url", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(3 * MIB, 2),
    mime: "application/pdf",
  });
  const r = await client.downloadFile(SRC, { format: "auto" });
  assert.equal(r.kind, "url");
  assert.equal(calls.put.length, 1);
});

test("auto: a 15 MiB IMAGE -> url (the image cap is 20 MiB, not 8 MiB)", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(15 * MIB, 3),
    mime: "image/png",
  });
  const r = await client.downloadFile(SRC, { format: "auto" });
  assert.equal(r.kind, "url");
  assert.equal(calls.put.length, 1);
});

test("auto: a 10 MiB NON-image (over the 8 MiB cap) -> clear 'too large to deliver', sandbox NOT called", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(10 * MIB, 4),
    mime: "application/pdf",
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "auto" }),
    (e) =>
      /too large to deliver/.test(e.message) &&
      // The error names BOTH real bounds so the operator/agent can act on it.
      e.message.includes(String(DEFAULT_BASE64_CAP)) &&
      e.message.includes(String(DEFAULT_SANDBOX_MAX_BYTES)),
  );
  // Non-vacuity: the pre-check rejected BEFORE the sandbox saw the blob, so no
  // raw sandbox error can leak and no 10 MiB blob is stored.
  assert.equal(calls.put.length, 0);
});

test("auto: over the base64 ceiling with NO sandbox -> 'too large' naming the missing sandbox", async () => {
  const { client } = makeClient({
    sandbox: false,
    buffer: Buffer.alloc(2 * MIB, 5),
    mime: "application/pdf",
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "auto" }),
    (e) =>
      /too large to deliver/.test(e.message) &&
      /blob sandbox not configured/.test(e.message),
  );
});

// --- auto: the branch rule AT EQUALITY (the off-by-one boundaries) -----------
// Both comparisons are inclusive-at-the-cap (`<= cap`), so a file EXACTLY at a
// cap is delivered, and cap+1 falls to the next branch. These pin that; a `<`/`<=`
// flip in either comparison reddens exactly one of them.

test("auto: size == base64cap -> base64 (the ceiling is inclusive)", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(DEFAULT_BASE64_CAP, 1),
    mime: "application/pdf",
  });
  const r = await client.downloadFile(SRC, { format: "auto" });
  assert.equal(r.kind, "base64");
  assert.equal(r.size, DEFAULT_BASE64_CAP);
  assert.equal(calls.put.length, 0); // sandbox untouched
});

test("auto: size == base64cap + 1 -> url (one byte over falls to the sandbox)", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(DEFAULT_BASE64_CAP + 1, 1),
    mime: "application/pdf",
  });
  const r = await client.downloadFile(SRC, { format: "auto" });
  assert.equal(r.kind, "url");
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].size, DEFAULT_BASE64_CAP + 1);
});

test("auto: size == sandboxCap -> url (the per-blob cap is inclusive too)", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(DEFAULT_SANDBOX_MAX_BYTES, 1),
    mime: "application/pdf",
  });
  const r = await client.downloadFile(SRC, { format: "auto" });
  assert.equal(r.kind, "url");
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].size, DEFAULT_SANDBOX_MAX_BYTES);
});

test("auto: size == sandboxCap + 1 -> 'too large to deliver', sandbox NOT called", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(DEFAULT_SANDBOX_MAX_BYTES + 1, 1),
    mime: "application/pdf",
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "auto" }),
    /too large to deliver/,
  );
  assert.equal(calls.put.length, 0);
});

test("auto: an IMAGE exactly at the IMAGE cap -> url (mime picks the cap)", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(DEFAULT_SANDBOX_MAX_IMAGE_BYTES, 1),
    mime: "image/png",
  });
  const r = await client.downloadFile(SRC, { format: "auto" });
  assert.equal(r.kind, "url");
  assert.equal(calls.put[0].size, DEFAULT_SANDBOX_MAX_IMAGE_BYTES);
});

// ---------------------------------------------------------------------------
// host-reported caps: downloadFile uses the sink's REAL per-blob caps (#613 F2)
//
// The server's caps are per-deployment env (SANDBOX_MAX_BYTES /
// SANDBOX_MAX_IMAGE_BYTES), NOT source constants — so the package must take them
// from the sink (SandboxStore.asSink() reports them) rather than assume the
// defaults. Otherwise the documented escape hatch ("the operator raises
// SANDBOX_MAX_BYTES") would not work and every error message would quote a wrong
// number. These pin all three consumers: the fetch bound, the pre-check, the text.
// ---------------------------------------------------------------------------

test("a RAISED host cap delivers a file the default 8 MiB cap would have rejected", async () => {
  const bytes = Buffer.alloc(10 * MIB, 4); // > 8 MiB default, < the 32 MiB the host reports
  const { client, calls } = makeClient({
    buffer: bytes,
    mime: "application/pdf",
    sandboxCaps: { maxBytes: 32 * MIB, maxImageBytes: 64 * MIB },
  });
  const r = await client.downloadFile(SRC, { format: "auto" });
  assert.equal(r.kind, "url"); // NOT "too large to deliver"
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].size, bytes.length);
  // The early-abort bound followed the REAL largest cap, not the 20 MiB default —
  // without this the fetch would have aborted at 20 MiB and never delivered.
  assert.equal(calls.fetch[0].maxBytes, 64 * MIB + 1);
});

test("a LOWERED host cap rejects a file the default cap would have delivered, quoting the REAL cap", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(5 * MIB, 4), // under the 8 MiB default, over the host's 2 MiB
    mime: "application/pdf",
    sandboxCaps: { maxBytes: 2 * MIB, maxImageBytes: 4 * MIB },
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "url" }),
    (e) =>
      /deliverable limit/.test(e.message) &&
      // The message quotes the cap the sink will ACTUALLY enforce (2 MiB) and
      // NOT the compile-time default (8 MiB) — the "factual lie" this fixes.
      e.message.includes(String(2 * MIB)) &&
      !e.message.includes(String(DEFAULT_SANDBOX_MAX_BYTES)),
  );
  assert.equal(calls.put.length, 0);
  // The fetch bound tightened to the host's largest cap as well.
  assert.equal(calls.fetch[0].maxBytes, 4 * MIB + 1);
});

test("the abort message quotes the host's absolute maximum, not the default", async () => {
  const { client } = makeClient({
    sandboxCaps: { maxBytes: 32 * MIB, maxImageBytes: 64 * MIB },
    fetchImpl: async () => {
      throw new Error("maxContentLength size of 67108865 exceeded");
    },
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "auto" }),
    (e) =>
      /absolute\s+maximum/.test(e.message) && e.message.includes(String(64 * MIB)),
  );
});

test("a non-image cap LARGER than the image cap still bounds the fetch (Math.max, not 'the image cap')", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.from("ok"),
    sandboxCaps: { maxBytes: 50 * MIB, maxImageBytes: 20 * MIB },
  });
  await client.downloadFile(SRC, { format: "auto" });
  assert.equal(calls.fetch[0].maxBytes, 50 * MIB + 1);
});

test("a garbage host cap (0 / NaN / negative) is IGNORED — the defaults still guard", async () => {
  for (const bad of [0, -1, Number.NaN, "8000000"]) {
    const { client, calls } = makeClient({
      buffer: Buffer.alloc(10 * MIB, 4), // over the 8 MiB DEFAULT non-image cap
      mime: "application/pdf",
      sandboxCaps: { maxBytes: bad, maxImageBytes: bad },
    });
    await assert.rejects(
      () => client.downloadFile(SRC, { format: "auto" }),
      /too large to deliver/,
      `cap ${String(bad)} must not disable the guard`,
    );
    assert.equal(calls.put.length, 0);
    // The fetch bound fell back to the DEFAULT image cap, not to 0/NaN.
    assert.equal(calls.fetch[0].maxBytes, DEFAULT_SANDBOX_MAX_IMAGE_BYTES + 1);
  }
});

// ---------------------------------------------------------------------------
// size ceilings: the base64 cap  (AC #5) and the sandbox delivery cap (AC #4)
// ---------------------------------------------------------------------------

test("base64: over the ceiling -> error that names the bound AND advises url/auto, sandbox untouched", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(2 * MIB, 6), // 2 MiB > the 1 MiB default cap
    mime: "application/pdf",
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "base64" }),
    (e) =>
      /over the base64 ceiling/.test(e.message) &&
      e.message.includes(String(DEFAULT_BASE64_CAP)) &&
      /format:'url'/.test(e.message) &&
      /'auto'/.test(e.message),
  );
  assert.equal(calls.put.length, 0);
});

test("url: a non-image over the 8 MiB sandbox cap -> 'deliverable limit' error, sandboxPut NOT called", async () => {
  const { client, calls } = makeClient({
    buffer: Buffer.alloc(10 * MIB, 7),
    mime: "application/pdf",
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "url" }),
    (e) =>
      /deliverable limit/.test(e.message) &&
      e.message.includes(String(DEFAULT_SANDBOX_MAX_BYTES)) &&
      /non-image/.test(e.message),
  );
  // Non-vacuity: the clear pre-check fired instead of letting the sandbox throw
  // a raw internal error (the whole point of mirroring the cap here).
  assert.equal(calls.put.length, 0);
});

test("maxBase64Bytes raises the ceiling for one call (a file that would otherwise be rejected)", async () => {
  const bytes = Buffer.alloc(2 * MIB, 8);
  const { client } = makeClient({ buffer: bytes, mime: "application/pdf" });
  const r = await client.downloadFile(SRC, {
    format: "base64",
    maxBase64Bytes: 3 * MIB,
  });
  assert.equal(r.kind, "base64");
  assert.equal(r.size, bytes.length);
});

test("maxBase64Bytes is CLAMPED to the context-safe hard ceiling (cannot be raised to 64 MiB)", async () => {
  // 6 MiB is over the 4 MiB hard clamp, so even an explicit 64 MiB override must
  // NOT deliver it as base64 — the clamp, not the caller, decides.
  const { client } = makeClient({
    buffer: Buffer.alloc(6 * MIB, 9),
    mime: "application/pdf",
  });
  await assert.rejects(
    () =>
      client.downloadFile(SRC, {
        format: "base64",
        maxBase64Bytes: 64 * MIB,
      }),
    (e) =>
      /over the base64 ceiling/.test(e.message) &&
      // The effective cap is the 4 MiB clamp, NOT the 64 MiB the caller asked for.
      e.message.includes(String(4 * MIB)),
  );
});

test("MCP_MAX_DOWNLOAD_BASE64_BYTES tunes the ceiling; a non-positive value cannot DISABLE it", async () => {
  const bytes = Buffer.alloc(512 * 1024, 10); // 512 KiB
  const prev = process.env.MCP_MAX_DOWNLOAD_BASE64_BYTES;
  try {
    // (a) A lower env ceiling REJECTS a file the default would have accepted.
    process.env.MCP_MAX_DOWNLOAD_BASE64_BYTES = "1024"; // 1 KiB
    const a = makeClient({ buffer: bytes, mime: "application/pdf" });
    await assert.rejects(
      () => a.client.downloadFile(SRC, { format: "base64" }),
      /over the base64 ceiling of 1024 bytes/,
    );
    // (b) A non-positive value is IGNORED (keeps the 1 MiB default) — it can
    //     never turn the limit off. Non-vacuity: the same 512 KiB file now
    //     succeeds under the default, proving "0" did not become "no limit"
    //     AND did not become "zero bytes allowed".
    process.env.MCP_MAX_DOWNLOAD_BASE64_BYTES = "0";
    const b = makeClient({ buffer: bytes, mime: "application/pdf" });
    const r = await b.client.downloadFile(SRC, { format: "base64" });
    assert.equal(r.kind, "base64");
    // And a file over the DEFAULT is still rejected with "0" set.
    const c = makeClient({ buffer: Buffer.alloc(2 * MIB, 11), mime: "application/pdf" });
    await assert.rejects(
      () => c.client.downloadFile(SRC, { format: "base64" }),
      (e) => e.message.includes(String(DEFAULT_BASE64_CAP)),
    );
  } finally {
    if (prev === undefined) delete process.env.MCP_MAX_DOWNLOAD_BASE64_BYTES;
    else process.env.MCP_MAX_DOWNLOAD_BASE64_BYTES = prev;
  }
});

// ---------------------------------------------------------------------------
// early-abort: the fetch is BOUNDED so an oversize file never buffers 64 MiB
// ---------------------------------------------------------------------------

test("base64 mode bounds the loopback fetch at base64cap+1 (no 64 MiB over-fetch)", async () => {
  const { client, calls } = makeClient({ buffer: Buffer.from("ok") });
  await client.downloadFile(SRC, { format: "base64" });
  assert.equal(calls.fetch[0].maxBytes, DEFAULT_BASE64_CAP + 1);
});

test("base64 mode's fetch bound follows an explicit maxBase64Bytes", async () => {
  const { client, calls } = makeClient({ buffer: Buffer.from("ok") });
  await client.downloadFile(SRC, { format: "base64", maxBase64Bytes: 2048 });
  assert.equal(calls.fetch[0].maxBytes, 2048 + 1);
});

test("url/auto bound the fetch at the largest sandbox cap + 1 (20 MiB image cap)", async () => {
  const a = makeClient({ buffer: Buffer.from("ok") });
  await a.client.downloadFile(SRC, { format: "url" });
  assert.equal(a.calls.fetch[0].maxBytes, DEFAULT_SANDBOX_MAX_IMAGE_BYTES + 1);

  const b = makeClient({ buffer: Buffer.from("ok") });
  await b.client.downloadFile(SRC, { format: "auto" });
  assert.equal(b.calls.fetch[0].maxBytes, DEFAULT_SANDBOX_MAX_IMAGE_BYTES + 1);
});

test("a fetch aborted by the size guard is rewrapped as an actionable base64-ceiling error", async () => {
  // Simulate axios' maxContentLength abort (the early-abort guard firing).
  const { client } = makeClient({
    fetchImpl: async () => {
      const err = new Error("maxContentLength size of 1048577 exceeded");
      err.code = "ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED";
      throw err;
    },
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "base64" }),
    (e) =>
      /exceeds the base64 ceiling/.test(e.message) &&
      /format:'url'/.test(e.message) &&
      // The RAW axios internals are not surfaced to the agent.
      !/maxContentLength/.test(e.message),
  );
});

test("a size-guard abort in url/auto mode names the ABSOLUTE maximum (the largest per-blob cap)", async () => {
  // At abort time the mime is unknown (the response was cut off), so the only
  // honest bound to quote is the LARGEST per-blob cap — worded as the ABSOLUTE
  // maximum, not as "the maximum deliverable" (a non-image's own cap is lower;
  // that case is caught after a completed read, with its exact cap named).
  const { client } = makeClient({
    fetchImpl: async () => {
      throw new Error("maxContentLength size of 20971521 exceeded");
    },
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "auto" }),
    (e) =>
      /absolute\s+maximum/.test(e.message) &&
      e.message.includes(String(DEFAULT_SANDBOX_MAX_IMAGE_BYTES)) &&
      !/maxContentLength/.test(e.message),
  );
});

test("a NON-size fetch error (404 / timeout) propagates unchanged", async () => {
  const { client } = makeClient({
    fetchImpl: async () => {
      throw new Error("Request failed with status code 404");
    },
  });
  await assert.rejects(
    () => client.downloadFile(SRC, { format: "auto" }),
    /status code 404/,
  );
});

// ---------------------------------------------------------------------------
// src validation: SSRF / traversal / the SPA catch-all  (AC #6, #7)
// ---------------------------------------------------------------------------

test("a src outside /api/files/ is REJECTED before the network (AC #6)", async () => {
  for (const bad of [
    "/api/pages/abc",
    "/api/users",
    "/api/auth/whoami",
    "/api/files/../auth/whoami", // traversal that escapes the subtree
    "https://cdn.example.com/photo.png", // a genuinely external URL
  ]) {
    const { client, calls } = makeClient();
    await assert.rejects(
      () => client.downloadFile(bad, { format: "base64" }),
      (e) => e instanceof Error,
      `expected "${bad}" to be rejected`,
    );
    // Non-vacuity: the rejection happened BEFORE any request was made, and no
    // download was ever metered.
    assert.equal(calls.fetch.length, 0, `"${bad}" reached the network`);
    assert.equal(calls.metric.length, 0, `"${bad}" emitted a download metric`);
  }
});

test("a percent-encoded traversal (%2e / %2f) is REJECTED before the network (AC #6)", async () => {
  for (const bad of [
    "/api/files/%2e%2e/auth/whoami",
    "/api/files/x%2fy%2f..%2fauth",
  ]) {
    const { client, calls } = makeClient();
    await assert.rejects(
      () => client.downloadFile(bad, { format: "base64" }),
      /percent-encoded|form/i,
    );
    assert.equal(calls.fetch.length, 0);
  }
});

test("an SSRF host is ignored: the fetch seam gets the host-STRIPPED /api/files path (AC #6)", async () => {
  // `http://evil/api/files/<uuid>/y.png` must NOT be rejected as malformed — its
  // PATH is a legitimate internal attachment path. The property that matters is
  // what downloadFile HANDS TO THE FETCH: the canonical, host-stripped
  // `/api/files/<uuid>/<name>`, so the bytes (and the bearer) can only ever go to
  // THIS instance's loopback. Asserting the seam's ARGUMENT — not just "it did not
  // throw" — is what locks it: passing the absolute URL through would red this.
  const { client, calls } = makeClient({ buffer: Buffer.from("bytes") });
  const r = await client.downloadFile(`http://evil.example.com/api/files/${ID}/y.png`, {
    format: "base64",
  });
  assert.equal(r.kind, "base64");
  // The metadata came from the PATH, not the attacker's host.
  assert.equal(r.attachmentId, ID);
  assert.equal(r.fileName, "y.png");
  assert.equal(calls.fetch.length, 1);
  // THE assertion: no scheme, no host — a relative internal path only.
  assert.equal(calls.fetch[0].src, `/api/files/${ID}/y.png`);
  assert.ok(
    !/^[a-z]+:\/\//i.test(calls.fetch[0].src) &&
      !/evil\.example\.com/.test(calls.fetch[0].src),
    `the attacker host reached the fetch seam: ${calls.fetch[0].src}`,
  );
});

test("an https SSRF host with a port/userinfo is stripped the same way", async () => {
  // Same property through the other absolute-URL shapes an agent could paste.
  for (const bad of [
    `https://evil.example.com:8443/api/files/${ID}/y.png`,
    `https://user:pw@evil.example.com/api/files/${ID}/y.png`,
  ]) {
    const { client, calls } = makeClient({ buffer: Buffer.from("bytes") });
    const r = await client.downloadFile(bad, { format: "base64" });
    assert.equal(r.kind, "base64");
    assert.equal(calls.fetch[0].src, `/api/files/${ID}/y.png`, `src: ${bad}`);
  }
});

test("the query string is stripped from what the fetch seam receives", async () => {
  const { client, calls } = makeClient({ buffer: Buffer.from("q") });
  await client.downloadFile(`${SRC}?download=1`, { format: "base64" });
  assert.equal(calls.fetch[0].src, SRC);
});

test("a one-segment /api/files/<x> src is REJECTED (the SPA catch-all trap, AC #7)", async () => {
  // `/api/files/onlyoneseg` clears the `/api/files/` prefix gate but matches NO
  // file route, so the server's catch-all would answer 200 text/html (index.html)
  // and the tool would "successfully" return an SPA page. Reject on FORM instead.
  for (const bad of [
    "/api/files/onlyoneseg",
    "/api/files/", // no segments at all
    `/api/files/${ID}`, // uuid but no file name
    `/api/files/${ID}/a/b`, // an extra segment
    "/api/files/not-a-uuid/photo.png", // fileId is not a UUID
  ]) {
    const { client, calls } = makeClient();
    await assert.rejects(
      () => client.downloadFile(bad, { format: "base64" }),
      /must be an internal attachment URL of the form/,
      `expected "${bad}" to be rejected on form`,
    );
    // Non-vacuity: the form guard fired BEFORE the network.
    assert.equal(calls.fetch.length, 0, `"${bad}" reached the network`);
  }
});

// ---------------------------------------------------------------------------
// best-effort metadata  (AC #9)
// ---------------------------------------------------------------------------

test("a query string is stripped; metadata still parses", async () => {
  const { client } = makeClient({ buffer: Buffer.from("q") });
  const r = await client.downloadFile(`${SRC}?download=1`, { format: "base64" });
  assert.equal(r.fileName, "photo.png");
  assert.equal(r.attachmentId, ID);
});

test("a percent-encoded file name is decoded", async () => {
  const { client } = makeClient({ buffer: Buffer.from("n") });
  const r = await client.downloadFile(`/api/files/${ID}/my%20report.pdf`, {
    format: "base64",
  });
  assert.equal(r.fileName, "my report.pdf");
});

test("a MALFORMED percent escape in the name -> fileName null, the download still SUCCEEDS (AC #9)", async () => {
  // `%E0%A4` is a truncated UTF-8 sequence: decodeURIComponent throws URIError on
  // it. That must degrade the best-effort metadata to null, never fail the tool.
  const { client } = makeClient({ buffer: Buffer.from("m"), mime: "image/png" });
  const r = await client.downloadFile(`/api/files/${ID}/%E0%A4`, {
    format: "base64",
  });
  assert.equal(r.kind, "base64"); // did NOT throw
  assert.equal(r.fileName, null); // degraded, as designed
  assert.equal(r.attachmentId, ID); // the uuid still parsed
});

// ---------------------------------------------------------------------------
// observability: the download-volume metric  (AC #10)
// ---------------------------------------------------------------------------

test("a successful download emits mcp_download_bytes_total{tool} with the byte volume", async () => {
  const bytes = Buffer.alloc(4096, 1);
  const { client, calls } = makeClient({ buffer: bytes, mime: "image/png" });

  await client.downloadFile(SRC, { format: "base64" });

  const m = calls.metric.find((x) => x.name === "mcp_download_bytes_total");
  assert.ok(m, "no mcp_download_bytes_total sample emitted");
  assert.equal(m.value, bytes.length);
  assert.deepEqual(m.labels, { tool: "downloadFile" });
});

test("the url branch meters the same volume", async () => {
  const bytes = Buffer.alloc(3 * MIB, 1);
  const { client, calls } = makeClient({ buffer: bytes, mime: "application/pdf" });
  await client.downloadFile(SRC, { format: "url" });
  const m = calls.metric.find((x) => x.name === "mcp_download_bytes_total");
  assert.equal(m.value, bytes.length);
});

test("a rejected src meters NOTHING (nothing was downloaded)", async () => {
  const { client, calls } = makeClient();
  await assert.rejects(() => client.downloadFile("/api/pages/x", {}));
  assert.equal(
    calls.metric.filter((x) => x.name === "mcp_download_bytes_total").length,
    0,
  );
});

// ---------------------------------------------------------------------------
// the MCP RESULT ENVELOPE (index.ts handler) — the tool's wire shape
//
// The two branches deliberately use DIFFERENT envelopes: `url` owns its own
// (resource_link + structuredContent, like stashPage) so neither the URL nor the
// bytes are pushed through the model context as JSON text, while `base64` is the
// standard jsonContent text envelope (the caller asked for bytes in context).
// The tests above cover the client method; these cover the registration in
// index.ts, i.e. what an MCP client actually receives.
// ---------------------------------------------------------------------------

/**
 * Build the real MCP server and return the registered `downloadFile` handler.
 * registerTool is captured on the McpServer PROTOTYPE (index.ts then rebinds the
 * INSTANCE method to add the timing/comment-signal wrappers, and that instance
 * wrapper delegates to this one) — so the handler we capture is the one an MCP
 * client's call would run, wrappers included. `downloadFile` on the client is
 * stubbed through the prototype, since the factory owns its DocmostClient; that
 * stub MUST stay installed while the handler runs, so it is torn down by the
 * caller's `t.after` (restoring it here would let the handler hit the real axios
 * client — which is exactly how the first draft of this helper failed).
 */
async function captureDownloadFileHandler(t, downloadFileImpl) {
  const { createDocmostMcpServer } = await import("../../build/index.js");
  const { McpServer } = await import(
    "@modelcontextprotocol/sdk/server/mcp.js"
  );
  const origRegister = McpServer.prototype.registerTool;
  const origDownload = DocmostClient.prototype.downloadFile;
  const handlers = new Map();
  const registered = new Map();
  DocmostClient.prototype.downloadFile = downloadFileImpl;
  t.after(() => {
    DocmostClient.prototype.downloadFile = origDownload;
  });
  try {
    McpServer.prototype.registerTool = function (name, config, handler) {
      handlers.set(name, handler);
      registered.set(name, config);
      return origRegister.call(this, name, config, handler);
    };
    createDocmostMcpServer({
      apiUrl: "http://localhost/api",
      getToken: async () => "tok",
    });
  } finally {
    // registerTool is only needed DURING construction — restore it immediately.
    McpServer.prototype.registerTool = origRegister;
  }
  const handler = handlers.get("downloadFile");
  assert.ok(handler, "downloadFile was not registered on the MCP server");
  return { handler, config: registered.get("downloadFile") };
}

test("MCP envelope: format 'url' returns a resource_link + structuredContent (bytes stay OUT of context)", async (t) => {
  const seen = [];
  const { handler } = await captureDownloadFileHandler(t, async (src, opts) => {
    seen.push({ src, opts });
    return {
      kind: "url",
      uri: "http://localhost/api/sandbox/blob-1",
      sha256: "b".repeat(64),
      mime: "application/pdf",
      fileName: "report.pdf",
      attachmentId: ID,
      size: 3 * MIB,
    };
  });

  const result = await handler({ src: SRC, format: "url" });

  // The args reached the client method unchanged.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].src, SRC);
  assert.equal(seen[0].opts.format, "url");

  // ONE resource_link content element — no JSON text blob, no base64 payload.
  assert.equal(result.content.length, 1);
  const link = result.content[0];
  assert.equal(link.type, "resource_link");
  assert.equal(link.uri, "http://localhost/api/sandbox/blob-1");
  assert.equal(link.name, "report.pdf");
  assert.equal(link.mimeType, "application/pdf");
  assert.equal(link.size, 3 * MIB);
  assert.equal(
    result.content.filter((c) => c.type === "text").length,
    0,
    "the url branch must NOT push a JSON text blob into the context",
  );

  // ...plus the documented structuredContent mirror.
  assert.deepEqual(result.structuredContent, {
    kind: "url",
    uri: "http://localhost/api/sandbox/blob-1",
    sha256: "b".repeat(64),
    mime: "application/pdf",
    fileName: "report.pdf",
    attachmentId: ID,
    size: 3 * MIB,
  });
});

test("MCP envelope: a url result with no fileName falls back to the 'attachment' link name", async (t) => {
  const { handler } = await captureDownloadFileHandler(t, async () => ({
    kind: "url",
    uri: "http://localhost/api/sandbox/blob-2",
    sha256: "c".repeat(64),
    mime: "application/octet-stream",
    fileName: null,
    attachmentId: ID,
    size: 10,
  }));
  const result = await handler({ src: SRC, format: "url" });
  assert.equal(result.content[0].name, "attachment"); // never undefined
  assert.equal(result.structuredContent.fileName, null);
});

test("MCP envelope: format 'base64' returns the jsonContent text envelope (bytes IN context)", async (t) => {
  const payload = {
    kind: "base64",
    base64: Buffer.from("hello bytes").toString("base64"),
    mime: "image/png",
    fileName: "photo.png",
    attachmentId: ID,
    size: 11,
  };
  const { handler } = await captureDownloadFileHandler(t, async () => payload);

  const result = await handler({ src: SRC, format: "base64" });

  // Exactly the jsonContent shape: one text element carrying the whole result.
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
  // The base64 branch does NOT use the resource_link/structuredContent envelope.
  assert.equal(result.structuredContent, undefined);
  assert.equal(
    result.content.filter((c) => c.type === "resource_link").length,
    0,
  );
});

test("MCP envelope: 'auto' resolving to base64 also takes the jsonContent branch (the envelope follows the KIND, not the requested format)", async (t) => {
  const { handler } = await captureDownloadFileHandler(t, async (src, opts) => {
    assert.equal(opts.format, undefined); // no format passed -> the client defaults to auto
    return {
      kind: "base64",
      base64: "AAAA",
      mime: "application/pdf",
      fileName: "small.pdf",
      attachmentId: ID,
      size: 3,
    };
  });
  const result = await handler({ src: SRC });
  assert.equal(result.content[0].type, "text");
  assert.equal(result.structuredContent, undefined);
});

test("MCP tool description tells the truth about an absolute url's host (F3)", async (t) => {
  // The tool description is what an agent reads. It must NOT claim external URLs
  // are "rejected" (they are not — the host is IGNORED and the LOCAL file is
  // served), or an agent handed another instance's URL would believe it fetched
  // the remote file.
  const { config } = await captureDownloadFileHandler(t, async () => ({}));
  assert.doesNotMatch(config.description, /external http\(s\) URLs are rejected/i);
  assert.match(config.description, /host is IGNORED/i);
  assert.match(config.description, /ALWAYS fetched from THIS/i);
});
