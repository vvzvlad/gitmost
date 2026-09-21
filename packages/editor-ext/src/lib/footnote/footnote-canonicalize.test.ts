import { describe, it, expect } from 'vitest';
import { Editor, getSchema } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { FootnoteReference } from './footnote-reference';
import { FootnotesList } from './footnotes-list';
import { FootnoteDefinition } from './footnote-definition';
import { canonicalizeFootnotes } from './footnote-canonicalize';
import { FOOTNOTE_CORPUS } from './footnote-corpus';
import {
  collectReferenceIds,
  computeFootnoteNumbers,
  FOOTNOTE_REFERENCE_NAME,
  FOOTNOTES_LIST_NAME,
  FOOTNOTE_DEFINITION_NAME,
} from './footnote-util';
import { Node as PMNode } from '@tiptap/pm/model';

const extensions = [
  Document,
  Paragraph,
  Text,
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
];

const ref = (id: string) => ({ type: FOOTNOTE_REFERENCE_NAME, attrs: { id } });
const def = (id: string, text?: string) => ({
  type: FOOTNOTE_DEFINITION_NAME,
  attrs: { id },
  content: [
    text
      ? { type: 'paragraph', content: [{ type: 'text', text }] }
      : { type: 'paragraph' },
  ],
});
const list = (...defs: any[]) => ({ type: FOOTNOTES_LIST_NAME, content: defs });
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

/** Find every node of `type`, document order. */
function findAll(node: any, type: string, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) {
    for (const c of node.content) findAll(c, type, acc);
  }
  return acc;
}

/** Physical id order of the definitions in the (single) footnotesList. */
function defOrder(doc: any): string[] {
  return findAll(doc, FOOTNOTE_DEFINITION_NAME).map((d) => d.attrs.id);
}

const schema = getSchema(extensions);
/** Reference order (distinct, document order) computed via the shared util. */
function refOrder(doc: any): string[] {
  return collectReferenceIds(PMNode.fromJSON(schema, doc));
}

