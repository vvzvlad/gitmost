import { describe, it, expect } from 'vitest';
import { Editor, Extension, getSchema } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { Superscript } from '@tiptap/extension-superscript';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { FootnoteReference } from './footnote-reference';
import { FootnotesList } from './footnotes-list';
import { FootnoteDefinition } from './footnote-definition';
import { TrailingNode } from '../trailing-node';
import { footnoteSyncPlugin } from './footnote-sync';
import { getFootnoteNumber, getFootnoteRefCount } from './footnote-numbering';
import {
  computeFootnoteNumbers,
  computeFootnoteRefCounts,
  collectReferenceIds,
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

function makeEditor(content?: any) {
  return new Editor({
    extensions,
    content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
  });
}

function countType(doc: PMNode, name: string): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === name) n++;
  });
  return n;
}

describe('footnote numbering (pure function)', () => {
  it('numbers references in document order', () => {
    const schema = getSchema(extensions);
    const doc = PMNode.fromJSON(schema, {
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
    });

    expect(collectReferenceIds(doc)).toEqual(['x', 'y']);
    const numbers = computeFootnoteNumbers(doc);
    expect(numbers.get('x')).toBe(1);
    expect(numbers.get('y')).toBe(2);
  });

  it('counts reference occurrences per id (reuse), one number per id (#168)', () => {
    const schema = getSchema(extensions);
    // `a` is referenced 3 times, `b` once. Reuse: one number each, 3 vs 1 links.
    const doc = PMNode.fromJSON(schema, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
            { type: 'text', text: ' x ' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'b' } },
            { type: 'text', text: ' y ' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
            { type: 'text', text: ' z ' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'a' },
              content: [{ type: 'paragraph' }],
            },
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'b' },
              content: [{ type: 'paragraph' }],
            },
          ],
        },
      ],
    });

    const numbers = computeFootnoteNumbers(doc);
    expect(numbers.get('a')).toBe(1);
    expect(numbers.get('b')).toBe(2);

    const counts = computeFootnoteRefCounts(doc);
    expect(counts.get('a')).toBe(3);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('missing')).toBeUndefined();
  });
});

describe('getFootnoteRefCount (cached, live editor)', () => {
  it('returns the live occurrence count and 0 for an unknown id', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
            { type: 'text', text: ' and ' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'a' },
              content: [{ type: 'paragraph' }],
            },
          ],
        },
      ],
    });

    expect(getFootnoteRefCount(editor.state, 'a')).toBe(2);
    expect(getFootnoteRefCount(editor.state, 'nope')).toBe(0);
    editor.destroy();
  });

  // #185 re-review pt 9: the cached count must update on a doc change (mirror of
  // the number-cache invalidation test) — add another `[^a]` reference and the
  // count goes 2 -> 3.
  it('recomputes the cached ref count when a reference is added', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
            { type: 'text', text: ' and ' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'a' },
              content: [{ type: 'paragraph' }],
            },
          ],
        },
      ],
    });
    expect(getFootnoteRefCount(editor.state, 'a')).toBe(2);

    // Insert a THIRD reference to `a` at the start of the first paragraph.
    const refType = editor.schema.nodes[FOOTNOTE_REFERENCE_NAME];
    editor.view.dispatch(
      editor.state.tr.insert(1, refType.create({ id: 'a' })),
    );

    expect(getFootnoteRefCount(editor.state, 'a')).toBe(3);
    editor.destroy();
  });
});

