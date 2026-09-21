import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectResolvedCommentSpans,
  regraftResolvedComments,
  applyCommentMarkInDoc,
} from "../../build/lib/comment-anchor.js";

/**
 * #493 commit 6 — resolved-comment anchors must survive a full markdown rewrite
 * (updatePageMarkdown). An agent read HIDES resolved anchors (#337), so its
 * markdown drops them; a naive full write would erase the resolved comment marks.
 * `regraftResolvedComments(oldDoc, newDoc)` re-anchors them onto the matching
 * text. These exercise the real anchoring (no mock).
 */

const doc = (...content) => ({ type: "doc", content });
const para = (...content) => ({ type: "paragraph", content });
const text = (t, marks) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const resolvedComment = (commentId) => ({ type: "comment", attrs: { commentId, resolved: true } });
const activeComment = (commentId) => ({ type: "comment", attrs: { commentId, resolved: false } });

/** The comment mark on a text node, or null. */
function commentMarkOf(node) {
  const marks = Array.isArray(node?.marks) ? node.marks : [];
  return marks.find((m) => m && m.type === "comment") || null;
}
/** Flatten every text node in a doc (deep). */
function textNodes(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "text") out.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) textNodes(c, out);
  return out;
}

test("collectResolvedCommentSpans: only resolved marks, concatenated across a run", () => {
  const old = doc(
    para(
      text("keep "),
      text("resolved bit", [resolvedComment("r1")]),
      text(" and "),
      text("active bit", [activeComment("a1")]),
    ),
  );
  const spans = collectResolvedCommentSpans(old);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].commentId, "r1");
  assert.equal(spans[0].text, "resolved bit");
  assert.equal(spans[0].mark.attrs.resolved, true);
});

test("regraft restores a resolved mark the agent's markdown dropped", () => {
  // OLD doc has a resolved comment on "important note".
  const old = doc(para(text("An "), text("important note", [resolvedComment("r1")]), text(" here.")));
  // NEW doc (re-imported from the agent's markdown) has the SAME text but NO
  // comment mark — the resolved anchor was hidden on read.
  const fresh = doc(para(text("An important note here.")));

  const out = regraftResolvedComments(old, fresh);
  // Inputs are not mutated.
  assert.equal(commentMarkOf(textNodes(fresh)[0]), null);
  // The resolved mark is back on exactly "important note".
  const marked = textNodes(out).filter((n) => commentMarkOf(n));
  assert.equal(marked.length, 1);
  assert.equal(marked[0].text, "important note");
  assert.equal(commentMarkOf(marked[0]).attrs.commentId, "r1");
  assert.equal(commentMarkOf(marked[0]).attrs.resolved, true);
});

test("a resolved span whose text the agent changed is dropped (no re-anchor)", () => {
  const old = doc(para(text("stale text", [resolvedComment("r1")])));
  const fresh = doc(para(text("completely rewritten body")));
  const out = regraftResolvedComments(old, fresh);
  assert.equal(textNodes(out).filter((n) => commentMarkOf(n)).length, 0);
});

test("regraft is a no-op when the old doc has no resolved comments", () => {
  const old = doc(para(text("plain "), text("active", [activeComment("a1")])));
  const fresh = doc(para(text("plain active")));
  const out = regraftResolvedComments(old, fresh);
  assert.equal(textNodes(out).filter((n) => commentMarkOf(n)).length, 0);
});

test("multiple distinct resolved comments are all restored", () => {
  const old = doc(
    para(text("first", [resolvedComment("r1")]), text(" middle "), text("second", [resolvedComment("r2")])),
  );
  const fresh = doc(para(text("first middle second")));
  const out = regraftResolvedComments(old, fresh);
  const byId = Object.fromEntries(
    textNodes(out)
      .filter((n) => commentMarkOf(n))
      .map((n) => [commentMarkOf(n).attrs.commentId, n.text]),
  );
  assert.equal(byId["r1"], "first");
  assert.equal(byId["r2"], "second");
});

test("applyCommentMarkInDoc preserves an arbitrary mark's attrs (resolved:true)", () => {
  const d = doc(para(text("anchor me somewhere")));
  const ok = applyCommentMarkInDoc(d, "anchor me", { type: "comment", attrs: { commentId: "x9", resolved: true } });
  assert.equal(ok, true);
  const marked = textNodes(d).filter((n) => commentMarkOf(n));
  assert.equal(marked[0].text, "anchor me");
  assert.equal(commentMarkOf(marked[0]).attrs.resolved, true);
});

// #555 (review of #514) — two DISTINCT resolved anchors on IDENTICAL text used to
// both land on occurrence #0, and the second comment mark was silently dropped at
// toYdoc (a span can carry only one comment mark). The regraft now spreads them
// over DISTINCT occurrences, and surfaces an unavoidable drop through the sink.

