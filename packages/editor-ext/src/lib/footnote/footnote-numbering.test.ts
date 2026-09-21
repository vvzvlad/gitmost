import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSchema } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { EditorState } from '@tiptap/pm/state';
import { Node as PMNode } from '@tiptap/pm/model';
import { FootnoteReference } from './footnote-reference';
import { FootnotesList } from './footnotes-list';
import { FootnoteDefinition } from './footnote-definition';
import {
  footnoteNumberingPlugin,
  footnoteNumberingPluginKey,
  getFootnoteNumber,
} from './footnote-numbering';
import {
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTES_LIST_NAME,
  FOOTNOTE_DEFINITION_NAME,
} from './footnote-util';

const extensions = [
  Document,
  Paragraph,
  Text,
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
];

const schema = getSchema(extensions);

function makeState(docJson: any): EditorState {
  return EditorState.create({
    doc: PMNode.fromJSON(schema, docJson),
    plugins: [footnoteNumberingPlugin()],
  });
}

const withTwoFootnotes = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'a' },
        { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'x' } },
        { type: 'text', text: 'b' },
        { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'y' } },
      ],
    },
    {
      type: FOOTNOTES_LIST_NAME,
      content: [
        {
          type: FOOTNOTE_DEFINITION_NAME,
          attrs: { id: 'x' },
          content: [{ type: 'paragraph' }],
        },
        {
          type: FOOTNOTE_DEFINITION_NAME,
          attrs: { id: 'y' },
          content: [{ type: 'paragraph' }],
        },
      ],
    },
  ],
};

describe('footnote numbering plugin — short-circuit (#343 PART 5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does ZERO document traversals on a docChanged transaction when the doc has no footnotes', () => {
    const state = makeState({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    });

    // Only count traversals caused by the transaction, not the initial build.
    const descendantsSpy = vi.spyOn(PMNode.prototype, 'descendants');

    const before = footnoteNumberingPluginKey.getState(state);
    // A real content edit (docChanged) that introduces no footnote node.
    const next = state.apply(state.tr.insertText('!', 3));
    const after = footnoteNumberingPluginKey.getState(next);

    // The plugin never walked the document...
    expect(descendantsSpy).not.toHaveBeenCalled();
    // ...and reused the exact same (empty) state object — proof it short-circuited.
    expect(after).toBe(before);
    expect(after?.hasFootnotes).toBe(false);
  });

  it('rebuilds (numbering appears) the first time a footnote is inserted into a footnote-free doc', () => {
    const state = makeState({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(footnoteNumberingPluginKey.getState(state)?.hasFootnotes).toBe(false);

    const ref = schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: 'x' });
    const next = state.apply(state.tr.insert(3, ref));

    const after = footnoteNumberingPluginKey.getState(next);
    expect(after?.hasFootnotes).toBe(true);
    expect(getFootnoteNumber(next, 'x')).toBe(1);
  });
});

describe('footnote numbering plugin — numbering unchanged with footnotes (#343 PART 5)', () => {
  it('numbers references in document order via the single merged walk', () => {
    const state = makeState(withTwoFootnotes);
    expect(getFootnoteNumber(state, 'x')).toBe(1);
    expect(getFootnoteNumber(state, 'y')).toBe(2);
  });

  it('produces a decoration for every reference and matching definition', () => {
    const state = makeState(withTwoFootnotes);
    const decos = footnoteNumberingPluginKey.getState(state)?.decorations;
    // 2 references + 2 definitions = 4 number decorations.
    expect(decos?.find().length).toBe(4);
  });

  it('keeps numbering current after an edit while footnotes exist', () => {
    const state = makeState(withTwoFootnotes);
    // Insert a NEW reference (id "z") before the others: it must become #1 and
    // shift x -> #2, y -> #3 (deterministic document-order numbering).
    const ref = schema.nodes[FOOTNOTE_REFERENCE_NAME].create({ id: 'z' });
    const next = state.apply(state.tr.insert(1, ref));
    expect(getFootnoteNumber(next, 'z')).toBe(1);
    expect(getFootnoteNumber(next, 'x')).toBe(2);
    expect(getFootnoteNumber(next, 'y')).toBe(3);
  });
});