// #185 re-review pt 6: scrollToReference picks the index-th occurrence among the
// reused references, falls back to the first for an out-of-range index, and is a
// no-op (false) for an empty id. Runs the REAL command against the editor's DOM
// (scrollIntoView is stubbed — jsdom does not implement it).
describe('scrollToReference command (occurrence selection + fallback)', () => {
  it('selects the index-th occurrence, falls back to the first, false for empty id', () => {
    const scrolled: Element[] = [];
    const original = (Element.prototype as any).scrollIntoView;
    (Element.prototype as any).scrollIntoView = function () {
      scrolled.push(this as Element);
    };
    try {
      const editor = makeEditor({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
              { type: 'text', text: ' x ' },
              { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
              { type: 'text', text: ' y ' },
              { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
            ],
          },
          {
            type: FOOTNOTES_LIST_NAME,
            content: [
              {
                type: FOOTNOTE_DEFINITION_NAME,
                attrs: { id: 'a' },
                content: [{ type: 'paragraph' }],
              },
            ],
          },
        ],
      });
      const sups = editor.view.dom.querySelectorAll(
        'sup[data-footnote-ref][data-id="a"]',
      );
      expect(sups.length).toBe(3);

      // index 1 -> the SECOND occurrence.
      expect(editor.commands.scrollToReference('a', 1)).toBe(true);
      expect(scrolled[scrolled.length - 1]).toBe(sups[1]);

      // out-of-range index -> falls back to the FIRST occurrence.
      expect(editor.commands.scrollToReference('a', 99)).toBe(true);
      expect(scrolled[scrolled.length - 1]).toBe(sups[0]);

      // default index (0) -> first.
      expect(editor.commands.scrollToReference('a')).toBe(true);
      expect(scrolled[scrolled.length - 1]).toBe(sups[0]);

      // empty id -> false, no scroll.
      const before = scrolled.length;
      expect(editor.commands.scrollToReference('')).toBe(false);
      expect(scrolled.length).toBe(before);

      editor.destroy();
    } finally {
      (Element.prototype as any).scrollIntoView = original;
    }
  });

  // #185 auto-review pt 2: a NON-empty id that renders ZERO references — the real
  // desync where the definition still exists but its inline ref was removed from
  // the DOM. querySelectorAll returns 0 matches, so `matches[index] ?? matches[0]`
  // is undefined and the command must bail with `false` (not throw, not scroll).
  it('returns false for a non-empty id with no rendered references', () => {
    const scrolled: Element[] = [];
    const original = (Element.prototype as any).scrollIntoView;
    (Element.prototype as any).scrollIntoView = function () {
      scrolled.push(this as Element);
    };
    try {
      // A lone definition for id 'ghost' and a reference for a DIFFERENT id, so
      // there is a footnotes structure but no `sup[data-id="ghost"]` in the DOM.
      const editor = makeEditor({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'other' } },
            ],
          },
          {
            type: FOOTNOTES_LIST_NAME,
            content: [
              {
                type: FOOTNOTE_DEFINITION_NAME,
                attrs: { id: 'ghost' },
                content: [{ type: 'paragraph' }],
              },
            ],
          },
        ],
      });
      expect(
        editor.view.dom.querySelectorAll(
          'sup[data-footnote-ref][data-id="ghost"]',
        ).length,
      ).toBe(0);

      expect(editor.commands.scrollToReference('ghost')).toBe(false);
      expect(scrolled.length).toBe(0);

      editor.destroy();
    } finally {
      (Element.prototype as any).scrollIntoView = original;
    }
  });
});

describe('setFootnote command', () => {
  it('inserts a reference and a matching definition in the footnotes list', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
      ],
    });
    // Cursor at end of the word.
    editor.commands.setTextSelection(6);
    const ok = editor.commands.setFootnote();
    expect(ok).toBe(true);

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_REFERENCE_NAME)).toBe(1);
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(1);

    // The reference id and the definition id match.
    let refId: string | null = null;
    let defId: string | null = null;
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_REFERENCE_NAME) refId = node.attrs.id;
      if (node.type.name === FOOTNOTE_DEFINITION_NAME) defId = node.attrs.id;
    });
    expect(refId).toBeTruthy();
    expect(refId).toBe(defId);
    editor.destroy();
  });

  it('inserts the definition at the correct position matching reference order', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'AAAA' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'BBBB' }] },
      ],
    });

    // First footnote: place inside the SECOND paragraph (after "BBBB").
    editor.commands.setTextSelection(11); // end of BBBB
    editor.commands.setFootnote();

    // Second footnote: place inside the FIRST paragraph (after "AAAA"),
    // which is BEFORE the first reference in document order.
    editor.commands.setTextSelection(5); // end of AAAA
    editor.commands.setFootnote();

    const doc = editor.state.doc;
    // Reference order in document.
    const refOrder = collectReferenceIds(doc);
    // Definition order in the list.
    const defOrder: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_DEFINITION_NAME) {
        defOrder.push(node.attrs.id);
      }
    });

    expect(defOrder).toEqual(refOrder);
    expect(defOrder.length).toBe(2);
    editor.destroy();
  });
});

