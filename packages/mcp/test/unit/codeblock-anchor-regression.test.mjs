// Full-chain regression for the disappearing-codeBlock incident.
//
// Production chain that destroyed code blocks:
//   1. createComment anchored a comment MARK inside a codeBlock
//      (applyCommentMarkInDoc had no schema awareness);
//   2. applyDocToFragment wrote the poisoned doc into the live Y.Doc
//      (PMNode.fromJSON does not validate marks against parent specs);
//   3. any schema-full materialization (browser ySyncPlugin on page open —
//      initProseMirrorDoc here) hit schema.node('codeBlock', ...) ->
//      createChecked -> validContent -> allowsMarks === false (codeBlock spec
//      `marks: ""`) -> throw -> y-prosemirror's catch DELETED the codeBlock
//      from the shared Y.Doc permanently.
//
// The invariant violated in production, asserted here end-to-end against the
// REAL Y.Doc + schema: after a createComment-style anchoring attempt on
// code-only text and a client materialization, the codeBlock STILL EXISTS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initProseMirrorDoc, yDocToProsemirrorJSON } from "y-prosemirror";

import { docmostSchema } from "../../build/lib/docmost-schema.js";
import { applyCommentMarkInDoc } from "../../build/lib/comment-anchor.js";
import { buildYDoc, applyDocToFragment } from "../../build/lib/collaboration.js";

const PAGE_DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Пишем что-то вроде:" }] },
    {
      type: "codeBlock",
      attrs: { language: "c" },
      content: [
        { type: "text", text: "static bool s_dirty_seen = false;\nint x = 1;" },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ],
};

const countCodeBlocks = (doc) =>
  (doc.content || []).filter((n) => n.type === "codeBlock").length;

test("incident chain: a code-only comment anchor cannot destroy the codeBlock", () => {
  // Sanity: the docmost codeBlock really forbids all marks — the incident's
  // precondition. If this ever changes, the guard derivation adapts with it.
  assert.equal(docmostSchema.nodes.codeBlock.spec.marks, "");

  const ydoc = buildYDoc(PAGE_DOC);
  const live = yDocToProsemirrorJSON(ydoc, "default");
  assert.equal(countCodeBlocks(live), 1, "codeBlock present before the attempt");

  // 1. createComment-style anchoring on text that exists ONLY inside the code
  // block. The root-cause guard refuses (createComment then aborts the write
  // and rolls the comment back), leaving the doc untouched.
  const attempt = structuredClone(live);
  const anchored = applyCommentMarkInDoc(attempt, "s_dirty_seen", {
    type: "comment",
    attrs: { commentId: "test-comment-id", resolved: false },
  });
  assert.equal(anchored, false, "the anchor guard refuses the codeBlock match");
  assert.deepEqual(attempt, live, "the refused attempt leaves the doc unchanged");

  // 2. Materialize like the browser editor does on page open (ySyncPlugin
  // init). In the incident this is the step that deleted the poisoned node.
  initProseMirrorDoc(ydoc.getXmlFragment("default"), docmostSchema);

  // 3. THE invariant: the codeBlock is still in the shared Y.Doc.
  const after = yDocToProsemirrorJSON(ydoc, "default");
  assert.equal(countCodeBlocks(after), 1, "the codeBlock survives materialization");
  assert.match(JSON.stringify(after), /s_dirty_seen/, "code text intact");
});

test("incident chain, guard bypassed: the write path refuses the poison and the Y.Doc stays intact", () => {
  const ydoc = buildYDoc(PAGE_DOC);
  const live = yDocToProsemirrorJSON(ydoc, "default");

  // Hand-splice the mark into the codeBlock, bypassing the anchor guard — the
  // exact doc shape the buggy code used to produce.
  const poisoned = structuredClone(live);
  const cb = poisoned.content.find((n) => n.type === "codeBlock");
  cb.content = [
    { type: "text", text: "static bool " },
    {
      type: "text",
      text: "s_dirty_seen",
      marks: [
        { type: "comment", attrs: { commentId: "test-comment-id", resolved: false } },
      ],
    },
    { type: "text", text: " = false;\nint x = 1;" },
  ];

  // Defense in depth: the write path itself throws instead of poisoning Yjs.
  assert.throws(() => applyDocToFragment(ydoc, poisoned), /codeBlock/);

  // And the shared Y.Doc still materializes with the codeBlock intact.
  initProseMirrorDoc(ydoc.getXmlFragment("default"), docmostSchema);
  const after = yDocToProsemirrorJSON(ydoc, "default");
  assert.equal(countCodeBlocks(after), 1, "the codeBlock survives the refused write");
});
