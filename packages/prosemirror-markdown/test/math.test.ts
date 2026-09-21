import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src so we exercise the real converter pair (the parser
// lives in markdown-to-prosemirror.ts; importing it mutates the global DOM via
// jsdom at module load, which @tiptap/html's generateJSON needs under Node).
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

// ---------------------------------------------------------------------------
// #293 canon #6: math -> `$…$` (inline) and `$$…$$` (block).
//
// The CENTRAL correctness constraint is that a single/currency `$` is NEVER
// math (`$5`, `it costs $5 and $10` stay literal), and a would-be-math `$x$`
// span in PROSE round-trips as literal text (never a phantom math node). These
// tests pin the serialize forms, the pandoc currency rule, the low-churn prose
// escape, the columns/raw-HTML schema-HTML form, and codeBlock/inline-code
// safety, and assert byte-stable round-trips throughout.
// ---------------------------------------------------------------------------

const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

// export -> import -> export. Returns md1, the re-imported doc, and md2 (which
// MUST equal md1 for the git-sync data path to be byte-stable).
async function roundTrip(node: any) {
  const md1 = convertProseMirrorToMarkdown(doc(node));
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, doc2, md2 };
}

// Depth-first find the first node of a type in a re-imported doc.
function findNode(n: any, type: string): any {
  if (!n || typeof n !== 'object') return undefined;
  if (n.type === type) return n;
  if (Array.isArray(n.content)) {
    for (const c of n.content) {
      const hit = findNode(c, type);
      if (hit) return hit;
    }
  }
  return undefined;
}

// Concatenate every text run under a node (for asserting text is preserved).
function allText(n: any): string {
  if (!n || typeof n !== 'object') return '';
  if (n.type === 'text') return n.text || '';
  if (Array.isArray(n.content)) return n.content.map(allText).join('');
  return '';
}

describe('mathInline serialize + round-trip', () => {
  it('mathInline x^2 -> exact $x^2$ and re-imports as mathInline attrs.text x^2', async () => {
    const { md1, doc2, md2 } = await roundTrip(para({ type: 'mathInline', attrs: { text: 'x^2' } }));
    expect(md1).toBe('$x^2$');
    expect(md2).toBe(md1); // byte-stable
    const math = findNode(doc2, 'mathInline');
    expect(math).toBeDefined();
    expect(math.attrs.text).toBe('x^2');
    // No stray literal text, no math-shaped currency false positive.
    expect(allText(doc2)).toBe('');
  });

  it('mathInline surrounded by prose round-trips as math (not currency)', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      para(text('let '), { type: 'mathInline', attrs: { text: 'x^2' } }, text(' be')),
    );
    expect(md1).toBe('let $x^2$ be');
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathInline').attrs.text).toBe('x^2');
  });

  it('LaTeX containing a literal $ is escaped \\$ and round-trips exact', async () => {
    const { md1, doc2, md2 } = await roundTrip(para({ type: 'mathInline', attrs: { text: 'a$b' } }));
    expect(md1).toBe('$a\\$b$'); // inner $ escaped so it cannot close early
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathInline').attrs.text).toBe('a$b');
  });

  it('empty mathInline falls back to the lossless schema-HTML <span> form', async () => {
    const { md1, doc2, md2 } = await roundTrip(para({ type: 'mathInline', attrs: { text: '' } }));
    // An empty `$$` would look like a block; the span form is lossless.
    expect(md1).toBe('<span data-type="mathInline" data-katex="true" text=""></span>');
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathInline')).toBeDefined();
  });

  it('mathInline whose LaTeX carries a pre-existing \\$ takes the span fallback', async () => {
    // `\$` before escaping would make the `$`→`\$` escape ambiguous, so this
    // rare case uses the always-lossless schema-HTML form (documented fork).
    const { md1, doc2, md2 } = await roundTrip(para({ type: 'mathInline', attrs: { text: '\\$100' } }));
    expect(md1).toContain('<span data-type="mathInline"');
    expect(md1).not.toContain('$\\$100$');
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathInline').attrs.text).toBe('\\$100');
  });

  it('mathInline immediately followed by a digit text run uses the span fallback (round-trips)', async () => {
    // `$x^2$5` would fail the pandoc closing rule (digit after `$`), so the math
    // node falls back to the lossless span form; the "5" stays literal text.
    const { md1, doc2, md2 } = await roundTrip(
      para({ type: 'mathInline', attrs: { text: 'x^2' } }, text('5')),
    );
    expect(md1).toBe('<span data-type="mathInline" data-katex="true" text="x^2"></span>5');
    expect(md1).not.toContain('$x^2$5');
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathInline').attrs.text).toBe('x^2');
    expect(allText(doc2)).toBe('5');
  });
});