describe('removeFootnote command (cascade)', () => {
  it('removes both the reference and its definition, and drops the empty list', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
      ],
    });
    editor.commands.setTextSelection(6);
    editor.commands.setFootnote();

    let id: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_REFERENCE_NAME) id = node.attrs.id;
    });
    expect(id).toBeTruthy();

    editor.commands.removeFootnote(id!);

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_REFERENCE_NAME)).toBe(0);
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(0);
    // empty list removed
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(0);
    editor.destroy();
  });
});

describe('footnote sync plugin (orphans)', () => {
  it('creates an empty definition for a reference pasted without one', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'orphan-ref' } },
          ],
        },
      ],
    });
    // Trigger a doc change so appendTransaction runs.
    editor.commands.insertContentAt(1, ' ');

    const doc = editor.state.doc;
    let defFound = false;
    doc.descendants((node) => {
      if (
        node.type.name === FOOTNOTE_DEFINITION_NAME &&
        node.attrs.id === 'orphan-ref'
      ) {
        defFound = true;
      }
    });
    expect(defFound).toBe(true);
    editor.destroy();
  });

  it('merges multiple footnotesList nodes into one, preserving all definitions, as the last child', () => {
    const editor = makeEditor({
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
        // First (stray) footnotes list, e.g. from a paste/collab merge.
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'x' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'X note' }],
                },
              ],
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'tail' }] },
        // Second footnotes list (the "real" trailing one).
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'y' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Y note' }],
                },
              ],
            },
          ],
        },
      ],
    });
    // Trigger a local doc change so appendTransaction runs.
    editor.commands.insertContentAt(1, ' ');

    const doc = editor.state.doc;
    // Converged to exactly ONE list.
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    // Both definitions preserved (no tracking lost).
    const defIds: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_DEFINITION_NAME)
        defIds.push(node.attrs.id);
    });
    expect(defIds.sort()).toEqual(['x', 'y']);
    // The single list is the LAST child of the document.
    const lastChild = doc.child(doc.childCount - 1);
    expect(lastChild.type.name).toBe(FOOTNOTES_LIST_NAME);
    editor.destroy();
  });

  it('leaves a correct doc (single trailing list) unchanged — no merge loop', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'x' } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'x' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'X note' }],
                },
              ],
            },
          ],
        },
      ],
    });
    const before = editor.state.doc.toJSON();
    // A change that doesn't touch footnote structure.
    editor.commands.insertContentAt(1, 'z');
    const doc = editor.state.doc;
    // Still exactly one list, still last, definition preserved.
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    const lastChild = doc.child(doc.childCount - 1);
    expect(lastChild.type.name).toBe(FOOTNOTES_LIST_NAME);
    // The footnotes list subtree is identical to before (no spurious rewrite).
    const beforeList = before.content.find(
      (n: any) => n.type === FOOTNOTES_LIST_NAME,
    );
    const afterList = doc
      .toJSON()
      .content.find((n: any) => n.type === FOOTNOTES_LIST_NAME);
    expect(afterList).toEqual(beforeList);
    editor.destroy();
  });

  it('repeated references REUSE one footnote; a duplicate definition is dropped (first-wins)', () => {
    // Reuse semantics (#166): two references with id "d" are the SAME footnote
    // (one number, shared definition) — they are NEVER re-id'd. Two definitions
    // sharing id "d" are first-wins: the first keeps "d", the second is re-id'd
    // to a deterministic orphan id and then dropped by the orphan policy (it has
    // no matching reference). So the result is ONE reused footnote on "first".
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'd' } },
            { type: 'text', text: 'b' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'd' } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'd' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'first' }],
                },
              ],
            },
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'd' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'second' }],
                },
              ],
            },
          ],
        },
      ],
    });
    // The first local keystroke fires the sync plugin's appendTransaction.
    editor.commands.insertContentAt(1, ' ');

    const doc = editor.state.doc;
    // One shared definition survives (first-wins); the duplicate is dropped.
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(1);
    const defTexts: string[] = [];
    const defIds: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_DEFINITION_NAME) {
        defIds.push(node.attrs.id);
        defTexts.push(node.textContent);
      }
    });
    expect(defTexts).toEqual(['first']);
    expect(defIds).toEqual(['d']);
    // Both references keep id "d" (reuse — not re-id'd).
    const refIds: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_REFERENCE_NAME)
        refIds.push(node.attrs.id);
    });
    expect(refIds).toEqual(['d', 'd']);
    editor.destroy();
  });

  it('reuse outcome is DETERMINISTIC across clients (Yjs convergence)', () => {
    // Cross-client determinism guard. Two collaborating clients each see the
    // SAME document and make a local edit; the sync plugin runs identically, so
    // the resolved state MUST be identical (else they diverge over Yjs). Under
    // reuse the three "d" references collapse to one footnote and the duplicate
    // definitions are dropped (first-wins) — deterministically on every client.
    const duplicateDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'd' } },
            { type: 'text', text: 'b' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'd' } },
            { type: 'text', text: 'c' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'd' } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'd' },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
              ],
            },
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'd' },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
              ],
            },
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'd' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'three' }],
                },
              ],
            },
          ],
        },
      ],
    };

    const idsAfterLocalEdit = () => {
      // A fresh editor instance = an independent "client" running the same
      // plugin pipeline on the same starting document.
      const editor = makeEditor(structuredClone(duplicateDoc));
      editor.commands.insertContentAt(1, ' '); // local keystroke -> sync runs
      const refIds: string[] = [];
      const defIds: string[] = [];
      const defTexts: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === FOOTNOTE_REFERENCE_NAME)
          refIds.push(node.attrs.id);
        if (node.type.name === FOOTNOTE_DEFINITION_NAME) {
          defIds.push(node.attrs.id);
          defTexts.push(node.textContent);
        }
      });
      editor.destroy();
      return { refIds, defIds, defTexts };
    };

    const clientA = idsAfterLocalEdit();
    const clientB = idsAfterLocalEdit();

    // Both clients resolved to IDENTICAL state (the Yjs-convergence property).
    expect(clientA).toEqual(clientB);
    // Reuse: the three references stay "d"; one definition survives (first-wins).
    expect(clientA.refIds).toEqual(['d', 'd', 'd']);
    expect(clientA.defIds).toEqual(['d']);
    expect(clientA.defTexts).toEqual(['one']);
  });

  it('removes an orphan definition with no matching reference', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'orphan-def' },
              content: [{ type: 'paragraph' }],
            },
          ],
        },
      ],
    });
    editor.commands.insertContentAt(1, 'y');

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(0);
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(0);
    editor.destroy();
  });
});

