import { describe, expect, it } from 'vitest';
// Import both directions DIRECTLY from src (NOT the docmost-client barrel, which
// pulls in collaboration.ts and mutates the global DOM at import time), matching
// the other converter unit tests.
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

// #293 canon #7: a `highlight` mark WITHOUT a color serializes as the
// Obsidian/GFM `==text==` syntax; a highlight WITH a color KEEPS the
// `<mark style="background-color: …">` HTML form. On the raw-HTML path
// (columns / spanned cells) BOTH forms stay `<mark>` because markdown is not
// re-parsed there. This file locks the serialize form, the round-trip, and the
// literal-`==` escape that keeps a literal `==` from becoming a phantom mark.

const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

// Find the first text node anywhere in a PM tree that carries a mark of `type`.
const firstMarkedText = (node: any, type: string): any => {
  if (node?.type === 'text' && (node.marks || []).some((m: any) => m.type === type)) {
    return node;
  }
  for (const child of node?.content || []) {
    const hit = firstMarkedText(child, type);
    if (hit) return hit;
  }
  return null;
};
const mark = (textNode: any, type: string): any =>
  (textNode?.marks || []).find((m: any) => m.type === type);
// Concatenate all text within a subtree (order-preserving).
const allText = (node: any): string => {
  if (node?.type === 'text') return node.text || '';
  return (node?.content || []).map(allText).join('');
};
// Does ANY text node in the tree carry a mark of `type`?
const hasMark = (node: any, type: string): boolean => !!firstMarkedText(node, type);

// PM -> MD -> PM round-trip.
const roundTrip = async (d: any) => {
  const md1 = convertProseMirrorToMarkdown(d);
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, doc2, md2 };
};

describe('#293 #7: no-color highlight <-> ==text==', () => {
  it('serializes a no-color highlight as exactly ==text==', () => {
    expect(convertProseMirrorToMarkdown(doc(para(text('important', [{ type: 'highlight' }]))))).toBe(
      '==important==',
    );
  });

  it('imports ==text== as a highlight mark with NO color', async () => {
    const d = await markdownToProseMirror('==important==');
    const t = firstMarkedText(d, 'highlight');
    expect(t).toBeTruthy();
    expect(t.text).toBe('important');
    // A bare <mark> carries no background-color, so the color attr is null.
    expect(mark(t, 'highlight').attrs?.color ?? null).toBeNull();
  });

  it('is byte-stable and re-imports as a color-less highlight', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      doc(para(text('a base '), text('hl', [{ type: 'highlight' }]), text(' tail'))),
    );
    expect(md1).toBe('a base ==hl== tail');
    expect(md2).toBe(md1);
    const t = firstMarkedText(doc2, 'highlight');
    expect(t.text).toBe('hl');
    expect(mark(t, 'highlight').attrs?.color ?? null).toBeNull();
  });
});

describe('#293 #7: colored highlight keeps <mark style=…>', () => {
  it('serializes a colored highlight as the <mark style=…> HTML form (NOT ==)', () => {
    const out = convertProseMirrorToMarkdown(
      doc(para(text('c', [{ type: 'highlight', attrs: { color: '#ff0000' } }]))),
    );
    expect(out).toBe('<mark style="background-color: #ff0000">c</mark>');
    expect(out).not.toContain('==');
  });

  it('round-trips a colored highlight preserving its color', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      doc(para(text('c', [{ type: 'highlight', attrs: { color: '#abcdef' } }]))),
    );
    expect(md1).toBe('<mark style="background-color: #abcdef">c</mark>');
    expect(md2).toBe(md1);
    const t = firstMarkedText(doc2, 'highlight');
    expect(mark(t, 'highlight').attrs?.color).toBe('#abcdef');
  });
});

describe('#293 #7: raw-HTML path (columns) stays <mark>, never ==', () => {
  const oneColumn = (...blocks: any[]) => ({
    type: 'columns',
    attrs: { layout: 'two' },
    content: [{ type: 'column', content: blocks }],
  });

  it('a no-color highlight inside a column serializes as <mark> (inlineToHtml), not ==', () => {
    const out = convertProseMirrorToMarkdown(doc(oneColumn(para(text('p', [{ type: 'highlight' }])))));
    expect(out).toContain('<mark>p</mark>');
    // The `==` markdown syntax must NOT leak into a raw-HTML container (it would
    // survive as literal text there because columns are not re-parsed).
    expect(out).not.toContain('==');
  });

  it('a colored highlight inside a column keeps <mark style=…>', () => {
    const out = convertProseMirrorToMarkdown(
      doc(oneColumn(para(text('p', [{ type: 'highlight', attrs: { color: '#00ff00' } }])))),
    );
    expect(out).toContain('<mark style="background-color: #00ff00">p</mark>');
  });

  it('round-trips a highlight inside a column (byte-stable, mark preserved)', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      doc(oneColumn(para(text('p', [{ type: 'highlight' }])))),
    );
    expect(md1).toContain('<mark>p</mark>');
    expect(md2).toBe(md1);
    expect(hasMark(doc2, 'highlight')).toBe(true);
  });
});

describe('#293 #7: highlight wrapping other marks', () => {
  it('serializes bold-inside-highlight as ==**x**== and round-trips both marks', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      doc(para(text('x', [{ type: 'bold' }, { type: 'highlight' }]))),
    );
    expect(md1).toBe('==**x**==');
    expect(md2).toBe(md1);
    const t = firstMarkedText(doc2, 'highlight');
    expect(t).toBeTruthy();
    expect((t.marks || []).some((m: any) => m.type === 'bold')).toBe(true);
    expect(t.text).toBe('x');
  });
});

