// Unit tests for the getPage content-addressed conversion cache (issue #479).
// Exercises the GetPageConversionCache class in isolation: key composition,
// hit/miss, LRU recency on read, and eviction by BOTH the count cap and the
// byte cap. The getPage integration (counter emission, byte-identical output)
// is covered separately in test/mock/getpage-conversion-cache.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GetPageConversionCache,
  hashConvertOptions,
} from "../../build/client/getpage-cache.js";

test("key: identical (pageId, updatedAt, optionsHash) collapse to one entry", () => {
  const c = new GetPageConversionCache();
  const k1 = GetPageConversionCache.key("uuid-1", "2026-01-01T00:00:00Z", "{}");
  const k2 = GetPageConversionCache.key("uuid-1", "2026-01-01T00:00:00Z", "{}");
  assert.equal(k1, k2, "same parts -> same key");
  c.set(k1, "MD-A");
  assert.equal(c.get(k2), "MD-A", "hit on the identical key");
  assert.equal(c.size, 1);
});

test("miss after updatedAt changes (precise invalidation)", () => {
  const c = new GetPageConversionCache();
  const oldK = GetPageConversionCache.key("uuid-1", "v1", "{}");
  const newK = GetPageConversionCache.key("uuid-1", "v2", "{}");
  c.set(oldK, "OLD-MD");
  assert.equal(c.get(newK), undefined, "a new updatedAt is a fresh key -> miss");
  assert.equal(c.get(oldK), "OLD-MD", "the old snapshot is still addressable");
});

test("miss after options change (dropResolvedCommentAnchors true vs false)", () => {
  const c = new GetPageConversionCache();
  const hDrop = hashConvertOptions({ dropResolvedCommentAnchors: true });
  const hKeep = hashConvertOptions({ dropResolvedCommentAnchors: false });
  assert.notEqual(hDrop, hKeep, "different options hash to different keys");
  const kDrop = GetPageConversionCache.key("uuid-1", "v1", hDrop);
  const kKeep = GetPageConversionCache.key("uuid-1", "v1", hKeep);
  c.set(kDrop, "AGENT-MD");
  assert.equal(
    c.get(kKeep),
    undefined,
    "the export variant must NOT be served the agent variant",
  );
});

test("hashConvertOptions is order-insensitive and handles empty", () => {
  assert.equal(
    hashConvertOptions({ a: 1, b: 2 }),
    hashConvertOptions({ b: 2, a: 1 }),
    "key order does not change the hash",
  );
  assert.equal(hashConvertOptions(undefined), "{}");
  assert.equal(hashConvertOptions(null), "{}");
  assert.equal(hashConvertOptions({}), "{}");
});

test("LRU eviction by COUNT cap evicts the least-recently-used entry", () => {
  const c = new GetPageConversionCache({ maxEntries: 2, maxBytes: 10 * 1024 * 1024 });
  c.set("k1", "a");
  c.set("k2", "b");
  c.set("k3", "c"); // over the count cap -> evict k1 (oldest)
  assert.equal(c.size, 2);
  assert.equal(c.get("k1"), undefined, "k1 evicted");
  assert.equal(c.get("k2"), "b");
  assert.equal(c.get("k3"), "c");
});

test("a read refreshes recency so the OTHER entry is evicted next", () => {
  const c = new GetPageConversionCache({ maxEntries: 2, maxBytes: 10 * 1024 * 1024 });
  c.set("k1", "a");
  c.set("k2", "b");
  // Touch k1 so k2 becomes the least-recently-used.
  assert.equal(c.get("k1"), "a");
  c.set("k3", "c"); // evicts the LRU, which is now k2 (not k1)
  assert.equal(c.get("k2"), undefined, "k2 was LRU and got evicted");
  assert.equal(c.get("k1"), "a", "k1 survived because it was read");
  assert.equal(c.get("k3"), "c");
});

test("LRU eviction by BYTE cap evicts oldest until under the cap", () => {
  // Byte cap of 100; each value is 40 bytes -> at most 2 fit (80 < 100 < 120).
  const big = "x".repeat(40);
  const c = new GetPageConversionCache({ maxEntries: 50, maxBytes: 100 });
  c.set("k1", big); // 40
  c.set("k2", big); // 80
  assert.equal(c.size, 2);
  c.set("k3", big); // 120 > 100 -> evict k1 -> 80
  assert.equal(c.size, 2, "byte cap forced an eviction despite the count cap");
  assert.equal(c.get("k1"), undefined, "oldest evicted by bytes");
  assert.equal(c.get("k2"), big);
  assert.equal(c.get("k3"), big);
  assert.ok(c.bytes <= 100, "total bytes stays within the cap");
});

test("re-setting an existing key updates value+recency and keeps bytes exact", () => {
  const c = new GetPageConversionCache({ maxEntries: 5, maxBytes: 10 * 1024 * 1024 });
  c.set("k1", "short");
  const b1 = c.bytes;
  assert.equal(b1, Buffer.byteLength("short", "utf8"));
  c.set("k1", "a much longer value");
  assert.equal(c.size, 1, "no duplicate entry");
  assert.equal(c.bytes, Buffer.byteLength("a much longer value", "utf8"));
  assert.equal(c.get("k1"), "a much longer value");
});

test("an oversized single entry is still stored (never a permanent miss)", () => {
  const c = new GetPageConversionCache({ maxEntries: 5, maxBytes: 10 });
  const big = "y".repeat(1000);
  c.set("k1", big);
  assert.equal(c.get("k1"), big, "the page bigger than the cap is still served");
  assert.equal(c.size, 1);
});