/**
 * Live-editor regression tests for the sync-plugin infinite loop (the hard
 * freeze when activating /footnote). These drive a REAL Tiptap editor through
 * the same plugin pipeline the browser uses — including the TrailingNode plugin,
 * which is what turned the "move list to the end" pass into an infinite
 * ping-pong (list moved last -> trailing paragraph appended after it -> list no
 * longer last -> moved again -> ...).
 *
 * If the loop regresses, ProseMirror's appendTransaction round loop never
 * terminates and these tests HANG (the vitest timeout fails them). The
 * transaction counter additionally fails fast with a bounded iteration cap, so
 * a regression surfaces as an explicit error instead of only a slow timeout.
 */
describe('footnote sync plugin (no infinite loop — live editor)', () => {
  // Hard cap on how many doc-changing appendTransaction rounds we tolerate for a
  // single user action. Convergence takes a couple of rounds at most; anything
  // approaching this means the plugins are oscillating.
  const MAX_ROUNDS = 50;

  // The production editor wires FootnoteReference alongside TrailingNode and
  // Superscript; both participate in the loop the bug exhibited, so we mirror
  // that here.
  function makeLiveEditor(content?: any) {
    let rounds = 0;
    // A guard plugin that counts doc-changing appendTransaction rounds and
    // throws if they exceed the cap, converting a would-be infinite loop into a
    // deterministic failure instead of a wall-clock hang.
    const LoopGuard = Extension.create({
      name: 'footnoteLoopGuard',
      // Run last so it observes every other plugin's appended transaction.
      priority: -1000,
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: new PluginKey('footnoteLoopGuard'),
            appendTransaction(transactions) {
              if (transactions.some((t) => t.docChanged)) {
                rounds += 1;
                if (rounds > MAX_ROUNDS) {
                  throw new Error(
                    `footnote sync did not converge: exceeded ${MAX_ROUNDS} appendTransaction rounds (infinite loop)`,
                  );
                }
              }
              return null;
            },
          }),
        ];
      },
    });

    const editor = new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        Superscript,
        TrailingNode,
        LoopGuard,
        FootnoteReference,
        FootnotesList,
        FootnoteDefinition,
      ],
      content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    return { editor, getRounds: () => rounds, resetRounds: () => (rounds = 0) };
  }

  function lastFootnotesListIsTrailing(doc: PMNode): boolean {
    // Canonical placement: the list is the last meaningful block — only empty
    // paragraphs (the trailing-node) may follow it.
    let listIndex = -1;
    for (let i = 0; i < doc.childCount; i++) {
      if (doc.child(i).type.name === FOOTNOTES_LIST_NAME) listIndex = i;
    }
    if (listIndex === -1) return false;
    for (let i = listIndex + 1; i < doc.childCount; i++) {
      const child = doc.child(i);
      if (!(child.type.name === 'paragraph' && child.content.size === 0)) {
        return false;
      }
    }
    return true;
  }

  it('setFootnote() RETURNS (no hang) and produces one ref + one def in a trailing list', () => {
    const { editor } = makeLiveEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    });
    editor.commands.setTextSelection(3);
    const ok = editor.commands.setFootnote();
    expect(ok).toBe(true);

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_REFERENCE_NAME)).toBe(1);
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(1);
    expect(lastFootnotesListIsTrailing(doc)).toBe(true);
    editor.destroy();
  });

  it('a second setFootnote() does not hang: two refs + two defs in one list', () => {
    const { editor } = makeLiveEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    });
    editor.commands.setTextSelection(3);
    editor.commands.setFootnote();
    editor.commands.setTextSelection(3);
    editor.commands.setFootnote();

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTE_REFERENCE_NAME)).toBe(2);
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(2);
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    expect(lastFootnotesListIsTrailing(doc)).toBe(true);
    editor.destroy();
  });

  it('converges and stabilizes: an unrelated edit does not keep producing transactions', () => {
    const { editor, getRounds, resetRounds } = makeLiveEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    });
    editor.commands.setTextSelection(3);
    editor.commands.setFootnote();

    // Now the doc is canonical. Dispatch an unrelated edit (insert text) and
    // assert the sync plugin converges in a bounded number of rounds and the
    // document is stable (one ref/def/list, list trailing).
    resetRounds();
    editor.commands.insertContentAt(1, 'Z');
    const afterFirst = editor.state.doc.toJSON();
    const roundsAfterEdit = getRounds();
    expect(roundsAfterEdit).toBeLessThan(MAX_ROUNDS);

    // A follow-up no-op-ish edit must not re-trigger structural rewrites: the
    // footnotes section is identical before and after a further unrelated edit.
    editor.commands.insertContentAt(2, 'Y');
    const afterSecond = editor.state.doc.toJSON();

    const listOf = (json: any) =>
      json.content.find((n: any) => n.type === FOOTNOTES_LIST_NAME);
    expect(listOf(afterSecond)).toEqual(listOf(afterFirst));
    expect(countType(editor.state.doc, FOOTNOTES_LIST_NAME)).toBe(1);
    editor.destroy();
  });

  it('two footnotesList nodes converge to one (merge) without looping', () => {
    const { editor } = makeLiveEditor({
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
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'X' }] },
              ],
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'tail' }] },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'y' },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Y' }] },
              ],
            },
          ],
        },
      ],
    });
    // Trigger a local doc change so appendTransaction runs (must not hang).
    editor.commands.insertContentAt(1, ' ');

    const doc = editor.state.doc;
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    const defIds: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_DEFINITION_NAME)
        defIds.push(node.attrs.id);
    });
    expect(defIds.sort()).toEqual(['x', 'y']);
    expect(lastFootnotesListIsTrailing(doc)).toBe(true);
    editor.destroy();
  });
});

