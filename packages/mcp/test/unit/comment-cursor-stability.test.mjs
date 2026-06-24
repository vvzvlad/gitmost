import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  applyDocToFragment,
  assertYjsEncodable,
} from "../../build/lib/collaboration.js";

// Regression for issue #152: agent writes (comment anchoring especially) must
// NOT yank the open editor's cursor to the end of the document. The cursor is a
// Yjs RelativePosition anchored to node ids; the old write-back deleted the whole
// fragment and rebuilt it, destroying every id, so the position no longer
// resolved. `applyDocToFragment` uses `updateYFragment` (the editor's own diff),
// which keeps unchanged nodes' ids — so a RelativePosition still resolves.

const para = (text, marks) => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
});
const doc = (...paras) => ({ type: "doc", content: paras });

/** The XmlText of the Nth paragraph in the live fragment. */
function paragraphText(ydoc, n) {
  const el = ydoc.getXmlFragment("default").get(n); // <paragraph> XmlElement
  return el.get(0); // its XmlText child
}

test("an UNCHANGED node keeps its Yjs identity across an edit (cursor survives)", () => {
  const ydoc = new Y.Doc();
  applyDocToFragment(ydoc, doc(para("Hello world"), para("Second")));

  // Anchor a cursor at offset 5 inside the FIRST (soon-to-be-unchanged) paragraph.
  const relPos = Y.createRelativePositionFromTypeIndex(paragraphText(ydoc, 0), 5);

  // Edit only the SECOND paragraph; the first is untouched.
  applyDocToFragment(ydoc, doc(para("Hello world"), para("Second edited")));

  const abs = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
  assert.notEqual(abs, null, "the cursor's relative position must still resolve");
  assert.equal(abs.index, 5, "the cursor must stay at the same offset");
  // And the edit actually landed.
  assert.equal(paragraphText(ydoc, 1).toString(), "Second edited");
});

test("anchoring a comment mark keeps the cursor in the marked text (issue #152)", () => {
  const ydoc = new Y.Doc();
  applyDocToFragment(ydoc, doc(para("Hello world")));

  // The user's cursor sits inside the text that is about to be commented.
  const relPos = Y.createRelativePositionFromTypeIndex(paragraphText(ydoc, 0), 3);

  // Agent anchors a comment over "Hello" — text is identical, only a mark added.
  applyDocToFragment(
    ydoc,
    doc({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Hello",
          marks: [
            { type: "comment", attrs: { commentId: "c1", resolved: false } },
          ],
        },
        { type: "text", text: " world" },
      ],
    }),
  );

  // The text is intact (the mark splits "Hello" / " world" but reads the same).
  const para0 = ydoc.getXmlFragment("default").get(0);
  assert.equal(para0.toString().replace(/<[^>]*>/g, ""), "Hello world");

  // ...and the cursor anchored before the write still resolves (did not jump to
  // the document end as it did with the destructive full-replace).
  const abs = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
  assert.notEqual(abs, null, "comment anchoring must not destroy the cursor anchor");
});

// The diagnostic catch branch of applyDocToFragment (#154 review): a doc that
// cannot be hydrated/encoded must be re-thrown wrapped with the stage label, not
// leak the raw ProseMirror/Yjs error. An unknown node type makes
// PMNode.fromJSON (against the docmost schema) throw — a reliable trigger
// (sanitizeForYjs only strips `undefined`, so an undefined attr would be removed
// before it could fail). The hydration now has its OWN try, so the label is the
// accurate stage `fromJSON` (the earlier `updateYFragment` label was misleading).
test("applyDocToFragment wraps a hydration failure with the (fromJSON) diagnostic", () => {
  const ydoc = new Y.Doc();
  const bad = {
    type: "doc",
    content: [{ type: "totally_unknown_node_xyz_12345" }],
  };
  assert.throws(
    () => applyDocToFragment(ydoc, bad),
    /Failed to encode document to Yjs \(fromJSON\)/,
  );
});

// #154 review (suggestion 2): structural-diff edge cases the cursor-survival
// path must handle without losing the unchanged node's id or throwing.

test("deleting a NEIGHBOUR keeps the unchanged node's cursor anchor (diff path)", () => {
  const ydoc = new Y.Doc();
  applyDocToFragment(ydoc, doc(para("Keep me"), para("Delete me")));

  // Anchor inside the first paragraph, which survives the deletion unchanged.
  const relPos = Y.createRelativePositionFromTypeIndex(paragraphText(ydoc, 0), 4);

  // Remove the second paragraph entirely; the first must keep its Yjs identity.
  applyDocToFragment(ydoc, doc(para("Keep me")));

  const abs = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
  assert.notEqual(abs, null, "the surviving node's cursor anchor must still resolve");
  assert.equal(abs.index, 4, "the cursor must stay at the same offset");
  assert.equal(ydoc.getXmlFragment("default").length, 1, "neighbour was deleted");
  assert.equal(paragraphText(ydoc, 0).toString(), "Keep me");
});

test("writing an EMPTY document clears the fragment without throwing", () => {
  const ydoc = new Y.Doc();
  applyDocToFragment(ydoc, doc(para("Something"), para("Else")));
  assert.equal(ydoc.getXmlFragment("default").length, 2);

  assert.doesNotThrow(() =>
    applyDocToFragment(ydoc, { type: "doc", content: [] }),
  );
  assert.equal(
    ydoc.getXmlFragment("default").length,
    0,
    "the fragment is emptied (doc -> empty)",
  );
});

test("changing a top-level node TYPE diffs in place (paragraph -> heading)", () => {
  const ydoc = new Y.Doc();
  applyDocToFragment(ydoc, doc(para("Title text"), para("Body")));

  // Replace the first paragraph with a heading carrying the same text.
  applyDocToFragment(
    ydoc,
    doc(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title text" }] },
      para("Body"),
    ),
  );

  const first = ydoc.getXmlFragment("default").get(0);
  assert.equal(first.nodeName, "heading", "the top-level node type changed");
  assert.equal(first.toString().replace(/<[^>]*>/g, ""), "Title text");
});

// #154 review (suggestion B / architecture B): the dry-run gate now also
// rehearses PMNode.fromJSON, so a doc that fails ONLY in hydration (not in
// toYdoc) is rejected at preview time, with the accurate `fromJSON` label.
test("assertYjsEncodable rejects an un-hydratable doc at preview time (fromJSON gate)", () => {
  const bad = {
    type: "doc",
    content: [{ type: "totally_unknown_node_xyz_67890" }],
  };
  assert.throws(
    () => assertYjsEncodable(bad),
    /Failed to encode document to Yjs/,
  );
});
