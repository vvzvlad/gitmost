import { describe, expect, it } from 'vitest';
// Import the converter DIRECTLY from src (NOT the docmost-client barrel, which
// pulls in collaboration.ts and mutates the global DOM at import time), matching
// the other converter unit tests (see markdown-converter-gaps.test.ts).
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';

// Minimal ProseMirror builders. The top-level converter joins doc children with
// "\n\n" then .trim()s, so a single-node doc yields exactly that node's rendered
// (trimmed) string.
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

// A columns node carrying a SINGLE column, whose content is the supplied block
// children. columns/column are raw-HTML containers, so their children render via
// blockToHtml -> inlineToHtml (the HTML-mirroring path under test).
const oneColumn = (...blocks: any[]) => ({
  type: 'columns',
  attrs: { layout: 'two' },
  content: [{ type: 'column', content: blocks }],
});

// Extract the inner HTML of the single column from a rendered columns string.
// Output shape is:
//   <div data-type="columns" data-layout="two"><div data-type="column">INNER</div></div>
const COLUMN_PREFIX =
  '<div data-type="columns" data-layout="two"><div data-type="column">';
const COLUMN_SUFFIX = '</div></div>';
const columnInner = (rendered: string): string => {
  expect(rendered.startsWith(COLUMN_PREFIX)).toBe(true);
  expect(rendered.endsWith(COLUMN_SUFFIX)).toBe(true);
  return rendered.slice(COLUMN_PREFIX.length, rendered.length - COLUMN_SUFFIX.length);
};

// ---------------------------------------------------------------------------
// 1. inlineToHtml mark-mirroring INSIDE a raw-HTML container (columns).
//
// At the TOP level the `text` case emits markdown markers (**, *, ``, ~~) for
// bold/italic/code/strike. But inside columns (and spanned table cells) the
// content is raw HTML that marked will NOT re-parse, so inlineToHtml
// (markdown-converter.ts lines 599-619) MUST mirror each mark to HTML instead:
// bold-><strong>, italic-><em>, code-><code>, strike-><s>, underline-><u>. This
// is a DISTINCT branch from the top-level mark path; if it leaked markdown, the
// literal ** / `` would survive as text on re-import.
// ---------------------------------------------------------------------------
describe('inlineToHtml: bold/italic/code/strike/underline -> HTML inside columns', () => {
  it('mirrors each single-mark run to its schema HTML tag (not markdown markers)', () => {
    const out = convertProseMirrorToMarkdown(
      doc(
        oneColumn(
          para(
            text('b', [{ type: 'bold' }]),
            text('i', [{ type: 'italic' }]),
            text('c', [{ type: 'code' }]),
            text('s', [{ type: 'strike' }]),
            text('u', [{ type: 'underline' }]),
          ),
        ),
      ),
    );
    expect(out).toBe(
      '<div data-type="columns" data-layout="two">' +
        '<div data-type="column">' +
        '<p><strong>b</strong><em>i</em><code>c</code><s>s</s><u>u</u></p>' +
        '</div></div>',
    );
    // Belt-and-suspenders: none of the top-level markdown markers leaked.
    expect(out).not.toContain('**');
    expect(out).not.toContain('~~');
    expect(out).not.toContain('`');
  });
});

