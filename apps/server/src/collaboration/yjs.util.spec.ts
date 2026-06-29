import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import {
  initProseMirrorDoc,
  absolutePositionToRelativePosition,
  prosemirrorJSONToYDoc,
} from '@tiptap/y-tiptap';
import { tiptapExtensions } from './collaboration.util';
import {
  setYjsMark,
  removeYjsMarkByAttribute,
  updateYjsMarkAttribute,
  type YjsSelection,
} from './yjs.util';

/**
 * Unit tests for the server-side Yjs mark helpers used by the collaboration
 * handler to set/resolve/delete comment marks directly on the shared Y.Doc
 * (collaboration.handler.ts: setCommentMark / resolveCommentMark).
 *
 * The fragment shape mirrors production exactly: a `default` XmlFragment whose
 * children are block XmlElements (paragraph) holding XmlText runs. For setYjsMark
 * the selection is a pair of Yjs RelativePosition JSONs (what the client sends);
 * we synthesize them from known ProseMirror absolute positions via
 * absolutePositionToRelativePosition so the marked range is deterministic.
 */

const schema = getSchema(tiptapExtensions);

// Build a real Y.Doc from ProseMirror JSON (same path the collab handler uses
// via TiptapTransformer) and return the doc + its `default` fragment.
function buildFromPm(pmJson: unknown) {
  const ydoc = prosemirrorJSONToYDoc(
    schema,
    pmJson as never,
    'default',
  ) as unknown as Y.Doc;
  const fragment = ydoc.getXmlFragment('default');
  return { ydoc, fragment };
}

// Make a YjsSelection (anchor/head RelativePosition JSON) for two ProseMirror
// absolute positions in `fragment`.
function selectionFor(
  fragment: Y.XmlFragment,
  anchorPos: number,
  headPos: number,
): YjsSelection {
  const { mapping } = initProseMirrorDoc(fragment, schema);
  const anchor = absolutePositionToRelativePosition(
    anchorPos,
    fragment as never,
    mapping,
  );
  const head = absolutePositionToRelativePosition(
    headPos,
    fragment as never,
    mapping,
  );
  return {
    anchor: Y.relativePositionToJSON(anchor),
    head: Y.relativePositionToJSON(head),
  };
}

// The XmlText run of the i-th top-level paragraph.
function paragraphText(fragment: Y.XmlFragment, index = 0): Y.XmlText {
  const para = fragment.get(index) as Y.XmlElement;
  return para.get(0) as Y.XmlText;
}

// --- raw fragment builder for the remove/update tests (no schema needed) ---
//
// removeYjsMarkByAttribute / updateYjsMarkAttribute only read item.toDelta() and
// call item.format(); they never touch the ProseMirror schema. Build the runs
// directly so we control which segment carries which comment attrs.
function buildWithComments(
  segments: Array<{
    text: string;
    comment?: { commentId: string; resolved: boolean };
  }>,
): { fragment: Y.XmlFragment; text: Y.XmlText } {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('default');
  const para = new Y.XmlElement('paragraph');
  fragment.insert(0, [para]);
  const text = new Y.XmlText();
  para.insert(0, [text]);
  let offset = 0;
  for (const seg of segments) {
    text.insert(offset, seg.text);
    if (seg.comment) {
      text.format(offset, seg.text.length, { comment: seg.comment });
    }
    offset += seg.text.length;
  }
  return { fragment, text };
}

