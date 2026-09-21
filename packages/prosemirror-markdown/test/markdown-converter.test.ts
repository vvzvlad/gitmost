import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src (NOT the docmost-client barrel, which pulls in
// collaboration.ts and mutates global DOM at import time).
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';

// Wrap a single node in a minimal ProseMirror doc. The top-level converter
// joins doc children with "\n\n" and then .trim()s the whole output, so a
// single-node doc yields exactly that node's rendered (and trimmed) string.
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
// Convenience: a text node, optionally with marks.
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
// Convenience: a paragraph wrapping inline children.
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

describe('convertProseMirrorToMarkdown', () => {
  // ---------------------------------------------------------------------------
  describe('headings', () => {
    it('emits the right number of "#" for levels 1-6', () => {
      for (let level = 1; level <= 6; level++) {
        const out = convertProseMirrorToMarkdown(
          doc({ type: 'heading', attrs: { level }, content: [text('H')] }),
        );
        expect(out).toBe('#'.repeat(level) + ' H');
      }
    });

    it('defaults to level 1 when level is missing', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'heading', content: [text('NoLevel')] }),
      );
      expect(out).toBe('# NoLevel');
    });
  });

  // ---------------------------------------------------------------------------
  describe('text marks', () => {
    it('bold', () => {
      expect(
        convertProseMirrorToMarkdown(doc(para(text('x', [{ type: 'bold' }])))),
      ).toBe('**x**');
    });

    it('italic', () => {
      expect(
        convertProseMirrorToMarkdown(doc(para(text('x', [{ type: 'italic' }])))),
      ).toBe('*x*');
    });

    it('strike', () => {
      expect(
        convertProseMirrorToMarkdown(doc(para(text('x', [{ type: 'strike' }])))),
      ).toBe('~~x~~');
    });

    it('inline code (sole mark) uses backtick span', () => {
      expect(
        convertProseMirrorToMarkdown(doc(para(text('x', [{ type: 'code' }])))),
      ).toBe('`x`');
    });

    it('code + another mark nests the code span INSIDE the emphasis (#515)', () => {
      // #515: the schema's `code` mark no longer declares `excludes: "_"`, so a
      // run legitimately carries code together with bold (CommonMark parses
      // ``**`x`**`` as <strong><code>x</code></strong>). The backtick span is the
      // INNERMOST wrapper and the other marks are applied around it, in the
      // marks-array order — so the run round-trips with BOTH marks intact.
      const out = convertProseMirrorToMarkdown(
        doc(para(text('x', [{ type: 'bold' }, { type: 'code' }]))),
      );
      expect(out).toBe('**`x`**');
    });

    it('code + strike combo nests the code span inside `~~` (#515)', () => {
      const out = convertProseMirrorToMarkdown(
        doc(para(text('x', [{ type: 'strike' }, { type: 'code' }]))),
      );
      expect(out).toBe('~~`x`~~');
    });

    it('code + italic + bold applies the non-code marks in marks-array order (#515)', () => {
      // The mark array order is preserved exactly as before the fix (first mark =
      // innermost wrapper); `code` is simply pulled in front of all of them.
      const out = convertProseMirrorToMarkdown(
        doc(
          para(
            text('x', [{ type: 'italic' }, { type: 'bold' }, { type: 'code' }]),
          ),
        ),
      );
      expect(out).toBe('***`x`***');
    });
  });

  // ---------------------------------------------------------------------------
  describe('links', () => {
    it('href only', () => {
      const out = convertProseMirrorToMarkdown(
        doc(para(text('site', [{ type: 'link', attrs: { href: 'https://e.com' } }]))),
      );
      expect(out).toBe('[site](https://e.com)');
    });

    it('href + title with an embedded double quote is escaped', () => {
      const out = convertProseMirrorToMarkdown(
        doc(
          para(
            text('site', [
              { type: 'link', attrs: { href: 'https://e.com', title: 'a "b" c' } },
            ]),
          ),
        ),
      );
      // The markdown link-title form escapes the inner " as \".
      expect(out).toBe('[site](https://e.com "a \\"b\\" c")');
    });
  });

  // ---------------------------------------------------------------------------
  describe('image', () => {
    it('percent-encodes spaces and parentheses in src', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'image',
          attrs: { alt: 'cap', src: '/files/my pic (1).png' },
        }),
      );
      // space -> %20, ( -> %28, ) -> %29
      expect(out).toBe('![cap](/files/my%20pic%20%281%29.png)');
    });

    it('empty alt and missing src render harmlessly', () => {
      const out = convertProseMirrorToMarkdown(doc({ type: 'image', attrs: {} }));
      expect(out).toBe('![]()');
    });
  });

  // ---------------------------------------------------------------------------
  describe('codeBlock', () => {
    it('with language', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [text('const a = 1;')],
        }),
      );
      expect(out).toBe('```ts\nconst a = 1;\n```');
    });

    it('without language emits empty info string', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'codeBlock', content: [text('plain')] }),
      );
      expect(out).toBe('```\nplain\n```');
    });

    it('strips ALL trailing newlines for idempotency', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'codeBlock', content: [text('a\n\n\n')] }),
      );
      // Every trailing "\n" is removed, then exactly one is re-added by the fence.
      expect(out).toBe('```\na\n```');
    });
  });

  // ---------------------------------------------------------------------------
  describe('lists', () => {
    it('bullet list', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [para(text('one'))] },
            { type: 'listItem', content: [para(text('two'))] },
          ],
        }),
      );
      expect(out).toBe('- one\n- two');
    });

    it('ordered list numbers items sequentially', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [para(text('a'))] },
            { type: 'listItem', content: [para(text('b'))] },
            { type: 'listItem', content: [para(text('c'))] },
          ],
        }),
      );
      expect(out).toBe('1. a\n2. b\n3. c');
    });

    it('nested bullet list indents the child by the 2-col marker width', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('parent')),
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [para(text('child'))] }],
                },
              ],
            },
          ],
        }),
      );
      // First line carries the marker; the nested list is indented 2 columns.
      // Block children of a list item are separated by a BLANK line (loose list):
      // this is the #351 fix — a single "\n" let a following block merge into the
      // first paragraph on re-parse (silent content loss). The blank line stays
      // inside the item, so the sublist remains nested at the 2-col marker column.
      expect(out).toBe('- parent\n\n  - child');
    });

    it('nested ordered list indents by the wider 3-col marker width', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('parent')),
                {
                  type: 'orderedList',
                  content: [{ type: 'listItem', content: [para(text('child'))] }],
                },
              ],
            },
          ],
        }),
      );
      // "1. " is 3 columns wide, so the continuation indent is 3 spaces. Block
      // children are blank-line separated (loose list) per the #351 fix.
      expect(out).toBe('1. parent\n\n   1. child');
    });
  });

  // ---------------------------------------------------------------------------
  describe('task list', () => {
    it('unchecked and checked items', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false }, content: [para(text('todo'))] },
            { type: 'taskItem', attrs: { checked: true }, content: [para(text('done'))] },
          ],
        }),
      );
      expect(out).toBe('- [ ] todo\n- [x] done');
    });

    it('empty task item keeps its marker', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'taskList',
          content: [{ type: 'taskItem', attrs: { checked: false }, content: [] }],
        }),
      );
      expect(out).toBe('- [ ]');
    });
  });

  // ---------------------------------------------------------------------------
  describe('blockquote', () => {
    it('single paragraph quote prefixes the line', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'blockquote', content: [para(text('quoted'))] }),
      );
      expect(out).toBe('> quoted');
    });

    it('multi-paragraph quote separates blocks with a bare ">" line', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'blockquote',
          content: [para(text('first')), para(text('second'))],
        }),
      );
      expect(out).toBe('> first\n>\n> second');
    });
  });

  // ---------------------------------------------------------------------------
  describe('breaks and rules', () => {
    it('horizontal rule', () => {
      expect(
        convertProseMirrorToMarkdown(doc({ type: 'horizontalRule' })),
      ).toBe('---');
    });

    it('hard break emits two trailing spaces then newline', () => {
      const out = convertProseMirrorToMarkdown(
        doc(para(text('a'), { type: 'hardBreak' }, text('b'))),
      );
      expect(out).toBe('a  \nb');
    });
  });

  // ---------------------------------------------------------------------------
  describe('tables', () => {
    it('GFM table emits alignment markers derived from header cells', () => {
      const headerRow = {
        type: 'tableRow',
        content: [
          { type: 'tableHeader', attrs: { align: 'left' }, content: [para(text('L'))] },
          { type: 'tableHeader', attrs: { align: 'center' }, content: [para(text('C'))] },
          { type: 'tableHeader', attrs: { align: 'right' }, content: [para(text('R'))] },
          { type: 'tableHeader', content: [para(text('N'))] },
        ],
      };
      const bodyRow = {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [para(text('1'))] },
          { type: 'tableCell', content: [para(text('2'))] },
          { type: 'tableCell', content: [para(text('3'))] },
          { type: 'tableCell', content: [para(text('4'))] },
        ],
      };
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'table', content: [headerRow, bodyRow] }),
      );
      expect(out).toBe(
        [
          '| L | C | R | N |',
          '| :-- | :-: | --: | --- |',
          '| 1 | 2 | 3 | 4 |',
        ].join('\n'),
      );
    });

    it('spanned table (colspan/rowspan) emits raw <table> HTML', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: { colspan: 2 },
                  content: [para(text('wide'))],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [para(text('a'))] },
                { type: 'tableCell', content: [para(text('b'))] },
              ],
            },
          ],
        }),
      );
      expect(out).toBe(
        '<table><tbody>' +
          '<tr><th colspan="2"><p>wide</p></th></tr>' +
          '<tr><td><p>a</p></td><td><p>b</p></td></tr>' +
          '</tbody></table>',
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('callout and details', () => {
    it('callout uses lowercased type fence', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'callout',
          attrs: { type: 'WARNING' },
          content: [para(text('beware'))],
        }),
      );
      expect(out).toBe('> [!warning]\n> beware');
    });

    it('callout defaults to info', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'callout', content: [para(text('hi'))] }),
      );
      expect(out).toBe('> [!info]\n> hi');
    });

    it('details emits summary + content wrapped in <details>', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'details',
          content: [
            { type: 'detailsSummary', content: [text('Title')] },
            { type: 'detailsContent', content: [para(text('Body'))] },
          ],
        }),
      );
      // details joins its children with "\n"; summary opens, content closes.
      expect(out).toBe('<details>\n<summary>Title</summary>\n\nBody\n</details>');
    });
  });

  // ---------------------------------------------------------------------------
  describe('math', () => {
    it('inline math serializes as $LaTeX$ (Obsidian-native), no HTML escaping', () => {
      const out = convertProseMirrorToMarkdown(
        doc(para({ type: 'mathInline', attrs: { text: 'a < b' } })),
      );
      // #293 canon #6: readable `$…$` form; the LaTeX is verbatim (no HTML
      // attribute escaping of < or & in the fence form).
      expect(out).toBe('$a < b$');
      expect(out).not.toContain('&lt;');
      expect(out).not.toContain('<span');
    });

    it('block math serializes as a $$ fence on its own lines', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'mathBlock', attrs: { text: 'x > y & z' } }),
      );
      // #293 canon #6: `$$\n<latex>\n$$`. The LaTeX is verbatim inside the fence
      // (plain markdown, so & is NOT entity-escaped as it would be in an attr).
      expect(out).toBe('$$\nx > y & z\n$$');
      expect(out).not.toContain('&amp;');
      expect(out).not.toContain('<div');
    });
  });

  // ---------------------------------------------------------------------------
  describe('inline atoms and media', () => {
    it('mention emits schema span with data-* attrs and visible label', () => {
      const out = convertProseMirrorToMarkdown(
        doc(
          para({
            type: 'mention',
            attrs: { id: 'u1', label: 'Alice', entityType: 'user' },
          }),
        ),
      );
      expect(out).toBe(
        '<span data-type="mention" data-id="u1" data-label="Alice" data-entity-type="user">@Alice</span>',
      );
    });

    it('attachment emits link-form [name](url) + discriminator comment (#293 #8)', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'attachment',
          attrs: { url: '/files/x.zip', name: 'x.zip', mime: 'application/zip', size: 99 },
        }),
      );
      // #293 canon #8: url is the markdown target, name is the visible link text,
      // and every other attr rides in the ALWAYS-emitted `attachment` comment.
      expect(out).toBe(
        '[x.zip](/files/x.zip)<!--attachment {"mime":"application/zip","size":"99"}-->',
      );
    });

    it('video emits image-form ![](src) + discriminator comment (#293 #8)', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'video',
          attrs: { src: '/v.mp4', alt: 'clip', width: 640 },
        }),
      );
      expect(out).toBe('![](/v.mp4)<!--video {"alt":"clip","width":"640"}-->');
    });

    it('youtube emits image-form ![](src) + discriminator comment (#293 #8)', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'youtube',
          attrs: { src: 'https://youtu.be/abc', width: 560, height: 315 },
        }),
      );
      expect(out).toBe(
        '![](https://youtu.be/abc)<!--youtube {"width":"560","height":"315"}-->',
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('null content returns ""', () => {
      expect(convertProseMirrorToMarkdown(null)).toBe('');
    });

    it('empty object returns ""', () => {
      expect(convertProseMirrorToMarkdown({})).toBe('');
    });

    it('doc with no content returns ""', () => {
      expect(convertProseMirrorToMarkdown({ type: 'doc' })).toBe('');
    });

    it('unknown node type falls back to children-only (no throw, text preserved)', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'totallyUnknownType', content: [text('kept')] }),
      );
      expect(out).toBe('kept');
    });

    it('deeply nested structure does not stack-overflow', () => {
      // Build a deeply nested bullet list (each level holds one nested list).
      let node: any = { type: 'listItem', content: [para(text('leaf'))] };
      for (let i = 0; i < 200; i++) {
        node = {
          type: 'listItem',
          content: [para(text('lvl')), { type: 'bulletList', content: [node] }],
        };
      }
      const root = doc({ type: 'bulletList', content: [node] });
      expect(() => convertProseMirrorToMarkdown(root)).not.toThrow();
      const out = convertProseMirrorToMarkdown(root);
      expect(out).toContain('leaf');
      expect(out.startsWith('- lvl')).toBe(true);
    });
  });

  // ===========================================================================
  // Targeted coverage for marker-width-scaled list indent, the markdown
  // link-title escape branch, the markdown callout fence, and the blockquote
  // per-line prefixer over a multi-line nested-block child. Grounded against
  // the real converter output (verified empirically) — see processListItem /
  // indentItemChildren (src 812-843), the link mark branch (src 117-121), the
  // callout case (src 373-376), and the blockquote prefixer (src 210-221).
  describe('marker-width / link-title / callout / blockquote-nested', () => {
    // Spec 1 — two-digit ordered marker scales the continuation indent to 4.
    it('indents a nested ordered sublist under item 10 by 4 spaces (marker "10. ")', () => {
      // Items 1..10 ("a".."j"); the 10th additionally holds a nested
      // orderedList with one paragraph "x".
      const items: any[] = [];
      for (let i = 0; i < 9; i++) {
        items.push({
          type: 'listItem',
          content: [para(text(String.fromCharCode(97 + i)))], // 'a'..'i'
        });
      }
      items.push({
        type: 'listItem',
        content: [
          para(text('j')),
          {
            type: 'orderedList',
            content: [{ type: 'listItem', content: [para(text('x'))] }],
          },
        ],
      });

      const out = convertProseMirrorToMarkdown(
        doc({ type: 'orderedList', content: items }),
      );

      // The 10th marker is the 4-column "10. "; the nested sublist line must be
      // indented exactly 4 spaces (prefix.length 3 + 1), NOT 3. Block children are
      // blank-line separated (loose list) per the #351 fix.
      expect(out).toContain('10. j\n\n    1. x');
      // Guard against the off-by-one (3-space) regression that would re-parse
      // the sublist as loose/sibling content on import.
      expect(out).not.toContain('10. j\n\n   1. x');
      // And the single-digit items keep the narrower 3-column marker (no body
      // continuation here, but the marker itself must stay "1. ".."9. ").
      expect(out.startsWith('1. a\n2. b\n')).toBe(true);
      expect(out).toContain('\n9. i\n10. j');
    });

    // Spec 2 — markdown link-title branch escapes an embedded double quote and
    // emits the href raw.
    it('escapes an embedded double-quote in a markdown link title and emits href raw', () => {
      const out = convertProseMirrorToMarkdown(
        doc(
          para(
            text('lbl', [
              {
                type: 'link',
                attrs: { href: 'http://a', title: 'he said "hi"' },
              },
            ]),
          ),
        ),
      );
      // The title's " is backslash-escaped (.replace(/"/g,'\\"')) so it cannot
      // terminate the (url "title") syntax early; the href is RAW (not escaped).
      expect(out).toBe('[lbl](http://a "he said \\"hi\\"")');
    });

    // Spec 3 — markdown callout fence lowercases the type and joins multiple
    // paragraph children.
    it('lowercases an uppercase callout type and joins its paragraphs', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'callout',
          attrs: { type: 'WARNING' },
          content: [para(text('line1')), para(text('line2'))],
        }),
      );
      // The converter emits an Obsidian-native callout: a `> [!type]` opener plus
      // one `>`-prefixed body line per content line. Block children are separated
      // by a blank `>` line (#351 fix): a single '\n' let the two paragraphs merge
      // into one on re-parse. We pin the lowercasing (WARNING -> warning) and the
      // blank-line-separated multi-child join.
      expect(out).toBe('> [!warning]\n> line1\n>\n> line2');
      // The type is lowercased (an uppercase `[!WARNING]` would not re-import).
      expect(out.startsWith('> [!warning]\n')).toBe(true);
      expect(out).not.toContain('[!WARNING]');
      // Both paragraph children are present, each blockquote-prefixed, blank-`>`
      // separated so they stay distinct paragraphs on re-parse.
      expect(out).toContain('> line1\n>\n> line2');
    });

    // Spec 4 — blockquote per-line prefixer over a multi-line nested callout.
    it('prefixes every line of a nested callout child with "> "', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'blockquote',
          content: [
            {
              type: 'callout',
              attrs: { type: 'INFO' },
              content: [para(text('a')), para(text('b'))],
            },
          ],
        }),
      );
      // The nested callout renders as an Obsidian callout '> [!info]\n> a\n>\n> b'
      // (blank-`>` separated children per the #351 fix). The outer blockquote
      // prefixer then prefixes each of those lines with '> ' again, yielding a
      // doubly-nested blockquote — the per-line-prefix loop over a multi-line child.
      expect(out).toBe('> > [!info]\n> > a\n> >\n> > b');
      // Every produced line carries the '> ' prefix (no line escapes to col 0).
      for (const line of out.split('\n')) {
        expect(line.startsWith('>')).toBe(true);
      }
    });

    // The empty-line '>' branch from Spec 4's intent IS reachable — just not via
    // the nested callout (whose body has no blank line). A two-paragraph
    // blockquote DOES separate its block children with a bare '>' line, which is
    // the branch the spec wanted to protect. Pin it directly so the
    // (line.length ? '> ' : '>') empty-line path stays covered.
    it('maps an internal blank line to a bare ">" (not "> ") in a multi-block quote', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'blockquote',
          content: [para(text('p1')), para(text('p2'))],
        }),
      );
      expect(out).toBe('> p1\n>\n> p2');
      // The separator line is exactly '>' with NO trailing space.
      expect(out.split('\n')).toContain('>');
      expect(out).not.toContain('> \n');
    });
  });
});