describe('mathBlock serialize + round-trip', () => {
  it('multi-line mathBlock -> $$ fence with LaTeX intact, byte-stable', async () => {
    const latex = '\\int_0^1 f\n= 1';
    const { md1, doc2, md2 } = await roundTrip({ type: 'mathBlock', attrs: { text: latex } });
    expect(md1).toBe('$$\n\\int_0^1 f\n= 1\n$$');
    expect(md2).toBe(md1);
    const math = findNode(doc2, 'mathBlock');
    expect(math).toBeDefined();
    expect(math.attrs.text).toBe(latex); // multi-line preserved
  });

  it('single-line mathBlock round-trips', async () => {
    const { md1, doc2, md2 } = await roundTrip({ type: 'mathBlock', attrs: { text: 'a^2+b^2' } });
    expect(md1).toBe('$$\na^2+b^2\n$$');
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathBlock').attrs.text).toBe('a^2+b^2');
  });

  it('empty mathBlock round-trips as an empty $$ fence', async () => {
    const { md1, doc2, md2 } = await roundTrip({ type: 'mathBlock', attrs: { text: '' } });
    expect(md1).toBe('$$\n\n$$');
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathBlock')).toBeDefined();
  });

  it('mathBlock whose LaTeX contains a $$ takes the lossless <div> fallback', async () => {
    const { md1, doc2, md2 } = await roundTrip({ type: 'mathBlock', attrs: { text: 'a $$ b' } });
    expect(md1).toContain('<div data-type="mathBlock"');
    expect(md1).not.toBe('$$\na $$ b\n$$');
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathBlock').attrs.text).toBe('a $$ b');
  });
});

describe('currency: a single/currency $ is NEVER math', () => {
  const cases = ['it costs $5', '$5 and $10', 'a $5 b $6 c', 'price is $5', 'pay $5 now'];
  for (const original of cases) {
    it(`"${original}" stays literal text with NO backslashes and NO math node`, async () => {
      const { md1, doc2, md2 } = await roundTrip(para(text(original)));
      // Emitted markdown carries NO escaping (currency has no valid closing $).
      expect(md1).toBe(original);
      expect(md1).not.toContain('\\$');
      expect(md2).toBe(md1);
      // No math node materialized; the text is preserved EXACTLY.
      expect(findNode(doc2, 'mathInline')).toBeUndefined();
      expect(allText(doc2)).toBe(original);
    });
  }

  it('a currency amount preserves the exact string across a round trip', async () => {
    const { doc2 } = await roundTrip(para(text('$5 and $10')));
    expect(allText(doc2)).toBe('$5 and $10');
    expect(findNode(doc2, 'mathInline')).toBeUndefined();
  });
});

describe('prose $x$ (would-be math) round-trips as literal text (escaped)', () => {
  it('the set $A$ -> \\$A\\$ and re-imports as literal text, no math node', async () => {
    const { md1, doc2, md2 } = await roundTrip(para(text('the set $A$ is closed')));
    expect(md1).toBe('the set \\$A\\$ is closed');
    expect(md2).toBe(md1); // byte-stable
    expect(findNode(doc2, 'mathInline')).toBeUndefined();
    // The literal text is preserved exactly (backslashes are a serialization
    // detail, decoded back on import).
    expect(allText(doc2)).toBe('the set $A$ is closed');
  });
});