describe('canonicalizeFootnotes (pure JSON)', () => {
  it('orders definitions by FIRST reference (out-of-order list -> 1..N)', () => {
    // References appear b, a, d, c; the bottom list is in a different (import)
    // order. The canonical list must follow reference order so reading it top to
    // bottom yields numbers 1..N.
    const doc = {
      type: 'doc',
      content: [
        para(
          { type: 'text', text: 'x' },
          ref('b'),
          ref('a'),
          ref('d'),
          ref('c'),
        ),
        list(def('a', 'A'), def('c', 'C'), def('b', 'B'), def('d', 'D')),
      ],
    };

    const out = canonicalizeFootnotes(doc);
    expect(defOrder(out)).toEqual(['b', 'a', 'd', 'c']);
    // The physical definition order now matches reference order, so the derived
    // numbers (1..N) run sequentially down the list.
    expect(refOrder(out)).toEqual(['b', 'a', 'd', 'c']);
    const numbers = computeFootnoteNumbers(PMNode.fromJSON(schema, out));
    expect(numbers.get('b')).toBe(1);
    expect(numbers.get('a')).toBe(2);
    expect(numbers.get('d')).toBe(3);
    expect(numbers.get('c')).toBe(4);
  });

  it('numbers run 1..N down the canonical list', () => {
    const doc = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'x' }, ref('b'), ref('a'), ref('c')),
        list(def('a', 'A'), def('c', 'C'), def('b', 'B')),
      ],
    };
    const out = canonicalizeFootnotes(doc);
    // Definition order == reference order == 1,2,3 reading down.
    expect(defOrder(out)).toEqual(['b', 'a', 'c']);
  });

  it('drops an orphan definition (no matching reference)', () => {
    const doc = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'x' }, ref('a')),
        list(def('a', 'A'), def('orphan', 'O')),
      ],
    };
    const out = canonicalizeFootnotes(doc);
    expect(defOrder(out)).toEqual(['a']);
    expect(findAll(out, FOOTNOTE_DEFINITION_NAME)).toHaveLength(1);
  });

  it('with NO references, removes the footnotesList entirely', () => {
    const doc = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'plain' }),
        list(def('orphan', 'O')),
      ],
    };
    const out = canonicalizeFootnotes(doc);
    expect(findAll(out, FOOTNOTES_LIST_NAME)).toHaveLength(0);
    expect(findAll(out, FOOTNOTE_DEFINITION_NAME)).toHaveLength(0);
  });

  it('reuse: repeated references collapse to ONE definition/number', () => {
    const doc = {
      type: 'doc',
      content: [
        para(ref('d'), { type: 'text', text: ' a ' }, ref('d'), ref('d')),
        list(def('d', 'shared')),
      ],
    };
    const out = canonicalizeFootnotes(doc);
    // One definition; the three references keep id "d".
    expect(defOrder(out)).toEqual(['d']);
    expect(
      findAll(out, FOOTNOTE_REFERENCE_NAME).map((r) => r.attrs.id),
    ).toEqual(['d', 'd', 'd']);
  });

  it('duplicate definitions: first wins, the rest are dropped (never resurface as orphans)', () => {
    const doc = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'x' }, ref('d')),
        list(def('d', 'first'), def('d', 'second'), def('d', 'third')),
      ],
    };
    const out = canonicalizeFootnotes(doc);
    const defs = findAll(out, FOOTNOTE_DEFINITION_NAME);
    expect(defs.map((d) => d.attrs.id)).toEqual(['d']);
    expect(defs[0].content[0].content[0].text).toBe('first');
  });

  it('synthesizes an empty definition for a reference that has none', () => {
    const doc = {
      type: 'doc',
      content: [para({ type: 'text', text: 'x' }, ref('missing'))],
    };
    const out = canonicalizeFootnotes(doc);
    expect(defOrder(out)).toEqual(['missing']);
    const list0 = findAll(out, FOOTNOTES_LIST_NAME);
    expect(list0).toHaveLength(1);
  });

  it('merges multiple footnotesList nodes into one', () => {
    const doc = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'a' }, ref('x'), ref('y')),
        list(def('x', 'X')),
        para({ type: 'text', text: 'tail' }),
        list(def('y', 'Y')),
      ],
    };
    const out = canonicalizeFootnotes(doc);
    expect(findAll(out, FOOTNOTES_LIST_NAME)).toHaveLength(1);
    expect(defOrder(out)).toEqual(['x', 'y']);
  });

  it('places the single list before trailing empty paragraphs', () => {
    const doc = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'x' }, ref('a')),
        list(def('a', 'A')),
        { type: 'paragraph' },
      ],
    };
    const out = canonicalizeFootnotes(doc);
    const last = out.content[out.content.length - 1];
    expect(last.type).toBe('paragraph');
    expect(out.content[out.content.length - 2].type).toBe(FOOTNOTES_LIST_NAME);
  });

  it('is idempotent: canonicalize(canonicalize(x)) === canonicalize(x)', () => {
    const doc = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'x' }, ref('b'), ref('a')),
        list(def('a', 'A'), def('b', 'B'), def('orphan', 'O')),
      ],
    };
    const once = canonicalizeFootnotes(doc);
    const twice = canonicalizeFootnotes(once);
    expect(twice).toEqual(once);
  });

  it('does not mutate its input', () => {
    const doc = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'x' }, ref('a')),
        list(def('orphan', 'O')),
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(doc));
    canonicalizeFootnotes(doc);
    expect(doc).toEqual(snapshot);
  });
});

/**
 * GOLDEN PARITY against the live `footnoteSyncPlugin`. The server canonicalizer
 * must produce EXACTLY what the editor keeps. For every editor-reachable steady
 * state (the list is already reference-ordered there), driving a real editor to
 * convergence and then running `canonicalizeFootnotes` on its JSON must be a
 * byte-for-byte no-op — proving the server output is identical to the editor's.
 */
