import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeChange } from "../../build/lib/diff.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const para = (...children) => ({ type: "paragraph", content: children });
const doc = (...children) => ({ type: "doc", content: children });

// ---------------------------------------------------------------------------
// (i) Identical docs -> changed:false, marks {}
// ---------------------------------------------------------------------------
test("summarizeChange on identical docs reports no change", () => {
  const d = doc(para(t("unchanged")));
  // Distinct deep clone so it is value-equal but not reference-equal.
  const same = JSON.parse(JSON.stringify(d));
  const r = summarizeChange(d, same);

  assert.equal(r.changed, false);
  assert.deepEqual(r.marks, {});
  assert.equal(r.textInserted, 0);
  assert.equal(r.textDeleted, 0);
  assert.equal(r.blocksChanged, 0);
  assert.equal(r.summary, "no content change");
});

// ---------------------------------------------------------------------------
// (ii) A pure text change -> textInserted/textDeleted > 0
// ---------------------------------------------------------------------------
test("summarizeChange reports char counts for a text change", () => {
  const before = doc(para(t("Hello world")));
  const after = doc(para(t("Hello brave world")));
  const r = summarizeChange(before, after);

  assert.equal(r.changed, true);
  assert.ok(r.textInserted > 0, "reports inserted chars");
  // No marks changed in a pure text edit.
  assert.deepEqual(r.marks, {});
  assert.match(r.summary, /chars/);
});

// ---------------------------------------------------------------------------
// (iii) CRITICAL: a mark-only change. Same text, one node loses its strike
// mark -> changed:true, marks.strike === [1,0], text counts are 0.
// This proves mark changes are surfaced even though diffDocs sees no text diff.
// ---------------------------------------------------------------------------
test("summarizeChange surfaces a pure mark removal (strike 1->0)", () => {
  const before = doc(para(t("on sale", [{ type: "strike" }])));
  // Same characters, strike mark removed.
  const after = doc(para(t("on sale")));
  const r = summarizeChange(before, after);

  assert.equal(r.changed, true);
  // The whole point: a mark delta is surfaced as [before, after].
  assert.deepEqual(r.marks.strike, [1, 0]);
  // No characters changed.
  assert.equal(r.textInserted, 0);
  assert.equal(r.textDeleted, 0);
  // The summary mentions the mark delta.
  assert.match(r.summary, /strike 1→0/);
  // A pure mark change must not carry a misleading "+0/-0 chars" text clause.
  assert.ok(!r.summary.includes("chars"));
});

// ---------------------------------------------------------------------------
// A mark addition is surfaced too (bold 0->1), and only changed types appear.
// ---------------------------------------------------------------------------
test("summarizeChange surfaces a mark addition and omits unchanged types", () => {
  const before = doc(para(t("a", [{ type: "italic" }]), t("b")));
  // Same text + same italic on "a", but "b" gains bold.
  const after = doc(para(t("a", [{ type: "italic" }]), t("b", [{ type: "bold" }])));
  const r = summarizeChange(before, after);

  assert.equal(r.changed, true);
  assert.deepEqual(r.marks.bold, [0, 1]);
  // italic count is unchanged (1 -> 1), so it must NOT appear in marks.
  assert.equal("italic" in r.marks, false);
});

// ---------------------------------------------------------------------------
// (iv) VALUE-based change: two value-equal docs that differ ONLY in JSON key
// order must report changed:false / "no content change", not a +0/-0 change.
// ---------------------------------------------------------------------------
test("summarizeChange treats a key-order-only difference as no change", () => {
  // Same node, but attrs/text written in a different key order on each side.
  const before = {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { a: 1, b: 2 }, content: [{ type: "text", text: "same" }] },
    ],
  };
  const after = {
    content: [
      { content: [{ text: "same", type: "text" }], attrs: { b: 2, a: 1 }, type: "paragraph" },
    ],
    type: "doc",
  };
  // JSON strings differ (key order), but the values are equal.
  assert.notEqual(JSON.stringify(before), JSON.stringify(after));

  const r = summarizeChange(before, after);
  assert.equal(r.changed, false);
  assert.equal(r.summary, "no content change");
  assert.equal(r.textInserted, 0);
  assert.equal(r.textDeleted, 0);
  assert.equal(r.blocksChanged, 0);
  assert.deepEqual(r.marks, {});
});

// ---------------------------------------------------------------------------
// (v) CRITICAL: a structural change that touches no text/marks — adding an
// image node (images 0 -> 1) — must report changed:true and surface the
// integrity delta in structure + summary, closing the verify blind spot for
// insert_image / delete_node on structural nodes.
// ---------------------------------------------------------------------------
test("summarizeChange surfaces an image-count change (0->1)", () => {
  const before = doc(para(t("caption")));
  const after = doc(
    para(t("caption")),
    { type: "image", attrs: { src: "x.png", attachmentId: "a1" } },
  );
  const r = summarizeChange(before, after);

  assert.equal(r.changed, true, "an added image is a change");
  assert.deepEqual(r.structure.images, [0, 1]);
  assert.match(r.summary, /images 0→1/);
});

// ---------------------------------------------------------------------------
// Robustness: a malformed pair must never throw; it degrades gracefully.
// ---------------------------------------------------------------------------
test("summarizeChange never throws on a pathological pair", () => {
  const before = { type: "doc", content: [] };
  // A doc whose `content` array references itself makes the recursive walkers
  // (diffDocs / markCounts / countNodes) recurse without bound and overflow the
  // stack. The try/catch must keep summarizeChange safe and degrade to a
  // minimal "changed (diff unavailable)" report instead of throwing.
  const after = { type: "doc", content: [] };
  after.content.push(after);
  const r = summarizeChange(before, after);
  assert.equal(r.changed, true);
  assert.equal(r.summary, "changed (diff unavailable)");
});
