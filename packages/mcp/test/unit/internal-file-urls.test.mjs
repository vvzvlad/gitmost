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
