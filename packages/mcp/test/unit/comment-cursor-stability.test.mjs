import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { applyDocToFragment } from "../../build/lib/collaboration.js";

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
