import { describe, it, expect, vi } from 'vitest';
import { getSchema } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import CodeBlock from '@tiptap/extension-code-block';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { Node as PMNode } from '@tiptap/pm/model';
import { LowlightPlugin } from './lowlight-plugin';

/**
 * #683 `code_highlight` (AC5) — the plugin's onHighlight hook must fire ONLY on a
 * REAL syntax-highlight decoration recompute (init + an edit that affects a code
 * block), and MUST NOT fire on a plain keystroke / cursor move OUTSIDE any code
 * block (the `decorationSet.map(...)` fast-path in `apply`).
 *
 * This drives a real ProseMirror EditorState + the real LowlightPlugin (the
 * observable-property integration test AGENTS #8 requires — a pure-helper unit
 * test would not catch a plugin that times every transaction).
 *
 * NON-VACUITY: the "does NOT fire while typing outside a code block" case is the
 * guard. If the guarded `apply` branch is neutered to always call
 * `runDecorations` (recompute on every transaction), `onHighlight` fires on the
 * paragraph-typing transaction and that assertion reddens.
 */

const CODE_BLOCK_NAME = 'codeBlock';
const schema = getSchema([Document, Paragraph, Text, CodeBlock]);

// Minimal lowlight stub: getDecorations only needs these three callables (the
// plugin's construction guard) and returns no highlight nodes, so decoration
// building is a no-op — we assert the TIMING hook, not the highlight output.
const lowlight = {
  highlight: () => ({ children: [] }),
  highlightAuto: () => ({ data: {}, children: [] }),
  listLanguages: () => [] as string[],
  registered: () => false,
};

function makeState(
  docJson: any,
  onHighlight: (ms: number) => void,
  selectionPos?: number,
): EditorState {
  const doc = PMNode.fromJSON(schema, docJson);
  return EditorState.create({
    doc,
    selection:
      selectionPos != null ? TextSelection.create(doc, selectionPos) : undefined,
    plugins: [
      LowlightPlugin({
        name: CODE_BLOCK_NAME,
        lowlight,
        defaultLanguage: null,
        onHighlight,
      }),
    ],
  });
}

const codeBlockDoc = {
  type: 'doc',
  content: [
    { type: CODE_BLOCK_NAME, content: [{ type: 'text', text: 'hello' }] },
  ],
};

// A code block FOLLOWED by a paragraph: lets us type inside the paragraph while a
// code block exists elsewhere in the doc (the exact AC5 "typing outside code" case
// on a page that has code). Positions: codeBlock [0,4) (content h=1,e=2… 'hi' →
// 1,2), paragraph [4,8) (content a=5,b=6).
const codeBlockThenParagraphDoc = {
  type: 'doc',
  content: [
    { type: CODE_BLOCK_NAME, content: [{ type: 'text', text: 'hi' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'ab' }] },
  ],
};

const paragraphOnlyDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
};

describe('LowlightPlugin onHighlight cadence (#683 AC5)', () => {
  it('fires on plugin init (first decoration build)', () => {
    const onHighlight = vi.fn();
    makeState(codeBlockDoc, onHighlight);
    expect(onHighlight).toHaveBeenCalledTimes(1);
  });

  it('fires on an edit INSIDE a code block (content change)', () => {
    const onHighlight = vi.fn();
    // Selection starts inside the code block (pos 3, within 'hello').
    const state = makeState(codeBlockDoc, onHighlight, 3);
    onHighlight.mockClear(); // ignore the init call

    const next = state.apply(state.tr.insertText('X', 3));
    // Sanity: the edit stayed inside the code block.
    expect(next.selection.$head.parent.type.name).toBe(CODE_BLOCK_NAME);
    expect(onHighlight).toHaveBeenCalledTimes(1);
  });

  it('fires when a code-block node is ADDED (node count changes)', () => {
    const onHighlight = vi.fn();
    // Selection in the paragraph (pos 1), so the recompute is driven by the
    // node-count change, not by the selection touching a code block.
    const state = makeState(paragraphOnlyDoc, onHighlight, 1);
    onHighlight.mockClear();

    const codeNode = schema.nodes[CODE_BLOCK_NAME].createAndFill()!;
    const next = state.apply(state.tr.insert(state.doc.content.size, codeNode));
    expect(next.selection.$head.parent.type.name).toBe('paragraph'); // selection did not move
    expect(onHighlight).toHaveBeenCalledTimes(1);
  });

  // NON-VACUITY ANCHOR — reddens if the guarded apply branch always recomputes.
  it('does NOT fire while typing OUTSIDE any code block (map fast-path)', () => {
    const onHighlight = vi.fn();
    // Selection in the paragraph (pos 6, between a|b) while a code block also
    // exists in the doc — the "typing outside code" AC5 scenario.
    const state = makeState(codeBlockThenParagraphDoc, onHighlight, 6);
    onHighlight.mockClear();

    const next = state.apply(state.tr.insertText('X', 6));
    // Sanity: the edit really happened, outside the code block.
    expect(next.doc.textBetween(5, 8, '')).toContain('X');
    expect(next.selection.$head.parent.type.name).toBe('paragraph');
    expect(onHighlight).not.toHaveBeenCalled();
  });

  it('does NOT fire on a pure cursor move outside a code block (no doc change)', () => {
    const onHighlight = vi.fn();
    const state = makeState(codeBlockThenParagraphDoc, onHighlight, 5);
    onHighlight.mockClear();

    // setSelection only — docChanged is false, so the apply short-circuits to the
    // decoration map without ever recomputing.
    const next = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 6)),
    );
    expect(next.selection.from).toBe(6);
    expect(onHighlight).not.toHaveBeenCalled();
  });

  it('skips timing entirely when no onHighlight callback is provided', () => {
    // Telemetry-off build passes no callback: init and edits must not throw and
    // must not attempt to time (covered by construction + an edit not crashing).
    const doc = PMNode.fromJSON(schema, codeBlockDoc);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3),
      plugins: [
        LowlightPlugin({ name: CODE_BLOCK_NAME, lowlight, defaultLanguage: null }),
      ],
    });
    expect(() => state.apply(state.tr.insertText('Y', 3))).not.toThrow();
  });
});
