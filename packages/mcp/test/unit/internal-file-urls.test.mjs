// Unit tests for the internal-file URL helpers the stash tool relies on. The
// critical case is resolveInternalFilePath, whose whole job is to REJECT a
// content-controlled `src` that tries to escape /api/files/ (SSRF / traversal)
// before it ever reaches the authenticated loopback client.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveInternalFilePath,
  normalizeFileUrl,
  collectInternalFileNodes,
} from "../../build/lib/internal-file-urls.js";

test("resolveInternalFilePath accepts a normal internal src", () => {
  assert.equal(
    resolveInternalFilePath("/api/files/att-1/pic.png"),
    "/files/att-1/pic.png",
  );
});

test("resolveInternalFilePath rejects traversal / encoded variants (SSRF guard)", () => {
  // `..` collapses to /api/auth/whoami -> outside /api/files/ -> rejected.
  assert.throws(() => resolveInternalFilePath("/api/files/../auth/whoami"));
  // Escapes the /api base entirely.
  assert.throws(() => resolveInternalFilePath("/api/files/../../internal"));
  // Percent-encoded dot -> rejected before canonicalization.
  assert.throws(() => resolveInternalFilePath("/api/files/%2e%2e/x"));
  // Percent-encoded slash separator -> rejected before canonicalization.
  assert.throws(() => resolveInternalFilePath("/api/files/..%2fauth"));
});

test("resolveInternalFilePath drops a foreign host and keeps only the /api/files/ pathname (SSRF accept-path)", () => {
  // ACCEPT path: an absolute URL has its host dropped; only the canonical
  // pathname survives, and it must still start with /api/files/. This is SAFE
  // because the loopback axios client ignores any host in `src` and uses its own
  // /api baseURL — so a foreign host like evil.com is never contacted. This is
  // the SOLE SSRF/traversal guard for content-controlled `src`, so it must be
  // pinned: a future refactor to a prefix-only check would silently open a
  // bypass with no failing test.
  assert.equal(
    resolveInternalFilePath("http://evil.com/api/files/x/y.png"),
    "/files/x/y.png",
  );
  // Protocol-relative URL: host likewise dropped, pathname kept.
  assert.equal(
    resolveInternalFilePath("//evil.com/api/files/x/y.png"),
    "/files/x/y.png",
  );
});

test("resolveInternalFilePath rejects a foreign-host src whose pathname escapes /api/files/", () => {
  // Even though the host is dropped, the canonical pathname /api/auth/whoami
  // does NOT start with /api/files/, so it is rejected.
  assert.throws(() =>
    resolveInternalFilePath("https://evil.com/api/auth/whoami"),
  );
  // The WHATWG URL parser converts backslashes to `/` for http(s), so this
  // collapses to /api/auth/whoami and escapes the /api/files/ subtree.
  assert.throws(() => resolveInternalFilePath("/api/files\\..\\auth\\whoami"));
});

test("resolveInternalFilePath wraps a new URL parse failure in a clear error", () => {
  // `http://[` has no %2e/%2f so it passes the first guard, then fails the
  // `new URL(...)` parse — exercising the catch branch that re-throws with a
  // clear message.
  assert.throws(
    () => resolveInternalFilePath("http://["),
    /Invalid internal file src/,
  );
});

test("normalizeFileUrl rewrites the bare /files/ branch and leaves /api/files/ alone", () => {
  assert.equal(
    normalizeFileUrl("/files/att-1/pic.png"),
    "/api/files/att-1/pic.png",
  );
  assert.equal(
    normalizeFileUrl("/api/files/att-1/pic.png"),
    "/api/files/att-1/pic.png",
  );
});

test("collectInternalFileNodes recurses into nested content containers", () => {
  // The internal image is buried inside a callout's content array, so a
  // regression on the recursion (e.g. a shallow .filter()) would miss it.
  const nested = {
    type: "image",
    attrs: { src: "/api/files/att-9/deep.png", attachmentId: "att-9" },
  };
  const doc = {
    type: "doc",
    content: [
      {
        type: "callout",
        content: [{ type: "paragraph", content: [nested] }],
      },
    ],
  };
  const found = collectInternalFileNodes(doc);
  assert.equal(found.length, 1);
  assert.equal(found[0], nested);
});