describe('#293 #7: inline code containing == stays code, not a highlight', () => {
  it('imports `a == b` as an inline code span, not a highlight', async () => {
    const d = await markdownToProseMirror('`a == b`');
    expect(hasMark(d, 'highlight')).toBe(false);
    const codeText = firstMarkedText(d, 'code');
    expect(codeText).toBeTruthy();
    expect(codeText.text).toBe('a == b');
  });

  it('round-trips an inline code span carrying == (byte-stable, no highlight)', async () => {
    const { md1, md2, doc2 } = await roundTrip(doc(para(text('a == b', [{ type: 'code' }]))));
    expect(md1).toBe('`a == b`');
    expect(md2).toBe(md1);
    expect(hasMark(doc2, 'highlight')).toBe(false);
    expect(firstMarkedText(doc2, 'code').text).toBe('a == b');
  });
});

describe('#293 #7: literal == in plain prose round-trips as text (no phantom highlight)', () => {
  it('a lone literal == (a == b) is escaped and re-imports as literal text', async () => {
    const { md1, md2, doc2 } = await roundTrip(doc(para(text('a == b'))));
    // Each `=` of the pair is backslash-escaped so marked decodes it back.
    expect(md1).toBe('a \\=\\= b');
    expect(md2).toBe(md1);
    expect(hasMark(doc2, 'highlight')).toBe(false);
    expect(allText(doc2)).toBe('a == b');
  });

  it('a literal ==...== pair in prose does NOT materialize a highlight', async () => {
    const { md1, md2, doc2 } = await roundTrip(doc(para(text('x ==not hl== y'))));
    expect(md1).toBe('x \\=\\=not hl\\=\\= y');
    expect(md2).toBe(md1);
    expect(hasMark(doc2, 'highlight')).toBe(false);
    expect(allText(doc2)).toBe('x ==not hl== y');
  });

  it('a highlight over text that itself contains a literal == round-trips both', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      doc(para(text('a == b', [{ type: 'highlight' }]))),
    );
    // The inner literal `==` is escaped; the highlight `==` delimiters are added
    // AFTER escaping, so the mark's own delimiters are intact.
    expect(md1).toBe('==a \\=\\= b==');
    expect(md2).toBe(md1);
    const t = firstMarkedText(doc2, 'highlight');
    expect(t.text).toBe('a == b');
  });
});

describe('#293 #7: fail-open edges (empty / unbalanced ==)', () => {
  it('empty ==== does not crash and stays literal (no highlight)', async () => {
    const d = await markdownToProseMirror('====');
    expect(hasMark(d, 'highlight')).toBe(false);
    expect(allText(d)).toBe('====');
  });

  it('unbalanced ==x does not crash and stays literal (no highlight)', async () => {
    const d = await markdownToProseMirror('==x');
    expect(hasMark(d, 'highlight')).toBe(false);
    expect(allText(d)).toBe('==x');
  });

  it('two highlights on one line both parse (lazy inner)', async () => {
    const d = await markdownToProseMirror('==a== ==b==');
    const first = firstMarkedText(d, 'highlight');
    expect(first.text).toBe('a');
    // Both highlighted runs are present.
    expect(allText(d)).toContain('a');
    expect(allText(d)).toContain('b');
  });
});

describe('#293 #7: a codeBlock containing == is NOT escaped (literal code preserved)', () => {
  // Regression: the canon #7 `==` -> `\=\=` escape lives in `case "text"`, but
  // code-fence content is literal and marked does NOT decode `\=` inside a fence,
  // so routing code through that path would permanently stamp backslashes into a
  // `==` comparison (ubiquitous in source). codeBlock must read raw child text.
  const codeBlock = (t: string, language = '') => ({
    type: 'codeBlock',
    attrs: { language },
    content: [{ type: 'text', text: t }],
  });

  it('exports `==` in code verbatim (no \\=\\=) and round-trips byte-stably', async () => {
    const d = doc(codeBlock('if (a == b) return c == d;', 'js'));
    const md1 = convertProseMirrorToMarkdown(d);
    expect(md1).toBe('```js\nif (a == b) return c == d;\n```');
    expect(md1).not.toContain('\\='); // no backslash corruption
    const back = await markdownToProseMirror(md1);
    // The code text survives with no backslash corruption and no phantom
    // highlight (marked re-adds a trailing "\n" to fence content on import,
    // which the serializer strips again — hence trimEnd here; byte-stability of
    // the markdown is asserted separately below).
    expect(allText(back).trimEnd()).toBe('if (a == b) return c == d;');
    expect(allText(back)).not.toContain('\\=');
    expect(hasMark(back, 'highlight')).toBe(false);
    expect(convertProseMirrorToMarkdown(back)).toBe(md1); // byte-stable
  });

  it('a real markdown code block with == imports clean and re-exports clean', async () => {
    const src = '```\nx == y\n```';
    const back = await markdownToProseMirror(src);
    expect(allText(back).trimEnd()).toBe('x == y');
    expect(allText(back)).not.toContain('\\=');
    expect(convertProseMirrorToMarkdown(back)).toBe(src); // byte-stable
  });
});