/**
 * Data-loss-window regression guard (Fix 1). A pure reference REORDER must not
 * cause the sync plugin to delete-and-recreate any definition subtree — doing so
 * (the previous behaviour) would, through Yjs, replace the CRDT subtree of every
 * definition and could lose a collaborator's in-flight characters on merge.
 *
 * Numbering is decoration-only (footnote-numbering.ts derives numbers from
 * reference order), so the bottom list's PHYSICAL order need not match reference
 * order for the displayed numbers to be correct. We therefore assert: the
 * existing definition NODE INSTANCES are preserved (identity-equal) after the
 * sync pass, AND the derived numbers follow the new reference order.
 */
describe('footnote sync plugin (no rebuild on reorder — data-loss guard)', () => {
  function reorderedDoc() {
    // The "out of order" end-state of a reorder: references occur as [b, a] but
    // the bottom list still physically holds definitions in [a, b] order. This
    // is exactly the situation a reference reorder produces (decoration-only
    // numbering keeps the displayed numbers correct without physically moving
    // the definition subtrees). The sync plugin must leave the definitions
    // ALONE here — no delete/recreate of any definition subtree.
    return {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'p' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'b' } },
            { type: 'text', text: 'q' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'a' } },
          ],
        },
        {
          type: FOOTNOTES_LIST_NAME,
          content: [
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'a' },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
              ],
            },
            {
              type: FOOTNOTE_DEFINITION_NAME,
              attrs: { id: 'b' },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
              ],
            },
          ],
        },
      ],
    };
  }

  function getDefNodesById(doc: PMNode): Map<string, PMNode> {
    const m = new Map<string, PMNode>();
    doc.descendants((node) => {
      if (node.type.name === FOOTNOTE_DEFINITION_NAME)
        m.set(node.attrs.id, node);
    });
    return m;
  }

  it('does NOT delete/recreate existing definition subtrees for an out-of-order list (numbers still correct)', () => {
    const editor = makeEditor(reorderedDoc());

    // Capture the exact definition NODE INSTANCES before any sync pass.
    const before = getDefNodesById(editor.state.doc);
    // Sanity: both carry their content right now.
    expect(before.get('a')!.textContent).toBe('A');
    expect(before.get('b')!.textContent).toBe('B');

    // Trigger a local edit elsewhere in the body so the sync plugin runs.
    editor.commands.insertContentAt(1, 'z');

    const doc = editor.state.doc;

    // Reference order is [b, a]; the displayed numbers follow reference order
    // (decoration-only numbering): b -> 1, a -> 2 — regardless of physical list
    // order.
    expect(collectReferenceIds(doc)).toEqual(['b', 'a']);
    const numbers = computeFootnoteNumbers(doc);
    expect(numbers.get('b')).toBe(1);
    expect(numbers.get('a')).toBe(2);

    // CRITICAL regression guard: both definitions still exist and are the SAME
    // node instances as before the edit — the plugin did NOT delete/recreate the
    // list (which would replace every definition's CRDT subtree and open the
    // concurrent-edit data-loss window). Identity equality proves the subtree
    // was preserved verbatim.
    const after = getDefNodesById(doc);
    expect(after.get('a')).toBe(before.get('a'));
    expect(after.get('b')).toBe(before.get('b'));
    // Content intact, exactly one list, both definitions present.
    expect(after.get('a')!.textContent).toBe('A');
    expect(after.get('b')!.textContent).toBe('B');
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(1);
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(2);

    editor.destroy();
  });
});