test("two distinct resolved comments on identical text land on distinct occurrences (both survive)", () => {
  // OLD: the word "note" is commented twice, in two different places.
  const old = doc(
    para(text("a "), text("note", [resolvedComment("r1")]), text(" here")),
    para(text("b "), text("note", [resolvedComment("r2")]), text(" there")),
  );
  // NEW: the agent's markdown dropped both anchors, but "note" occurs twice.
  const fresh = doc(para(text("a note here")), para(text("b note there")));

  const warnings = [];
  const out = regraftResolvedComments(old, fresh, (w) => warnings.push(w));

  // BOTH comment marks are present, on DISTINCT text nodes, one per occurrence.
  const marked = textNodes(out).filter((n) => commentMarkOf(n));
  assert.equal(marked.length, 2, "both anchors must survive");
  assert.deepEqual(
    marked.map((n) => n.text),
    ["note", "note"],
  );
  const ids = marked.map((n) => commentMarkOf(n).attrs.commentId).sort();
  assert.deepEqual(ids, ["r1", "r2"], "both comment ids attach");
  assert.equal(warnings.length, 0, "no drop → no warning");
});

test("more identical-text anchors than occurrences → unavoidable drop warns via the sink", () => {
  // TWO distinct resolved comments on "gamma", but the rewritten body keeps only
  // ONE "gamma": one anchor cannot be placed (a span holds one comment mark).
  const old = doc(
    para(text("gamma", [resolvedComment("g1")])),
    para(text("gamma", [resolvedComment("g2")])),
  );
  const fresh = doc(para(text("only one gamma now")));

  const warnings = [];
  const out = regraftResolvedComments(old, fresh, (w) => warnings.push(w));

  const marked = textNodes(out).filter((n) => commentMarkOf(n));
  assert.equal(marked.length, 1, "exactly one anchor fits");
  assert.equal(warnings.length, 1, "the un-graftable anchor is surfaced");
  assert.equal(warnings[0].code, "collision");
  assert.ok(["g1", "g2"].includes(warnings[0].commentId));
  assert.equal(warnings[0].text, "gamma");
});

test("a non-matching resolved anchor emits a no-match warning in the sink", () => {
  const old = doc(para(text("stale text", [resolvedComment("r1")])));
  const fresh = doc(para(text("completely rewritten body")));

  const warnings = [];
  const out = regraftResolvedComments(old, fresh, (w) => warnings.push(w));

  assert.equal(textNodes(out).filter((n) => commentMarkOf(n)).length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "no-match");
  assert.equal(warnings[0].commentId, "r1");
  assert.equal(warnings[0].text, "stale text");
});

test("regraft without a sink stays silent (backwards compatible)", () => {
  const old = doc(para(text("gone", [resolvedComment("r1")])));
  const fresh = doc(para(text("nothing to see")));
  // No sink argument: must not throw, and drops the anchor as before.
  const out = regraftResolvedComments(old, fresh);
  assert.equal(textNodes(out).filter((n) => commentMarkOf(n)).length, 0);
});

// #603 guard interaction — the free-occurrence search must never place a comment
// mark inside a mark-forbidding block (a codeBlock), where a materialized comment
// mark would make y-prosemirror delete the whole node (permanent data loss).
const codeBlock = (t) => ({ type: "codeBlock", content: [text(t)] });

test("resolved anchor whose text now lives only in a codeBlock is NOT grafted there (no-match warning)", () => {
  const old = doc(para(text("run this", [resolvedComment("r1")])));
  // The agent moved the text into a code block; a comment mark may not live there.
  const fresh = doc(codeBlock("run this"));

  const warnings = [];
  const out = regraftResolvedComments(old, fresh, (w) => warnings.push(w));

  // Nothing marked anywhere (the codeBlock is never anchored).
  assert.equal(textNodes(out).filter((n) => commentMarkOf(n)).length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "no-match");
  assert.equal(warnings[0].commentId, "r1");
});

test("identical text in an EARLIER codeBlock is skipped; the anchor lands on the later paragraph", () => {
  const old = doc(para(text("total", [resolvedComment("r1")])));
  // "total" occurs first inside a codeBlock (document order), then in a paragraph.
  const fresh = doc(codeBlock("total"), para(text("total")));

  const warnings = [];
  const out = regraftResolvedComments(old, fresh, (w) => warnings.push(w));

  const marked = textNodes(out).filter((n) => commentMarkOf(n));
  assert.equal(marked.length, 1, "exactly one mark, in the allowed block");
  assert.equal(marked[0].text, "total");
  assert.equal(commentMarkOf(marked[0]).attrs.commentId, "r1");
  // The marked node must be the paragraph's text, NOT the codeBlock's.
  const codeText = out.content[0].content[0];
  assert.equal(commentMarkOf(codeText), null, "codeBlock text stays unmarked");
  assert.equal(warnings.length, 0, "placed successfully → no warning");
});