// ---------------------------------------------------------------------------
// 2. inlineToHtml: link/hardBreak/highlight/textStyle/comment inside columns.
//
// Exercises the remaining inlineToHtml branches that are uncovered inside a
// raw-HTML container: link href escaping via escapeAttr (line 621; & -> &amp;,
// " -> &quot;), hardBreak -> <br> (line 591), highlight WITH vs WITHOUT color
// (624-626), textStyle color (628-630), and comment with data-resolved (632-638).
// ---------------------------------------------------------------------------
describe('inlineToHtml: link/hardBreak/highlight/textStyle/comment inside columns', () => {
  it('escapes link hrefs, emits <br>, plain/colored <mark>, span color, and resolved comment', () => {
    const out = convertProseMirrorToMarkdown(
      doc(
        oneColumn(
          para(
            text('lnk', [{ type: 'link', attrs: { href: 'http://a?b&c"d' } }]),
            { type: 'hardBreak' },
            text('hl', [{ type: 'highlight', attrs: { color: '#ff0000' } }]),
            text('plain', [{ type: 'highlight' }]),
            text('clr', [{ type: 'textStyle', attrs: { color: 'red' } }]),
            text('cm', [
              { type: 'comment', attrs: { commentId: 'c1', resolved: true } },
            ]),
          ),
        ),
      ),
    );
    expect(columnInner(out)).toBe(
      '<p>' +
        '<a href="http://a?b&amp;c&quot;d">lnk</a>' +
        '<br>' +
        '<mark style="background-color: #ff0000">hl</mark>' +
        '<mark>plain</mark>' +
        '<span style="color: red">clr</span>' +
        '<span data-comment-id="c1" data-resolved="true">cm</span>' +
        '</p>',
    );
  });

  it('omits data-resolved when the comment is not resolved', () => {
    // The resolved sub-branch (632-638) is load-bearing: an unresolved comment
    // must emit a bare data-comment-id span with NO data-resolved attribute.
    const out = convertProseMirrorToMarkdown(
      doc(
        oneColumn(
          para(
            text('cm', [
              { type: 'comment', attrs: { commentId: 'c1', resolved: false } },
            ]),
          ),
        ),
      ),
    );
    expect(columnInner(out)).toBe('<p><span data-comment-id="c1">cm</span></p>');
    expect(out).not.toContain('data-resolved');
  });
});

// ---------------------------------------------------------------------------
// 3. blockToHtml non-paragraph branches inside columns: heading / codeBlock /
//    bulletList.
//
// heading -> <hN> (718-721), codeBlock with-language vs no-language class fork
// (730-742; the no-language `cls = ''` branch at 741 yields a BARE <code> with
// no class), and bulletList -> <ul><li><p>...</p></li></ul> (722-725). Code text
// is element TEXT content, so it is escapeHtmlText-escaped (not the attr escaper),
// and embedded newlines are preserved verbatim.
// ---------------------------------------------------------------------------
describe('blockToHtml: heading / codeBlock(lang & no-lang) / bulletList inside columns', () => {
  it('emits <hN>, language vs bare <pre><code>, and <ul><li><p>..</p></li>', () => {
    const out = convertProseMirrorToMarkdown(
      doc(
        oneColumn(
          { type: 'heading', attrs: { level: 2 }, content: [text('H')] },
          {
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [text('a\nb')],
          },
          { type: 'codeBlock', content: [text('plain')] },
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [para(text('item'))] },
            ],
          },
        ),
      ),
    );
    expect(columnInner(out)).toBe(
      '<h2>H</h2>' +
        '<pre><code class="language-js">a\nb</code></pre>' +
        '<pre><code>plain</code></pre>' +
        '<ul><li><p>item</p></li></ul>',
    );
    // The no-language codeBlock must NOT carry a class attribute (the cls=''
    // fork at line 741): its <code> opens bare.
    expect(out).toContain('<pre><code>plain</code></pre>');
  });
});

// ---------------------------------------------------------------------------
// 4. Spanned-table renderHtmlCell + orderedList block child (HTML fallback).
//
// A colspan>1 cell forces the WHOLE table to the raw-<table> HTML fallback
// (markdown-converter.ts ~287-331). renderHtmlCell emits colspan + align attrs
// (312-316) and renders each block child via blockToHtml. An orderedList child
// hits the blockToHtml orderedList branch, which emits
// <ol start="N"><li><p>..</p></li>..</ol> — the schema's non-1 `start` attr IS
// emitted by this HTML <ol> branch (FIXED #351).
// ---------------------------------------------------------------------------
describe('spanned table: renderHtmlCell colspan/align + orderedList block child', () => {
  it('renders the colspan/align cell with an <ol start="N"> (start attr preserved)', () => {
    const out = convertProseMirrorToMarkdown(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 2, align: 'center' },
                content: [
                  {
                    type: 'orderedList',
                    attrs: { start: 3 },
                    content: [
                      { type: 'listItem', content: [para(text('one'))] },
                      { type: 'listItem', content: [para(text('two'))] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(out).toBe(
      '<table><tbody><tr>' +
        '<td colspan="2" align="center">' +
        '<ol start="3"><li><p>one</p></li><li><p>two</p></li></ol>' +
        '</td>' +
        '</tr></tbody></table>',
    );
    // The HTML <ol> branch propagates the ProseMirror `start` attribute.
    expect(out).toContain('start="3"');
  });
});
