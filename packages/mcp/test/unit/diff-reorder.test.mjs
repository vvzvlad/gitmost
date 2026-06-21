import { test } from "node:test";
import assert from "node:assert/strict";

import { diffDocs, summarizeChange } from "../../build/lib/diff.js";

const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const para = (s) => ({ type: "paragraph", content: [t(s)] });
const doc = (...c) => ({ type: "doc", content: c });

// ---------------------------------------------------------------------------
// Block REORDER (A,B -> B,A): the two documents contain the SAME blocks in a
// different order. A naive set-based comparison would call this "no content
// change" (the multiset of blocks is identical), which is wrong: the reader's
// document order changed. The changeset-based diff must report it as a real
// change and the integrity-/value-based summary must NOT claim "no content
// change".
// ---------------------------------------------------------------------------
const A = para("Alpha paragraph content one");
const B = para("Beta paragraph content two");
const before = doc(A, B);
const after = doc(B, A); // identical blocks, swapped order

test("diffDocs on a block swap does NOT report 'no textual changes'", () => {
  const r = diffDocs(before, after);
  assert.doesNotMatch(
    r.markdown,
    /no textual changes/i,
    "a reorder is a content change, not a no-op",
  );
  // The reorder surfaces as both an insertion and a deletion (text moved).
  assert.ok(r.summary.inserted > 0, "reports inserted chars");
  assert.ok(r.summary.deleted > 0, "reports deleted chars");
  const ops = new Set(r.changes.map((c) => c.op));
  assert.ok(ops.has("insert") && ops.has("delete"), "has both insert and delete changes");
});

test("diffDocs reorder: summary fields are coherent (blocksChanged > 0, counts > 0)", () => {
  const r = diffDocs(before, after);
  assert.ok(r.summary.blocksChanged > 0, "blocksChanged must be positive for a reorder");
  // Symmetric move: the moved text is both inserted and deleted, so the two
  // counts are equal. (The diff algorithm chooses ONE of the two equal-status
  // blocks to represent as "moved", so we assert the count equals one of the
  // block lengths rather than hard-coding which block moved.)
  assert.equal(
    r.summary.inserted,
    r.summary.deleted,
    "a pure move inserts and deletes the same number of chars",
  );
  const blockLens = ["Alpha paragraph content one".length, "Beta paragraph content two".length];
  assert.ok(
    blockLens.includes(r.summary.inserted),
    `moved char count ${r.summary.inserted} should equal one of the block lengths ${JSON.stringify(blockLens)}`,
  );
});

test("summarizeChange on a block swap reports changed:true, NOT 'no content change'", () => {
  const rep = summarizeChange(before, after);
  assert.equal(rep.changed, true, "a reorder is a change");
  assert.notEqual(rep.summary, "no content change");
  assert.match(rep.summary, /^changed:/, "summary is a 'changed: ...' line");
  // blocksChanged is coherent with diffDocs.
  assert.ok(rep.blocksChanged > 0, "blocksChanged > 0");
  assert.equal(rep.textInserted, rep.textDeleted, "symmetric move");
  assert.ok(rep.textInserted > 0, "text counts > 0");
});

test("control: an IDENTICAL doc (no reorder) reports no content change", () => {
  // Guards the reorder assertions from being vacuously true: the same docs in
  // the SAME order must still cleanly report no change.
  const rep = summarizeChange(before, before);
  assert.equal(rep.changed, false);
  assert.equal(rep.summary, "no content change");
  const r = diffDocs(before, before);
  assert.equal(r.summary.blocksChanged, 0);
  assert.equal(r.changes.length, 0);
});

test("a three-block rotation (A,B,C -> C,A,B) is reported as a change", () => {
  const C = para("Gamma paragraph content three");
  const d1 = doc(A, B, C);
  const d2 = doc(C, A, B);
  const rep = summarizeChange(d1, d2);
  assert.equal(rep.changed, true);
  assert.notEqual(rep.summary, "no content change");
  const r = diffDocs(d1, d2);
  assert.ok(r.summary.blocksChanged > 0);
  assert.doesNotMatch(r.markdown, /no textual changes/i);
});
