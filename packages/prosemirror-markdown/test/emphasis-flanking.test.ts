import { describe, expect, it } from 'vitest';
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

// ---------------------------------------------------------------------------
// A bare `**` / `*` / `~~` delimiter between an edge PUNCTUATION character of
// the marked text and a neighbouring WORD character never opens/closes in
// CommonMark (`**x:**A`, `A**(x)**`, `**x🙂**A` — an emoji is a symbol, i.e.
// punctuation). The mark used to be silently lost and the delimiters stamped
// into the text; the serializer now takes the lossless HTML form for that node.
// ---------------------------------------------------------------------------

const doc = (...inline: any[]) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: inline }],
});
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };

const MARKS = ['bold', 'italic', 'strike'];
const EDGES: Array<[string, string, string]> = [
  // name, closing-edge text, opening-edge text
  ['colon', 'w x:', ':x w'],
  ['paren', 'w (x)', '(x) w'],
  ['quote', 'w "x"', '"x" w'],
  ['emoji', 'w x🙂', '🙂x w'],
];
const NEIGHBOURS = ['A', '0'];

const roundTrip = async (d: any) => {
  const md = convertProseMirrorToMarkdown(d);
  const back = await markdownToProseMirror(md);
  return { md, back, md2: convertProseMirrorToMarkdown(back) };
};

describe('emphasis whose edge punctuation touches a word neighbour keeps its mark', () => {
  for (const mark of MARKS) {
    for (const [edge, closeText, openText] of EDGES) {
      for (const nb of NEIGHBOURS) {
        it(`${mark} closing on ${edge} before "${nb}"`, async () => {
          const d = doc(text(closeText, [{ type: mark }]), text(nb + 'w'));
          const { back, md, md2 } = await roundTrip(d);
          expect(back.content[0].content).toEqual(d.content[0].content);
          expect(md2).toBe(md);
        });

        it(`${mark} opening on ${edge} after "${nb}"`, async () => {
          const d = doc(text('w' + nb), text(openText, [{ type: mark }]));
          const { back, md, md2 } = await roundTrip(d);
          expect(back.content[0].content).toEqual(d.content[0].content);
          expect(md2).toBe(md);
        });
      }
    }
  }
});

// Inline content only, marks as a sorted type list (the importer re-orders a
// node's marks by schema rank).
const shape = (d: any) =>
  d.content[0].content.map((n: any) => ({
    text: n.text,
    marks: (n.marks ?? []).map((m: any) => m.type).sort(),
  }));

const expectLossless = async (d: any) => {
  const { back, md, md2 } = await roundTrip(d);
  expect(shape(back)).toEqual(shape(d));
  expect(md2).toBe(md);
  return md;
};

describe('the HTML form keeps the markdown escaping of its content', () => {
  // The tags only replace the delimiters; the content between them is still
  // parsed as markdown, so it must carry the same escapes as the markdown path.
  it('inline math stays text', async () => {
    const md = await expectLossless(doc(text('the set $A$', [{ type: 'bold' }]), text('B')));
    expect(md).toContain('<strong>');
  });

  it('a literal == stays text', async () => {
    await expectLossless(doc(text('a==b==:', [{ type: 'bold' }]), text('A')));
  });

  it('a literal ^[ does not open a footnote', async () => {
    await expectLossless(doc(text('see ^[x]', [{ type: 'bold' }]), text('A')));
  });

  // Leading whitespace at the start of a line cannot survive markdown in any
  // form (it is dropped exactly as it is for an unmarked run); what matters is
  // that it lands OUTSIDE the tag, so the output is byte-stable.
  it('leading whitespace is expelled outside the tag, byte-stable', async () => {
    const { back, md, md2 } = await roundTrip(
      doc(text('  x:', [{ type: 'bold' }]), text('A')),
    );
    expect(md).toBe('<strong>x:</strong>A');
    expect(md2).toBe(md);
    expect(shape(back)).toEqual([
      { text: 'x:', marks: ['bold'] },
      { text: 'A', marks: [] },
    ]);
  });
});

describe('neighbours that are not plain words', () => {
  it('an emoji after the closer keeps plain markdown (it closes there)', async () => {
    const md = await expectLossless(doc(text('Done!', [{ type: 'bold' }]), text('🎉')));
    expect(md).toBe('**Done!**🎉');
  });

  it('a following ~ does not let the closer close', async () => {
    await expectLossless(doc(text('Итого:', [{ type: 'bold' }]), text('~5 шт')));
  });

  it('a following strike does not let the closer close', async () => {
    await expectLossless(
      doc(text('Важно:', [{ type: 'bold' }]), text('старое', [{ type: 'strike' }])),
    );
  });

  it('a following italic does not merge into the closing run', async () => {
    await expectLossless(
      doc(text('a:', [{ type: 'bold' }]), text('b', [{ type: 'italic' }]), text('c')),
    );
  });
});

describe('a #515 code-emphasis run with edge punctuation', () => {
  it('closing on punctuation before a word', async () => {
    const md = await expectLossless(
      doc(
        text('a', [{ type: 'bold' }, { type: 'code' }]),
        text(':', [{ type: 'bold' }]),
        text('A'),
      ),
    );
    expect(md).toBe('<strong>`a`:</strong>A');
  });

  it('opening on punctuation after a word', async () => {
    await expectLossless(
      doc(
        text('A'),
        text(':', [{ type: 'bold' }]),
        text('a', [{ type: 'bold' }, { type: 'code' }]),
      ),
    );
  });
});

describe('the fallback does not fire where markdown already works', () => {
  it('a space after the closing edge keeps plain markdown', () => {
    const md = convertProseMirrorToMarkdown(doc(text('x:', [{ type: 'bold' }]), text(' A')));
    expect(md).toBe('**x:** A');
  });

  it('a letter at the edge keeps plain markdown even next to a word', () => {
    const md = convertProseMirrorToMarkdown(doc(text('x', [{ type: 'bold' }]), text('A')));
    expect(md).toBe('**x**A');
  });

  it('punctuation at the very end of the paragraph keeps plain markdown', () => {
    const md = convertProseMirrorToMarkdown(doc(text('A'), text(' x🙂', [{ type: 'bold' }])));
    expect(md).toBe('A **x🙂**');
  });

  it('a strike closer followed by bold keeps plain markdown (no merge)', async () => {
    const md = await expectLossless(
      doc(text('100₽', [{ type: 'strike' }]), text('80₽', [{ type: 'bold' }])),
    );
    expect(md).toBe('~~100₽~~**80₽**');
  });

  it('a colorless highlight is never switched (its `==` has no flanking rule)', () => {
    const md = convertProseMirrorToMarkdown(
      doc(text('x:', [{ type: 'highlight', attrs: { color: null } }]), text('A')),
    );
    expect(md).toBe('==x:==A');
  });
});