describe('math inside a column keeps the schema-HTML form (NOT $…$)', () => {
  const oneColumn = (child: any) => ({
    type: 'columns',
    content: [{ type: 'column', content: [child] }],
  });

  it('mathBlock in a column emits <div> (no $$ fence), round-trips', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      oneColumn({ type: 'mathBlock', attrs: { text: 'a^2+b^2' } }),
    );
    expect(md1).toContain('<div data-type="mathBlock" data-katex="true" text="a^2+b^2"></div>');
    expect(md1).not.toContain('$$');
    // The schema-HTML math form survives the round trip (a re-imported column
    // gains a default data-layout, so we assert the math div, not full equality).
    expect(md2).toContain('<div data-type="mathBlock" data-katex="true" text="a^2+b^2"></div>');
    expect(md2).not.toContain('$$');
    expect(findNode(doc2, 'mathBlock').attrs.text).toBe('a^2+b^2');
  });

  it('mathInline in a column paragraph emits <span> (no $…$), round-trips', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      oneColumn(para(text('eq: '), { type: 'mathInline', attrs: { text: 'x_i' } })),
    );
    expect(md1).toContain('<span data-type="mathInline" data-katex="true" text="x_i"></span>');
    expect(md1).not.toContain('$x_i$');
    expect(md2).toContain('<span data-type="mathInline" data-katex="true" text="x_i"></span>');
    expect(md2).not.toContain('$x_i$');
    expect(findNode(doc2, 'mathInline').attrs.text).toBe('x_i');
  });
});

describe('code is never math (canon #7 codeBlock regression class)', () => {
  it('inline `code` span containing $x$ / $5 stays code, no math, no backslashes', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      para(text('$x$ and $5', [{ type: 'code' }])),
    );
    // A code run is emitted verbatim in a backtick span — no `$` escaping, no math.
    expect(md1).toBe('`$x$ and $5`');
    expect(md1).not.toContain('\\$');
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathInline')).toBeUndefined();
    const codeRun = findNode(doc2, 'text');
    expect(codeRun.marks?.some((m: any) => m.type === 'code')).toBe(true);
    expect(codeRun.text).toBe('$x$ and $5');
  });

  it('codeBlock containing $…$ and $5 stays code, no math, no backslash corruption', async () => {
    const code = 'cost = $5\nx = $y$';
    const { md1, doc2, md2 } = await roundTrip({
      type: 'codeBlock',
      attrs: { language: 'python' },
      content: [text(code)],
    });
    // Fenced code is literal: the `$` are verbatim, no escaping, no math node.
    expect(md1).toContain('cost = $5');
    expect(md1).toContain('x = $y$');
    expect(md1).not.toContain('\\$');
    expect(md2).toBe(md1);
    expect(findNode(doc2, 'mathInline')).toBeUndefined();
    expect(findNode(doc2, 'mathBlock')).toBeUndefined();
    // The `$` are preserved verbatim inside the fence (marked re-adds one
    // trailing newline the exporter strips again, so compare against that).
    const codeText = allText(findNode(doc2, 'codeBlock'));
    expect(codeText).toContain('cost = $5');
    expect(codeText).toContain('x = $y$');
    expect(codeText).not.toContain('\\$');
  });
});

describe('fail-open: unbalanced / lone $ never crashes and stays literal', () => {
  for (const src of ['$', '$$', 'a $ b', '$ x $', 'unbalanced $x here']) {
    it(`"${src}" imports without crash and materializes no math node`, async () => {
      const doc2 = await markdownToProseMirror(src);
      expect(doc2).toBeDefined();
      expect(findNode(doc2, 'mathInline')).toBeUndefined();
      // `$$` alone would only ever be a fence with content; a lone `$$` line is
      // not a valid fence, so no mathBlock either.
      expect(findNode(doc2, 'mathBlock')).toBeUndefined();
    });
  }
});