describe('setYjsMark', () => {
  it('applies the mark over exactly the selected sub-range (PM pos 1..6 = "Hello")', () => {
    const { ydoc, fragment } = buildFromPm({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
      ],
    });
    // PM pos 1 = start of the paragraph text; pos 6 = just after "Hello".
    const sel = selectionFor(fragment, 1, 6);

    setYjsMark(ydoc as never, fragment, sel, 'comment', {
      commentId: 'c1',
      resolved: false,
    });

    // The run splits: "Hello" carries the comment mark, " world" stays clean.
    expect(paragraphText(fragment).toDelta()).toEqual([
      {
        insert: 'Hello',
        attributes: { comment: { commentId: 'c1', resolved: false } },
      },
      { insert: ' world' },
    ]);
  });

  it('normalizes a reversed selection (head before anchor) to the same range', () => {
    const { ydoc, fragment } = buildFromPm({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
      ],
    });
    // anchor=6, head=1 — reversed; setYjsMark takes min/max so it marks "Hello".
    const sel = selectionFor(fragment, 6, 1);

    setYjsMark(ydoc as never, fragment, sel, 'comment', {
      commentId: 'c2',
      resolved: false,
    });

    expect(paragraphText(fragment).toDelta()).toEqual([
      {
        insert: 'Hello',
        attributes: { comment: { commentId: 'c2', resolved: false } },
      },
      { insert: ' world' },
    ]);
  });

  it('marks across two paragraphs (range spans an element boundary)', () => {
    const { ydoc, fragment } = buildFromPm({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'aaa' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'bbb' }] },
      ],
    });
    // PM positions: "aaa" = 1..4; the </p><p> boundary consumes pos 4 and 5, so
    // "bbb" starts at pos 6 (chars at 6,7,8). Select pos 2 (inside "aaa") to pos
    // 8 (after the second "b").
    const sel = selectionFor(fragment, 2, 8);

    setYjsMark(ydoc as never, fragment, sel, 'comment', {
      commentId: 'c3',
      resolved: false,
    });

    // First paragraph: "a" clean, "aa" marked.
    expect(paragraphText(fragment, 0).toDelta()).toEqual([
      { insert: 'a' },
      {
        insert: 'aa',
        attributes: { comment: { commentId: 'c3', resolved: false } },
      },
    ]);
    // Second paragraph: "bb" marked, "b" clean.
    expect(paragraphText(fragment, 1).toDelta()).toEqual([
      {
        insert: 'bb',
        attributes: { comment: { commentId: 'c3', resolved: false } },
      },
      { insert: 'b' },
    ]);
  });
});

describe('removeYjsMarkByAttribute', () => {
  it('removes only the run whose attribute value matches, leaving others', () => {
    const { fragment, text } = buildWithComments([
      { text: 'AAA', comment: { commentId: 'c1', resolved: false } },
      { text: 'BBB', comment: { commentId: 'c2', resolved: false } },
    ]);

    removeYjsMarkByAttribute(fragment, 'comment', 'commentId', 'c1');

    // c1's run loses the mark; c2's run is untouched.
    expect(text.toDelta()).toEqual([
      { insert: 'AAA' },
      {
        insert: 'BBB',
        attributes: { comment: { commentId: 'c2', resolved: false } },
      },
    ]);
  });

  it('does nothing when no run carries the requested value (no-match branch)', () => {
    const { fragment, text } = buildWithComments([
      { text: 'AAA', comment: { commentId: 'c1', resolved: false } },
    ]);
    const before = text.toDelta();

    removeYjsMarkByAttribute(fragment, 'comment', 'commentId', 'does-not-exist');

    expect(text.toDelta()).toEqual(before);
  });

  it('leaves a different mark type alone', () => {
    // A run carrying only `bold` must survive a comment removal pass.
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');
    const para = new Y.XmlElement('paragraph');
    fragment.insert(0, [para]);
    const text = new Y.XmlText();
    para.insert(0, [text]);
    text.insert(0, 'XYZ');
    text.format(0, 3, { bold: true });

    removeYjsMarkByAttribute(fragment, 'comment', 'commentId', 'c1');

    expect(text.toDelta()).toEqual([
      { insert: 'XYZ', attributes: { bold: true } },
    ]);
  });
});

describe('updateYjsMarkAttribute', () => {
  it('merges new attributes into the matching run, preserving the rest', () => {
    const { fragment, text } = buildWithComments([
      { text: 'AAA', comment: { commentId: 'c1', resolved: false } },
      { text: 'BBB', comment: { commentId: 'c2', resolved: false } },
    ]);

    updateYjsMarkAttribute(
      fragment,
      'comment',
      { name: 'commentId', value: 'c1' },
      { resolved: true },
    );

    // c1's run flips resolved=true (commentId preserved via merge); c2 untouched.
    expect(text.toDelta()).toEqual([
      {
        insert: 'AAA',
        attributes: { comment: { commentId: 'c1', resolved: true } },
      },
      {
        insert: 'BBB',
        attributes: { comment: { commentId: 'c2', resolved: false } },
      },
    ]);
  });

  it('does nothing when no run matches (no-match branch)', () => {
    const { fragment, text } = buildWithComments([
      { text: 'AAA', comment: { commentId: 'c1', resolved: false } },
    ]);
    const before = text.toDelta();

    updateYjsMarkAttribute(
      fragment,
      'comment',
      { name: 'commentId', value: 'nope' },
      { resolved: true },
    );

    expect(text.toDelta()).toEqual(before);
  });
});
