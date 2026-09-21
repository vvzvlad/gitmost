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
  replaceYjsMarkedText,
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

describe('replaceYjsMarkedText', () => {
  // Build a single-paragraph XmlText from runs. Insert the whole string as
  // plain text FIRST, then format only the marked ranges — otherwise text
  // inserted right after a marked run inherits its comment mark (Yjs carries
  // formatting from the left insertion boundary).
  function buildRuns(
    runs: Array<{
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
    text.insert(0, runs.map((r) => r.text).join(''));
    let offset = 0;
    for (const run of runs) {
      if (run.comment) {
        text.format(offset, run.text.length, { comment: run.comment });
      }
      offset += run.text.length;
    }
    return { fragment, text };
  }

  // Two paragraphs, each with its own XmlText, both marked with the same
  // commentId — mirrors a suggestion anchor that got split across blocks.
  function buildTwoParagraphs(
    a: { text: string; comment?: { commentId: string; resolved: boolean } },
    b: { text: string; comment?: { commentId: string; resolved: boolean } },
  ): { fragment: Y.XmlFragment; textA: Y.XmlText; textB: Y.XmlText } {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');
    const build = (seg: typeof a) => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      para.insert(0, [text]);
      text.insert(0, seg.text);
      if (seg.comment) {
        text.format(0, seg.text.length, { comment: seg.comment });
      }
      return { para, text };
    };
    const pa = build(a);
    const pb = build(b);
    fragment.insert(0, [pa.para, pb.para]);
    return { fragment, textA: pa.text, textB: pb.text };
  }

  it('happy path: replaces marked text with newText and keeps the comment mark', () => {
    const { fragment, text } = buildRuns([
      { text: 'Hello ' },
      { text: 'world', comment: { commentId: 'c1', resolved: false } },
      { text: '!' },
    ]);

    const result = replaceYjsMarkedText(fragment, 'c1', 'world', 'planet');

    expect(result).toEqual({ applied: true, currentText: 'planet' });
    // New text carries the SAME comment mark; surrounding text is untouched.
    expect(text.toDelta()).toEqual([
      { insert: 'Hello ' },
      {
        insert: 'planet',
        attributes: { comment: { commentId: 'c1', resolved: false } },
      },
      { insert: '!' },
    ]);
  });

  it('matches by commentId even when the mark is resolved', () => {
    const { fragment, text } = buildWithComments([
      { text: 'foo', comment: { commentId: 'c9', resolved: true } },
    ]);

    const result = replaceYjsMarkedText(fragment, 'c9', 'foo', 'bar');

    expect(result).toEqual({ applied: true, currentText: 'bar' });
    expect(text.toDelta()).toEqual([
      {
        insert: 'bar',
        attributes: { comment: { commentId: 'c9', resolved: true } },
      },
    ]);
  });

  it('changed text: marked text differs from expected → no-op, doc unchanged', () => {
    const { fragment, text } = buildWithComments([
      { text: 'abc', comment: { commentId: 'c1', resolved: false } },
    ]);
    const before = text.toDelta();

    const result = replaceYjsMarkedText(fragment, 'c1', 'expected', 'new');

    expect(result).toEqual({ applied: false, currentText: 'abc' });
    expect(text.toDelta()).toEqual(before);
  });

  // F1 regression: the marked doc text is TYPOGRAPHIC (smart quotes / em-dash)
  // and expectedText equals that raw typographic text — as it now does, because
  // the MCP client stores the RAW anchored substring (getAnchoredText) rather
  // than the agent's ASCII input. The strict `joinedText !== expectedText`
  // compare must therefore MATCH and the suggestion apply (not a spurious 409).
  it('typographic marked text applies when expectedText is the raw typographic text', () => {
    const marked = '“hello”—world';
    const { fragment, text } = buildRuns([
      { text: 'say ' },
      { text: marked, comment: { commentId: 'c1', resolved: false } },
      { text: '!' },
    ]);

    const result = replaceYjsMarkedText(fragment, 'c1', marked, 'bye');

    expect(result).toEqual({ applied: true, currentText: 'bye' });
    expect(text.toDelta()).toEqual([
      { insert: 'say ' },
      {
        insert: 'bye',
        attributes: { comment: { commentId: 'c1', resolved: false } },
      },
      { insert: '!' },
    ]);
  });

  it('anchor deleted: no mark with that commentId → { applied: false, currentText: null }', () => {
    const { fragment, text } = buildWithComments([
      { text: 'abc', comment: { commentId: 'c1', resolved: false } },
    ]);
    const before = text.toDelta();

    const result = replaceYjsMarkedText(fragment, 'missing', 'abc', 'new');

    expect(result).toEqual({ applied: false, currentText: null });
    expect(text.toDelta()).toEqual(before);
  });

  it('paragraph split: same commentId in two XmlText nodes → no-op, doc unchanged', () => {
    const { fragment, textA, textB } = buildTwoParagraphs(
      { text: 'Hello ', comment: { commentId: 'c1', resolved: false } },
      { text: 'world', comment: { commentId: 'c1', resolved: false } },
    );
    const beforeA = textA.toDelta();
    const beforeB = textB.toDelta();

    const result = replaceYjsMarkedText(fragment, 'c1', 'Hello world', 'new');

    expect(result).toEqual({ applied: false, currentText: 'Hello world' });
    expect(textA.toDelta()).toEqual(beforeA);
    expect(textB.toDelta()).toEqual(beforeB);
  });

  it('interleaved unmarked text: marked run not contiguous → no-op, doc unchanged', () => {
    const { fragment, text } = buildRuns([
      { text: 'abc', comment: { commentId: 'c1', resolved: false } },
      { text: 'X' },
      { text: 'def', comment: { commentId: 'c1', resolved: false } },
    ]);
    const before = text.toDelta();

    const result = replaceYjsMarkedText(fragment, 'c1', 'abcdef', 'new');

    // Joined marked text ("abcdef") is returned, but the run is not contiguous.
    expect(result).toEqual({ applied: false, currentText: 'abcdef' });
    expect(text.toDelta()).toEqual(before);
  });

  it('preserves surrounding text and merges adjacent marked segments on apply', () => {
    // The marked run itself is split into two adjacent delta segments; they must
    // be treated as one contiguous run and replaced as a whole.
    const { fragment, text } = buildRuns([
      { text: 'pre ' },
      { text: 'ab', comment: { commentId: 'c1', resolved: false } },
      { text: 'cd', comment: { commentId: 'c1', resolved: false } },
      { text: ' post' },
    ]);

    const result = replaceYjsMarkedText(fragment, 'c1', 'abcd', 'Z');

    expect(result).toEqual({ applied: true, currentText: 'Z' });
    expect(text.toDelta()).toEqual([
      { insert: 'pre ' },
      {
        insert: 'Z',
        attributes: { comment: { commentId: 'c1', resolved: false } },
      },
      { insert: ' post' },
    ]);
  });

  it('embed before the marked run: offset accounts for the embed unit → replaces the right text, embed intact', () => {
    // "AB", then a Yjs embed (1 index unit), then marked "world". Before the
    // fix the embed was skipped WITHOUT advancing offset, so the computed start
    // for "world" was too low by 1 → delete/insert would have hit the embed/text
    // instead of "world", mangling the embed. With the fix offset is correct.
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');
    const para = new Y.XmlElement('paragraph');
    fragment.insert(0, [para]);
    const text = new Y.XmlText();
    para.insert(0, [text]);
    text.insert(0, 'AB');
    text.insertEmbed(2, { image: { src: 'x' } });
    text.insert(3, 'world');
    text.format(3, 'world'.length, {
      comment: { commentId: 'c1', resolved: false },
    });

    const result = replaceYjsMarkedText(fragment, 'c1', 'world', 'planet');

    expect(result).toEqual({ applied: true, currentText: 'planet' });
    // "AB" untouched, embed still present and intact, "world" → "planet"
    // carrying the SAME comment mark.
    expect(text.toDelta()).toEqual([
      { insert: 'AB' },
      { insert: { image: { src: 'x' } } },
      {
        insert: 'planet',
        attributes: { comment: { commentId: 'c1', resolved: false } },
      },
    ]);
  });

  it('embed inside the marked run: embed splits the run → non-contiguous → no-op, doc unchanged', () => {
    // marked "abc", an embed, marked "def" — same commentId. The embed occupies
    // one index unit between the two marked segments, so they are not contiguous
    // → the guard rejects it and nothing is mutated (embed intact).
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');
    const para = new Y.XmlElement('paragraph');
    fragment.insert(0, [para]);
    const text = new Y.XmlText();
    para.insert(0, [text]);
    text.insert(0, 'abc');
    text.insertEmbed(3, { image: { src: 'y' } });
    text.insert(4, 'def');
    text.format(0, 'abc'.length, {
      comment: { commentId: 'c1', resolved: false },
    });
    text.format(4, 'def'.length, {
      comment: { commentId: 'c1', resolved: false },
    });
    const before = text.toDelta();

    const result = replaceYjsMarkedText(fragment, 'c1', 'abcdef', 'new');

    expect(result).toEqual({ applied: false, currentText: 'abcdef' });
    expect(text.toDelta()).toEqual(before);
  });

  // #496: apply must NOT silently strip the replaced run's inline formatting.
  // Build a paragraph and format the marked range with extra marks, then assert
  // the replacement carries them.
  function buildFormatted(
    runs: Array<{ text: string; attrs?: Record<string, any> }>,
  ): { fragment: Y.XmlFragment; text: Y.XmlText } {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');
    const para = new Y.XmlElement('paragraph');
    fragment.insert(0, [para]);
    const text = new Y.XmlText();
    para.insert(0, [text]);
    text.insert(0, runs.map((r) => r.text).join(''));
    let offset = 0;
    for (const run of runs) {
      if (run.attrs) text.format(offset, run.text.length, run.attrs);
      offset += run.text.length;
    }
    return { fragment, text };
  }

  it('preserves the original run formatting (bold + link) on the replacement', () => {
    const { fragment, text } = buildFormatted([
      { text: 'see ' },
      {
        text: 'old',
        attrs: {
          comment: { commentId: 'c1', resolved: false },
          bold: true,
          link: { href: 'https://x.test' },
        },
      },
      { text: ' end' },
    ]);

    const result = replaceYjsMarkedText(fragment, 'c1', 'old', 'new');

    expect(result).toEqual({ applied: true, currentText: 'new' });
    // The comment anchor AND the bold/link marks survive the delete+insert.
    expect(text.toDelta()).toEqual([
      { insert: 'see ' },
      {
        insert: 'new',
        attributes: {
          comment: { commentId: 'c1', resolved: false },
          bold: true,
          link: { href: 'https://x.test' },
        },
      },
      { insert: ' end' },
    ]);
  });

  it('mixed formatting under the mark: replacement takes the DOMINANT (longest) run, NOT the leading one', () => {
    // Leading run is SHORT + plain ("x", 1 char); the following run is LONGER +
    // bold ("bolded", 6 chars), same commentId. The longest run is deliberately
    // NOT first: a "first-wins" pick would carry plain (no bold), so asserting
    // bold on the result only holds if the code genuinely selects the LONGEST run.
    const { fragment, text } = buildFormatted([
      { text: 'x', attrs: { comment: { commentId: 'c1', resolved: false } } },
      {
        text: 'bolded',
        attrs: { comment: { commentId: 'c1', resolved: false }, bold: true },
      },
    ]);

    const result = replaceYjsMarkedText(fragment, 'c1', 'xbolded', 'Z');

    expect(result).toEqual({ applied: true, currentText: 'Z' });
    expect(text.toDelta()).toEqual([
      {
        insert: 'Z',
        attributes: { comment: { commentId: 'c1', resolved: false }, bold: true },
      },
    ]);
  });

  it('mixed formatting under the mark: on a length tie the FIRST run wins', () => {
    // Two equal-length runs (2 chars each) with different formatting, same
    // commentId. The reduce keeps the accumulator on a tie, so the FIRST run
    // (italic) prevails over the later bold one.
    const { fragment, text } = buildFormatted([
      {
        text: 'AA',
        attrs: { comment: { commentId: 'c1', resolved: false }, italic: true },
      },
      {
        text: 'BB',
        attrs: { comment: { commentId: 'c1', resolved: false }, bold: true },
      },
    ]);

    const result = replaceYjsMarkedText(fragment, 'c1', 'AABB', 'Z');

    expect(result).toEqual({ applied: true, currentText: 'Z' });
    expect(text.toDelta()).toEqual([
      {
        insert: 'Z',
        attributes: { comment: { commentId: 'c1', resolved: false }, italic: true },
      },
    ]);
  });
});
