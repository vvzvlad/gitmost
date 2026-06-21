import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeForMatch,
  findAnchorInBlock,
  canAnchorInDoc,
  applyAnchorInDoc,
} from "../../build/lib/comment-anchor.js";

const COMMENT_ID = "cmt-123";

/** Find the (single) comment mark on a node, or null. */
function commentMark(node) {
  const marks = Array.isArray(node.marks) ? node.marks : [];
  return marks.find((m) => m && m.type === "comment") || null;
}

/** Build a one-paragraph doc with the given inline content array. */
function paragraphDoc(content) {
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

test("normalizeForMatch maps a normalized char to its first raw index in a whitespace run", () => {
  const { norm, map } = normalizeForMatch("a  b"); // two spaces collapse to one
  assert.equal(norm, "a b");
  // norm[1] is the single space; it maps to the FIRST raw whitespace (index 1).
  assert.equal(map[1], 1);
  assert.equal(map[2], 3); // 'b' is at raw index 3
});

test("simple single-text-node match inserts the comment mark with correct id", () => {
  const doc = paragraphDoc([{ type: "text", text: "Hello brave world" }]);
  const ok = applyAnchorInDoc(doc, "brave", COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  // "Hello " | "brave" | " world"
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, "Hello ");
  assert.equal(commentMark(parts[0]), null);
  assert.equal(parts[1].text, "brave");
  const m = commentMark(parts[1]);
  assert.ok(m, "marked fragment carries a comment mark");
  assert.equal(m.attrs.commentId, COMMENT_ID);
  assert.equal(m.attrs.resolved, false);
  assert.equal(parts[2].text, " world");
  assert.equal(commentMark(parts[2]), null);
});

test("match spanning two adjacent plain text nodes preserves base marks", () => {
  const doc = paragraphDoc([
    { type: "text", text: "запуска ", marks: [{ type: "italic" }] },
    { type: "text", text: "перед блоком", marks: [{ type: "italic" }] },
  ]);
  const ok = applyAnchorInDoc(doc, "запуска перед", COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  // "запуска " (marked) | "перед" (marked) | " блоком" (after)
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, "запуска ");
  assert.equal(parts[1].text, "перед");
  assert.equal(parts[2].text, " блоком");

  // Marked fragments keep the italic base mark AND get exactly one comment mark.
  for (const p of [parts[0], parts[1]]) {
    assert.ok(p.marks.some((m) => m.type === "italic"));
    const cm = p.marks.filter((m) => m.type === "comment");
    assert.equal(cm.length, 1);
    assert.equal(cm[0].attrs.commentId, COMMENT_ID);
  }
  // The trailing fragment keeps its italic mark and has no comment mark.
  assert.ok(parts[2].marks.some((m) => m.type === "italic"));
  assert.equal(commentMark(parts[2]), null);
});

test("match across an inline-code boundary preserves the code mark on the middle fragment", () => {
  const doc = paragraphDoc([
    { type: "text", text: "run " },
    { type: "text", text: "qemu", marks: [{ type: "code" }] },
    { type: "text", text: " now" },
  ]);
  const ok = applyAnchorInDoc(doc, "run qemu now", COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  // All three nodes are fully inside the match -> three marked fragments.
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, "run ");
  assert.equal(parts[1].text, "qemu");
  assert.equal(parts[2].text, " now");

  // Every fragment carries exactly one comment mark.
  for (const p of parts) {
    const cm = p.marks.filter((m) => m.type === "comment");
    assert.equal(cm.length, 1);
    assert.equal(cm[0].attrs.commentId, COMMENT_ID);
  }
  // The middle fragment retains its code mark.
  assert.ok(parts[1].marks.some((m) => m.type === "code"));
});

test("normalization matches smart quotes / em-dash / nbsp / collapsed spaces", () => {
  // Document uses « », an em-dash, a non-breaking space, and a double space.
  const docText = "He said «hello world»  —  done";
  const doc = paragraphDoc([{ type: "text", text: docText }]);

  // Selection typed with ASCII quotes, single spaces and a hyphen.
  const selection = '"hello world" - done';
  assert.equal(canAnchorInDoc(doc, selection), true);

  const ok = applyAnchorInDoc(doc, selection, COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  const marked = parts.filter((p) => commentMark(p));
  assert.equal(marked.length, 1);
  // The marked raw text starts at the « and ends at the trailing "done".
  assert.ok(marked[0].text.startsWith("«hello"));
  assert.ok(marked[0].text.endsWith("done"));
});

test("canAnchorInDoc/applyAnchorInDoc fail (and do not mutate) when selection absent", () => {
  const doc = paragraphDoc([{ type: "text", text: "Hello brave world" }]);
  const snapshot = JSON.stringify(doc);

  assert.equal(canAnchorInDoc(doc, "missing text"), false);
  assert.equal(applyAnchorInDoc(doc, "missing text", COMMENT_ID), false);
  // Document is unchanged after a failed apply.
  assert.equal(JSON.stringify(doc), snapshot);
});

test("before/after fragments retain original marks; marked has exactly one comment mark", () => {
  const doc = paragraphDoc([
    { type: "text", text: "abc def ghi", marks: [{ type: "bold" }] },
  ]);
  const ok = applyAnchorInDoc(doc, "def", COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  assert.equal(parts.length, 3);
  // before "abc " and after " ghi" keep the bold mark, no comment mark.
  assert.deepEqual(parts[0].marks, [{ type: "bold" }]);
  assert.deepEqual(parts[2].marks, [{ type: "bold" }]);
  // marked "def" keeps bold and has exactly one comment mark.
  assert.ok(parts[1].marks.some((m) => m.type === "bold"));
  assert.equal(parts[1].marks.filter((m) => m.type === "comment").length, 1);
});

test("findAnchorInBlock returns child/offset descriptor for a multi-node run", () => {
  const blockContent = [
    { type: "text", text: "ab" },
    { type: "text", text: "cdef" },
  ];
  const match = findAnchorInBlock(blockContent, "bcd");
  assert.deepEqual(match, {
    startChild: 0,
    startOffset: 1,
    endChild: 1,
    endOffset: 2,
  });
});

test("a pre-existing comment mark on matched text is replaced (single comment mark)", () => {
  const doc = paragraphDoc([
    {
      type: "text",
      text: "Hello world",
      marks: [{ type: "comment", attrs: { commentId: "old", resolved: false } }],
    },
  ]);
  const ok = applyAnchorInDoc(doc, "Hello world", COMMENT_ID);
  assert.equal(ok, true);
  const parts = doc.content[0].content;
  assert.equal(parts.length, 1);
  const cm = parts[0].marks.filter((m) => m.type === "comment");
  assert.equal(cm.length, 1);
  assert.equal(cm[0].attrs.commentId, COMMENT_ID);
});

test("anchoring works inside a nested block (e.g. list item) via DFS recursion", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "nested target here" }],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(canAnchorInDoc(doc, "target"), true);
  const ok = applyAnchorInDoc(doc, "target", COMMENT_ID);
  assert.equal(ok, true);
  const para =
    doc.content[0].content[0].content[0].content;
  const marked = para.filter((p) => commentMark(p));
  assert.equal(marked.length, 1);
  assert.equal(marked[0].text, "target");
});
