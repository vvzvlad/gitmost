// applyAnchorInDoc — first-match / ambiguity / boundary behavior.
//
// comment-anchor.test.mjs already covers the core apply paths (single-node
// match, spanning adjacent text nodes, code/italic boundary mark preservation,
// smart-quote normalization, no-match-no-mutation, pre-existing comment mark
// replacement, nested-list DFS). This file focuses on the SELECTION/RESOLUTION
// behavior those tests don't pin down: which occurrence/block wins when a
// selection appears more than once, sub-word ranges, and the run boundary
// created by a non-text inline node.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyAnchorInDoc, canAnchorInDoc } from "../../build/lib/comment-anchor.js";

const commentMark = (node) =>
  (Array.isArray(node.marks) ? node.marks : []).find((m) => m && m.type === "comment") || null;
const paragraphDoc = (content) => ({ type: "doc", content: [{ type: "paragraph", content }] });

// ---------------------------------------------------------------------------
// Document order: when two separate blocks both contain the selection, only the
// FIRST block (DFS document order) is anchored; the second is left untouched.
// ---------------------------------------------------------------------------
test("anchors only the FIRST block when the selection occurs in two blocks", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "first target here" }] },
      { type: "paragraph", content: [{ type: "text", text: "second target here" }] },
    ],
  };
  assert.equal(applyAnchorInDoc(doc, "target", "C"), true);

  const marked0 = doc.content[0].content.filter((p) => commentMark(p));
  const marked1 = doc.content[1].content.filter((p) => commentMark(p));
  assert.equal(marked0.length, 1, "first block is anchored");
  assert.equal(marked0[0].text, "target");
  assert.equal(marked1.length, 0, "second block is left untouched");
});

// ---------------------------------------------------------------------------
// Ambiguity within one block: indexOf finds the FIRST occurrence, so only the
// first "ab" is marked; the later occurrences stay in one unmarked fragment.
// ---------------------------------------------------------------------------
test("anchors only the FIRST occurrence within a block (ambiguous selection)", () => {
  const doc = paragraphDoc([{ type: "text", text: "ab ab ab" }]);
  assert.equal(applyAnchorInDoc(doc, "ab", "C"), true);

  const parts = doc.content[0].content;
  assert.equal(parts.length, 2, "split into [marked, rest]");
  assert.equal(parts[0].text, "ab");
  assert.ok(commentMark(parts[0]), "first occurrence is marked");
  assert.equal(parts[1].text, " ab ab");
  assert.equal(commentMark(parts[1]), null, "later occurrences are not marked");
});

// ---------------------------------------------------------------------------
// Sub-word range: a selection that is a substring inside a single text node is
// spliced into before / marked / after, marking exactly the matched characters.
// ---------------------------------------------------------------------------
test("anchors a sub-word range inside a single text node", () => {
  const doc = paragraphDoc([{ type: "text", text: "Hello" }]);
  assert.equal(applyAnchorInDoc(doc, "ell", "C"), true);

  const parts = doc.content[0].content;
  assert.deepEqual(parts.map((p) => p.text), ["H", "ell", "o"]);
  assert.equal(commentMark(parts[0]), null);
  assert.ok(commentMark(parts[1]), "only the matched substring is marked");
  assert.equal(commentMark(parts[2]), null);
});

// ---------------------------------------------------------------------------
// A non-text inline node (hardBreak) breaks the matching run: a selection that
// would span the break cannot match, but one wholly inside a run still does.
// ---------------------------------------------------------------------------
test("a non-text inline node breaks the run: cross-break selection does not match", () => {
  const make = () =>
    paragraphDoc([
      { type: "text", text: "foo" },
      { type: "hardBreak" },
      { type: "text", text: "bar" },
    ]);

  // "foobar" straddles the hardBreak -> no match, no mutation.
  const docA = make();
  const before = JSON.stringify(docA);
  assert.equal(canAnchorInDoc(docA, "foobar"), false);
  assert.equal(applyAnchorInDoc(docA, "foobar", "C"), false);
  assert.equal(JSON.stringify(docA), before, "failed match must not mutate");

  // "foo" lives entirely in the first run -> matches and is marked; the
  // hardBreak node is preserved untouched.
  const docB = make();
  assert.equal(applyAnchorInDoc(docB, "foo", "C"), true);
  const parts = docB.content[0].content;
  assert.equal(parts[0].text, "foo");
  assert.ok(commentMark(parts[0]));
  assert.equal(parts[1].type, "hardBreak", "the inline atom is preserved");
  assert.equal(parts[2].text, "bar");
  assert.equal(commentMark(parts[2]), null);
});

// ---------------------------------------------------------------------------
// A whitespace-only selection normalizes to empty and never anchors.
// ---------------------------------------------------------------------------
test("a whitespace-only selection does not anchor and does not mutate", () => {
  const doc = paragraphDoc([{ type: "text", text: "hello world" }]);
  const before = JSON.stringify(doc);
  assert.equal(canAnchorInDoc(doc, "   "), false);
  assert.equal(applyAnchorInDoc(doc, "   ", "C"), false);
  assert.equal(JSON.stringify(doc), before);
});
