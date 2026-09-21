import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Issue #449, invariant 2 ("no-await-окно"): the atomicity of the
// read -> transform -> write section in CollabSession.mutate depends on there
// being NO `await` (nor any other async yield point) between
// `TiptapTransformer.fromYdoc` and `applyDocToFragment`. Yjs applies queued
// remote updates only when the event loop yields, so an accidental await in that
// window would let a concurrent human edit interleave and be clobbered (#152).
//
// That was an invariant enforced only by a comment. This test turns a violation
// RED: it reads the SOURCE of collab-session.ts, extracts the block delimited by
// the machine-readable BEGIN/END markers, and asserts no async boundary appears
// inside it. Introducing an `await` (or `for await`, or `yield`) between the
// markers fails this test.

const here = dirname(fileURLToPath(import.meta.url));
// Scan the .ts SOURCE (not the compiled .js): the markers live in the source and
// transpilation could rewrite/erase them, so the source is the authoritative
// artifact the human edits.
const sourcePath = join(here, "..", "..", "src", "lib", "collab-session.ts");
const source = readFileSync(sourcePath, "utf8");

const BEGIN = "=== MUTATE-CRITICAL-WINDOW: BEGIN";
const END = "=== MUTATE-CRITICAL-WINDOW: END";

test("critical-window markers exist exactly once each", () => {
  const begins = source.split(BEGIN).length - 1;
  const ends = source.split(END).length - 1;
  assert.equal(
    begins,
    1,
    `expected exactly one '${BEGIN}' marker, found ${begins}`,
  );
  assert.equal(ends, 1, `expected exactly one '${END}' marker, found ${ends}`);
});

test("the read->write critical window contains no async boundary (no await/yield)", () => {
  const beginIdx = source.indexOf(BEGIN);
  const endIdx = source.indexOf(END);
  assert.ok(beginIdx !== -1, "BEGIN marker not found");
  assert.ok(endIdx !== -1, "END marker not found");
  assert.ok(endIdx > beginIdx, "END marker must come after BEGIN marker");

  // The block strictly between the two marker lines. Move past the end of the
  // BEGIN marker line so the marker comment text itself is not scanned.
  const afterBeginLine = source.indexOf("\n", beginIdx) + 1;
  const block = source.slice(afterBeginLine, endIdx);

  // Detect any real async yield keyword as a whole word. `\bawait\b` also matches
  // inside `for await`, which is exactly what we want to forbid here.
  const forbidden = [/\bawait\b/, /\byield\b/];
  for (const re of forbidden) {
    const m = block.match(re);
    assert.equal(
      m,
      null,
      `forbidden async boundary '${m?.[0]}' found inside the no-await critical ` +
        `window of CollabSession.mutate. INVARIANT 1 (#449): the block between ` +
        `TiptapTransformer.fromYdoc and applyDocToFragment must be fully ` +
        `synchronous — an await there reopens the clobber-live-edits race (#152).`,
    );
  }
});

test("the critical window still spans fromYdoc -> applyDocToFragment", () => {
  // Guards the markers from drifting off the code they are meant to protect: if
  // someone moves the read/write out of the window, this catches it.
  const beginIdx = source.indexOf(BEGIN);
  const endIdx = source.indexOf(END);
  const afterBeginLine = source.indexOf("\n", beginIdx) + 1;
  const block = source.slice(afterBeginLine, endIdx);
  assert.ok(
    block.includes("TiptapTransformer.fromYdoc"),
    "critical window must contain the TiptapTransformer.fromYdoc read",
  );
  assert.ok(
    block.includes("applyDocToFragment"),
    "critical window must contain the applyDocToFragment write",
  );
});