describe('canonicalizeFootnotes golden parity with footnoteSyncPlugin', () => {
  function makeEditor(content: any) {
    return new Editor({ extensions, content });
  }

  /** Load `content`, fire one local edit so the sync plugin converges, return JSON. */
  function pluginSteadyState(content: any): any {
    const editor = makeEditor(content);
    // A local doc change triggers footnoteSyncPlugin.appendTransaction.
    editor.commands.insertContentAt(1, ' ');
    const json = editor.state.doc.toJSON();
    editor.destroy();
    return json;
  }

  const corpus: Array<{ name: string; content: any }> = [
    {
      name: 'plain ref + def',
      content: {
        type: 'doc',
        content: [para({ type: 'text', text: 'a' }, ref('x')), list(def('x', 'X'))],
      },
    },
    {
      name: 'two refs, two defs in reference order',
      content: {
        type: 'doc',
        content: [
          para({ type: 'text', text: 'a' }, ref('x'), { type: 'text', text: 'b' }, ref('y')),
          list(def('x', 'X'), def('y', 'Y')),
        ],
      },
    },
    {
      name: 'orphan definition gets removed',
      content: {
        type: 'doc',
        content: [para({ type: 'text', text: 'a' }, ref('x')), list(def('x', 'X'), def('orphan', 'O'))],
      },
    },
    {
      name: 'reference missing its definition (synth empty)',
      content: {
        type: 'doc',
        content: [para({ type: 'text', text: 'a' }, ref('x'))],
      },
    },
    {
      name: 'reuse: repeated references, one definition',
      content: {
        type: 'doc',
        content: [
          para(ref('d'), { type: 'text', text: ' a ' }, ref('d'), ref('d')),
          list(def('d', 'shared')),
        ],
      },
    },
    {
      name: 'no footnotes at all',
      content: {
        type: 'doc',
        content: [para({ type: 'text', text: 'just text' })],
      },
    },
  ];

  for (const { name, content } of corpus) {
    it(`steady state is a canonicalize no-op: ${name}`, () => {
      const steady = pluginSteadyState(content);
      expect(canonicalizeFootnotes(steady)).toEqual(steady);
    });
  }

  it('placement parity: the LIVE plugin leaves a list with NON-EMPTY content after it in place, and canonicalize agrees', () => {
    // Drives the real footnoteSyncPlugin (not a hand-authored expected): a single
    // canonical list with body content AFTER it must NOT be repositioned by the
    // plugin, and the server canonicalizer must agree (step-6 placement parity).
    const content = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'a' }, ref('x')),
        list(def('x', 'X')),
        para({ type: 'text', text: 'epilogue' }),
      ],
    };
    const steady = pluginSteadyState(content);
    // The plugin did NOT move the list to the end: a non-empty paragraph follows it.
    const types = steady.content.map((n: any) => n.type);
    const listPos = types.indexOf(FOOTNOTES_LIST_NAME);
    expect(listPos).toBeGreaterThanOrEqual(0);
    expect(listPos).toBeLessThan(types.length - 1);
    const after = steady.content[listPos + 1];
    expect(after.type).toBe('paragraph');
    expect(JSON.stringify(after)).toContain('epilogue');
    // The canonicalizer is a byte-for-byte no-op on that steady state (parity).
    expect(canonicalizeFootnotes(steady)).toEqual(steady);
  });

  it('the canonicalizer and the editor agree on reference order and definition set', () => {
    const content = {
      type: 'doc',
      content: [
        para({ type: 'text', text: 'a' }, ref('x'), { type: 'text', text: 'b' }, ref('y')),
        list(def('y', 'Y'), def('x', 'X')), // physically reversed
      ],
    };
    const steady = pluginSteadyState(content);
    const canon = canonicalizeFootnotes(content);
    // Same reference order and same DEFINITION SET (ids) in both, even though the
    // physical list order may differ (the plugin preserves node identity, the
    // canonicalizer reorders). Numbering — derived from reference order — matches.
    expect(refOrder(steady)).toEqual(['x', 'y']);
    expect(defOrder(canon)).toEqual(['x', 'y']);
    expect(new Set(defOrder(steady))).toEqual(new Set(defOrder(canon)));
  });
});

/**
 * SHARED golden corpus: this editor-ext copy of `canonicalizeFootnotes` and the
 * MCP mirror (`packages/mcp/src/lib/footnote-canonicalize.ts`) are BOTH run
 * against the identical { input -> expected } corpus. Pinning the same expected
 * outputs in both suites makes "the two pure copies behave identically" a
 * checkable property without coupling the packages (architecture item A). The
 * MCP mirror of these assertions lives in `test/unit/footnote-corpus.test.mjs`.
 */
describe('canonicalizeFootnotes shared golden corpus (editor-ext copy)', () => {
  for (const { name, input, expected } of FOOTNOTE_CORPUS) {
    it(`matches the corpus expected output: ${name}`, () => {
      expect(canonicalizeFootnotes(input)).toEqual(expected);
      // Idempotent on the corpus too.
      expect(canonicalizeFootnotes(expected)).toEqual(expected);
    });
  }
});
