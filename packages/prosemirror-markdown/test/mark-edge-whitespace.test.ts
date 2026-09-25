import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import {
  convertProseMirrorToMarkdown,
  isBareDelimiterMark,
} from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';
import { docmostExtensions } from '../src/lib/docmost-schema.js';

// ---------------------------------------------------------------------------
// Mark-edge whitespace: the serializer expels whitespace sitting at the edge of
// a BARE-DELIMITER mark outside the delimiters (`**x **` would never close), and
// `escapeLeadingBlockTrigger` then strips it when it lands at the start of a
// line (where it would push a block trigger right and change the BLOCK TYPE).
//
// These are deterministic pins for both halves plus the two invariants they
// lean on: the mark-type parity of the expulsion rule, and the #515
// code-emphasis flanking guard's behaviour once edge whitespace exists.
// ---------------------------------------------------------------------------

const schema = getSchema(docmostExtensions);

const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };

const blockTypes = (d: any): string[] => (d.content ?? []).map((n: any) => n.type);
const flatText = (d: any): string =>
  (d.content ?? [])
    .map((b: any) => (b.content ?? []).map((n: any) => n.text ?? '').join(''))
    .join('\n');

describe('expelled whitespace must never change the BLOCK TYPE', () => {
  // BUG (FIXED): the expelled space landed at column 0, and CommonMark allows
  // 1..3 spaces of indent BEFORE any block trigger — so `escapeLeadingBlockTrigger`
  // (anchored at column 0) stopped matching, the final .trim() removed the space,
  // and the reader got a bare trigger. A paragraph silently became a list /
  // heading / quote; inside a listItem the content escaped the item entirely.
  // FIXED by stripping leading indentation in the escaper itself.
  const triggerCases: Array<[string, string]> = [
    ['bullet', '- item'],
    ['heading', '# Head'],
    ['blockquote', '> quote'],
    ['ordered', '1. one'],
  ];

  for (const [name, trigger] of triggerCases) {
    it(`a leading expelled space does not turn a paragraph into a ${name}`, async () => {
      const d = doc(para(text(' ', [{ type: 'bold' }]), text(trigger)));
      const md = convertProseMirrorToMarkdown(d);
      const back = await markdownToProseMirror(md);
      expect(blockTypes(back)).toEqual(['paragraph']);
      expect(flatText(back)).toBe(trigger);
    });
  }

  // 4 spaces / a tab is the INDENTED CODE BLOCK threshold — the case the
  // 1..3-space arms above cannot reach.
  it('4 leading spaces do not turn the paragraph into a code block', async () => {
    const d = doc(para(text('first')), para(text('    x', [{ type: 'bold' }]), text('y')));
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe('first\n\n**x**y');
    const back = await markdownToProseMirror(md);
    expect(blockTypes(back)).toEqual(['paragraph', 'paragraph']);
    // The mark survives — the whole point of the expulsion.
    expect(back.content[1].content[0].marks?.[0]?.type).toBe('bold');
  });

  it('a leading tab does not turn the paragraph into a code block', async () => {
    const d = doc(para(text('first')), para(text('\tx', [{ type: 'bold' }]), text('y')));
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe('first\n\n**x**y');
    const back = await markdownToProseMirror(md);
    expect(blockTypes(back)).toEqual(['paragraph', 'paragraph']);
  });

  it('a list item keeps its content instead of spawning a nested list', async () => {
    const d = doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [para(text(' ', [{ type: 'bold' }]), text('- x'))],
        },
      ],
    });
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe('- \\- x');
    const back = await markdownToProseMirror(md);
    expect(blockTypes(back)).toEqual(['bulletList']);
    expect(back.content[0].content).toHaveLength(1);
    expect(flatText(back.content[0].content[0])).toBe('- x');
  });

  // A leading NBSP is NOT markdown indentation and the importer DOES preserve
  // it, so the strip must leave it alone. (At the very START of the DOCUMENT the
  // converter's final .trim() still removes it - JS trim() eats NBSP - which is
  // why this pin puts the run in a SECOND paragraph.)
  it('a leading expelled NBSP is preserved (it is not markdown indentation)', async () => {
    const NBSP = '\u00a0';
    const d = doc(
      para(text('first')),
      para(text(NBSP + 'x', [{ type: 'bold' }]), text('y')),
    );
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe('first\n\n' + NBSP + '**x**y');
    const back = await markdownToProseMirror(md);
    expect(blockTypes(back)).toEqual(['paragraph', 'paragraph']);
    expect(flatText(back)).toBe('first\n' + NBSP + 'xy');
  });

  // The raw-HTML twin: an HTML parser drops whitespace at the start of a block's
  // content, so emitting it is not a byte fixpoint. Reproducible on develop with
  // a PLAIN unmarked run — no marks involved.
  it('the raw-HTML path (columns) drops block-leading indentation too', async () => {
    const d = doc({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        { type: 'column', content: [para(text('left'))] },
        { type: 'column', content: [para(text('  a b'))] },
      ],
    });
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toContain('<p>a b</p>');
    expect(convertProseMirrorToMarkdown(await markdownToProseMirror(md))).toBe(md);
  });

  // The indentation strip works per `\n`-separated paragraph line, so a raw
  // newline inside multi-line inline LaTeX (emitted in a `text="…"` attribute)
  // would expose its indented lines to it. The newline is encoded as `&#10;`.
  it('multi-line inline math keeps the indentation of its lines', async () => {
    const latex = '\\begin{matrix}\n  a & b \\\\\n  c & d\n\\end{matrix}';
    const d = doc(para(text('x '), { type: 'mathInline', attrs: { text: latex } }));
    const md = convertProseMirrorToMarkdown(d);
    expect(md).not.toContain('\n');
    const back = await markdownToProseMirror(md);
    expect(back.content[0].content[1].attrs.text).toBe(latex);
    expect(convertProseMirrorToMarkdown(back)).toBe(md);
  });
});