/**
 * Sync-plugin guard paths that are awkward to exercise through a live editor:
 * the remote-transaction skip and the enableSync:false (read-only) mode.
 */
describe('footnote sync plugin (guards)', () => {
  // Build a non-canonical document (an orphan reference with no definition) so a
  // sync pass would normally append a transaction.
  function nonCanonicalState() {
    const schema = getSchema(extensions);
    const doc = PMNode.fromJSON(schema, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x' },
            { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'orphan' } },
          ],
        },
      ],
    });
    return EditorState.create({ schema, doc });
  }

  it('isRemoteTransaction => true: appendTransaction returns null (no rebuild on remote txns)', () => {
    // The sync plugin must SKIP remote/collab transactions so orphan cleanup and
    // structural rewrites only ever run on local edits.
    const plugin = footnoteSyncPlugin(() => true);
    const state = nonCanonicalState();

    // Produce a doc-changing transaction (insert a space) and feed it to the
    // plugin's appendTransaction exactly as ProseMirror would.
    const tr = state.tr.insertText(' ', 1);
    const newState = state.apply(tr);
    const result = plugin.spec.appendTransaction!([tr], state, newState);
    expect(result).toBeNull();
  });

  it('isRemoteTransaction => false: appendTransaction DOES rebuild (sanity)', () => {
    // Control: with a local (non-remote) transaction the same non-canonical doc
    // triggers a sync transaction, proving the null above is the remote guard
    // and not a no-op everywhere.
    const plugin = footnoteSyncPlugin(() => false);
    const state = nonCanonicalState();
    const tr = state.tr.insertText(' ', 1);
    const newState = state.apply(tr);
    const result = plugin.spec.appendTransaction!([tr], state, newState);
    expect(result).not.toBeNull();
    expect(result!.docChanged).toBe(true);
  });

  it('enableSync:false: the plugin never mutates the doc (read-only viewer)', () => {
    // Build an editor with sync disabled. An orphan reference (no definition)
    // must NOT trigger a definition insertion — the document is left untouched.
    const editor = new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        FootnoteReference.configure({ enableSync: false }),
        FootnotesList,
        FootnoteDefinition,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'x' },
              { type: FOOTNOTE_REFERENCE_NAME, attrs: { id: 'orphan' } },
            ],
          },
        ],
      },
    });
    // A local edit that would normally trigger orphan-definition synthesis.
    editor.commands.insertContentAt(1, 'y');

    const doc = editor.state.doc;
    // No definition (and no list) was ever created — sync is disabled.
    expect(countType(doc, FOOTNOTE_DEFINITION_NAME)).toBe(0);
    expect(countType(doc, FOOTNOTES_LIST_NAME)).toBe(0);
    // Numbering decorations still work: the reference is numbered 1.
    expect(getFootnoteNumber(editor.state, 'orphan')).toBe(1);
    editor.destroy();
  });
});

