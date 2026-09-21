// Issue #464 — prove the size guard SKIPS the recreateTransform pipeline over
// the cap, not merely that it returns "coarse". node:test's mock.module needs an
// experimental flag the suite does not pass, so instead of a module spy we use a
// deterministic BEHAVIORAL proxy that isolates the one variable — the guard:
//
//   Same over-cap pair, run twice:
//     (a) default caps            -> guard trips  -> recreateTransform skipped,
//     (b) caps raised above the doc -> guard OFF -> recreateTransform DOES run.
//
// The only code path that differs between (a) and (b) is whether
// recreateTransform executes. recreateTransform on this pair is O(n²) and takes
// SECONDS; the guarded path is a linear coarse diff taking milliseconds. So a
// large (a)≪(b) time ratio can ONLY be explained by (a) skipping the transform.
// This asserts the skip without depending on mock.module.
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffDocs } from "../../build/lib/diff.js";

const t = (text) => ({ type: "text", text });
const para = (text) => ({ type: "paragraph", content: text ? [t(text)] : [] });
const doc = (children) => ({ type: "doc", content: children });
function buildDoc(n, seed) {
  return doc(
    Array.from({ length: n }, (_, i) =>
      para(Array.from({ length: 8 }, (_, w) => `${seed}${i}_${w}`).join(" ")),
    ),
  );
}
function clearEnv() {
  delete process.env.MCP_DIFF_MAX_NODES;
  delete process.env.MCP_DIFF_MAX_BYTES;
}
function timed(fn) {
  const s = performance.now();
  const out = fn();
  return { out, ms: performance.now() - s };
}

// A 300-para (~600-node) pair: comfortably over BOTH defaults (#582: 200 nodes /
// 4 KiB), yet
// small enough that the un-guarded precise path still FINISHES (~1s) so the test
// can time the contrast without hanging.
const OLD = buildDoc(300, "a");
const NEW = buildDoc(300, "b");

test("guard skips recreateTransform over-cap (guarded run is far faster than un-guarded)", () => {
  // (a) Guarded: default caps -> should short-circuit to coarse, near-instant.
  clearEnv();
  const guarded = timed(() => diffDocs(OLD, NEW));
  assert.match(
    guarded.out.markdown,
    /coarse block-level diff/,
    "guarded run must be coarse (guard tripped)",
  );

  // (b) Un-guarded: raise both caps above the doc so the precise path runs.
  process.env.MCP_DIFF_MAX_NODES = "1000000";
  process.env.MCP_DIFF_MAX_BYTES = "100000000";
  let unguarded;
  try {
    unguarded = timed(() => diffDocs(OLD, NEW));
  } finally {
    clearEnv();
  }
  assert.doesNotMatch(
    unguarded.out.markdown,
    /coarse block-level diff/,
    "with caps raised, the precise recreateTransform path runs",
  );

  // The precise run executed recreateTransform (cost ~ changedBlocks x docBytes);
  // the guarded run did not.
  // Require a large speedup so the ONLY explanation is the skipped transform.
  assert.ok(
    guarded.ms * 5 < unguarded.ms,
    `guarded (${guarded.ms.toFixed(1)}ms) must be >=5x faster than un-guarded ` +
      `(${unguarded.ms.toFixed(1)}ms); a small gap would mean the transform still ran`,
  );
});

test("guarded over-cap call stays within the ~200ms event-loop budget", () => {
  clearEnv();
  // Best-of-3 to shed GC/JIT noise; the guarded coarse path is a linear walk.
  let best = Infinity;
  for (let i = 0; i < 3; i++) best = Math.min(best, timed(() => diffDocs(OLD, NEW)).ms);
  assert.ok(best < 200, `guarded over-cap diff must be <200ms, was ${best.toFixed(1)}ms`);
});