describe('expulsion parity: expelled ⟺ isBareDelimiterMark', () => {
  // Attrs a mark needs before it renders its real form (a colorless highlight is
  // `==…==` while a colored one is <mark style>; textStyle emits nothing without
  // a color, link nothing useful without an href). Every schema mark MUST appear
  // here, so a NEW mark cannot slip past this parity check unnoticed.
  const MARK_PROBES: Record<string, Array<Record<string, any> | null>> = {
    bold: [null],
    italic: [null],
    strike: [null],
    code: [null],
    underline: [null],
    subscript: [null],
    superscript: [null],
    spoiler: [null],
    link: [{ href: 'http://a.aa' }],
    comment: [{ commentId: 'c1' }],
    textStyle: [{ color: '#123456' }],
    // Both branches of the ONE mark whose form depends on its attrs.
    highlight: [{ color: null }, { color: '#ffcc00' }],
  };

  it('every schema mark is probed (no silent gap in this parity check)', () => {
    expect(Object.keys(MARK_PROBES).sort()).toEqual(Object.keys(schema.marks).sort());
  });

  for (const [type, attrsList] of Object.entries(MARK_PROBES)) {
    for (const attrs of attrsList) {
      const mark = attrs ? { type, attrs } : { type };
      const label = attrs ? `${type} ${JSON.stringify(attrs)}` : type;
      it(`${label}: expelled === isBareDelimiterMark`, () => {
        const md = convertProseMirrorToMarkdown(
          doc(para(text('x'), text(' a ', [mark]), text('y'))),
        );
        // Expulsion is observable as the whitespace sitting OUTSIDE whatever the
        // mark rendered: the line then starts with "x " and ends with " y".
        const expelled = md.startsWith('x ') && md.endsWith(' y');
        expect(expelled, `rendered: ${JSON.stringify(md)}`).toBe(
          isBareDelimiterMark(mark),
        );
      });
    }
  }
});

describe('#515 code-emphasis flanking guard with edge whitespace', () => {
  // The guard tests are ANCHORED (`/^[*~=]+`/`, /`[*~=]+$/`), so they stop
  // matching once the expelled whitespace sits outside the delimiters. That is
  // the RIGHT answer, not a missed case: a `**` separated from the backtick by a
  // space is in the flanking-safe position the guard exists to avoid, so plain
  // markdown is emitted and the marks survive.
  it('a run with no edge whitespace still takes the guarded markdown form', async () => {
    const d = doc(
      para(
        text('pre '),
        text('a', [{ type: 'bold' }, { type: 'code' }]),
        text(' b', [{ type: 'bold' }]),
        text(' post'),
      ),
    );
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe('pre **`a` b** post');
    const back = await markdownToProseMirror(md);
    const marks = (back.content[0].content ?? []).map((n: any) =>
      (n.marks ?? []).map((m: any) => m.type).sort().join('+'),
    );
    expect(marks).toEqual(['', 'bold+code', 'bold', '']);
  });

  it('edge whitespace on the leading run disarms openerHitsCode, and that is correct', async () => {
    const d = doc(
      para(
        text('pre'),
        text(' b', [{ type: 'bold' }]),
        text('a', [{ type: 'bold' }, { type: 'code' }]),
        text(' post'),
      ),
    );
    const md = convertProseMirrorToMarkdown(d);
    // The space is expelled, so the opener is preceded by whitespace (flanking-
    // safe): openerHitsCode stops matching and the lossless-HTML fallback is
    // correctly NOT taken. The CLOSER is still glued to the backtick, so it is
    // the trailing " post" that keeps that half of the guard satisfied — with
    // "post" instead, the HTML fallback fires, as it should.
    expect(md).toBe('pre **b`a`** post');
    const back = await markdownToProseMirror(md);
    const marks = (back.content[0].content ?? []).map((n: any) =>
      (n.marks ?? []).map((m: any) => m.type).sort().join('+'),
    );
    expect(marks).toEqual(['', 'bold', 'bold+code', '']);
  });
});