/**
 * Numbering cache (Fix 2). NodeViews must read footnote numbers from the
 * numbering plugin's cached map (updated once per doc change) rather than
 * recomputing the whole map per render. We assert the cache exists, is correct,
 * and stays current across edits.
 */
describe('footnote numbering cache', () => {
  it('exposes correct numbers via getFootnoteNumber and updates on edits', () => {
    const editor = makeEditor({
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
    });

    // The cache mirrors computeFootnoteNumbers — but is read in O(1) per id.
    expect(getFootnoteNumber(editor.state, 'x')).toBe(1);
    expect(getFootnoteNumber(editor.state, 'y')).toBe(2);
    // The cached map is the SAME values a fresh full computation would yield.
    const fresh = computeFootnoteNumbers(editor.state.doc);
    expect(getFootnoteNumber(editor.state, 'x')).toBe(fresh.get('x'));
    expect(getFootnoteNumber(editor.state, 'y')).toBe(fresh.get('y'));

    // After inserting a new earlier reference, the cache updates so the numbers
    // shift (decoration-only numbering follows reference order).
    editor.commands.insertContentAt(1, {
      type: FOOTNOTE_REFERENCE_NAME,
      attrs: { id: 'z' },
    });
    expect(getFootnoteNumber(editor.state, 'z')).toBe(1);
    expect(getFootnoteNumber(editor.state, 'x')).toBe(2);
    expect(getFootnoteNumber(editor.state, 'y')).toBe(3);
    editor.destroy();
  });
});
