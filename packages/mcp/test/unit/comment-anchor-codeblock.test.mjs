// Guard against the disappearing-codeBlock incident: the docmost schema's
// codeBlock forbids ALL marks (`marks: ""`), so anchoring a comment mark inside
// one poisons the Y.Doc — the next schema-full materialization (browser
// ySyncPlugin) throws and y-prosemirror permanently DELETES the whole node.
// Every anchoring entry point must therefore SKIP the own-content match of
// mark-forbidding blocks (recursion into children stays), and the resolver must
// report the code-block cause so createComment can explain the refusal.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canAnchorInDoc,
  applyAnchorInDoc,
  applyCommentMarkInDoc,
  countAnchorMatches,
  getAnchoredText,
  resolveAnchorSelection,
  selectionOnlyInMarkForbiddingBlock,
  regraftResolvedComments,
} from "../../build/lib/comment-anchor.js";

const COMMENT_ID = "cmt-cb-1";

const doc = (...content) => ({ type: "doc", content });
const para = (...content) => ({ type: "paragraph", content });
const text = (t, marks) =>
  marks ? { type: "text", text: t, marks } : { type: "text", text: t };
const codeBlock = (t) => ({
  type: "codeBlock",
  attrs: { language: "c" },
  content: [text(t)],
});

/** Flatten every text node in a doc (deep). */
function textNodes(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "text") out.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) textNodes(c, out);
  return out;
}
/** Text nodes carrying a comment mark. */
function commentMarked(d) {
  return textNodes(d).filter((n) =>
    (Array.isArray(n.marks) ? n.marks : []).some((m) => m && m.type === "comment"),
  );
}

// ---------------------------------------------------------------------------
// (a) A selection that exists ONLY inside a codeBlock anchors nowhere.
// ---------------------------------------------------------------------------
test("a code-only selection is refused by every anchoring entry point", () => {
  const d = doc(
    para(text("Some prose before.")),
    codeBlock("static bool s_dirty_seen = false;\nint x = 1;"),
    para(text("Some prose after.")),
  );
  const snapshot = JSON.parse(JSON.stringify(d));
  const sel = "s_dirty_seen";

  assert.equal(canAnchorInDoc(d, sel), false, "canAnchorInDoc refuses");
  assert.equal(countAnchorMatches(d, sel), 0, "countAnchorMatches sees 0");
  assert.equal(getAnchoredText(d, sel), null, "getAnchoredText yields null");
  assert.equal(
    applyAnchorInDoc(d, sel, COMMENT_ID),
    false,
    "applyAnchorInDoc refuses",
  );
  assert.equal(
    applyCommentMarkInDoc(d, sel, {
      type: "comment",
      attrs: { commentId: COMMENT_ID, resolved: false },
    }),
    false,
    "applyCommentMarkInDoc refuses",
  );
  // The doc is byte-identical after all the refused attempts.
  assert.deepEqual(d, snapshot, "doc unchanged after refused anchoring");
  // The resolver reports WHY: the text exists, but only inside a codeBlock.
  assert.equal(selectionOnlyInMarkForbiddingBlock(d, sel), true);
  const resolved = resolveAnchorSelection(d, sel);
  assert.equal(resolved.found, false);
  assert.equal(resolved.inMarkForbiddingBlock, true);
});

// ---------------------------------------------------------------------------
// (b) When the text occurs in BOTH a codeBlock (first in doc order) and a
// paragraph (later), the anchor lands on the paragraph — never the code block.
// ---------------------------------------------------------------------------
test("anchoring skips an earlier codeBlock occurrence and lands on the paragraph", () => {
  const d = doc(
    codeBlock("let retry_count = 3;"),
    para(text("Set retry_count to a small value.")),
  );
  assert.equal(canAnchorInDoc(d, "retry_count"), true);
  // Only the paragraph occurrence is countable/anchorable.
  assert.equal(countAnchorMatches(d, "retry_count"), 1);
  assert.equal(applyAnchorInDoc(d, "retry_count", COMMENT_ID), true);

  const marked = commentMarked(d);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].text, "retry_count");
  // The codeBlock's own text is untouched (single unmarked text node).
  assert.deepEqual(d.content[0].content, [text("let retry_count = 3;")]);
  // With a real paragraph anchor available, the code-block flag stays unset.
  assert.equal(selectionOnlyInMarkForbiddingBlock(d, "retry_count"), false);
});

// ---------------------------------------------------------------------------
// (c) regraftResolvedComments inherits the guard: a resolved span whose text
// now survives only inside a codeBlock is dropped, not spliced into the code.
// ---------------------------------------------------------------------------
test("regraft drops a resolved span whose text survives only inside a codeBlock", () => {
  const old = doc(
    para(
      text("call "),
      text("init_device()", [
        { type: "comment", attrs: { commentId: "r1", resolved: true } },
      ]),
      text(" early"),
    ),
  );
  // The agent rewrote the prose; the span text now exists only as code.
  const fresh = doc(
    para(text("Totally new prose.")),
    codeBlock("init_device();\nrun();"),
  );
  const out = regraftResolvedComments(old, fresh);
  assert.equal(commentMarked(out).length, 0, "no comment mark anywhere");
  // The codeBlock in the result is intact and unmarked.
  const cb = out.content.find((n) => n.type === "codeBlock");
  assert.deepEqual(cb.content, [text("init_device();\nrun();")]);
});

// ---------------------------------------------------------------------------
// (d) A plain not-found selection does NOT raise the code-block flag.
// ---------------------------------------------------------------------------
test("selectionOnlyInMarkForbiddingBlock is false for a genuinely absent selection", () => {
  const d = doc(para(text("hello world")), codeBlock("const a = 1;"));
  assert.equal(selectionOnlyInMarkForbiddingBlock(d, "not present anywhere"), false);
  const resolved = resolveAnchorSelection(d, "not present anywhere");
  assert.equal(resolved.found, false);
  assert.equal(resolved.inMarkForbiddingBlock, undefined);
});

// ---------------------------------------------------------------------------
// The markdown-strip fallback participates in the flag: a selection that only
// matches inside a codeBlock after stripping markdown is also flagged.
// ---------------------------------------------------------------------------
test("the code-block flag also covers the markdown-stripped selection form", () => {
  const d = doc(para(text("prose")), codeBlock("token_bucket refill"));
  // Verbatim "`token_bucket`" matches nothing; stripped "token_bucket" matches
  // only inside the code block.
  assert.equal(selectionOnlyInMarkForbiddingBlock(d, "`token_bucket`"), true);
  assert.equal(canAnchorInDoc(d, "`token_bucket`"), false);
});
