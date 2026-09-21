import { describe, expect, it } from 'vitest';
// Import the converter DIRECTLY from src (NOT the docmost-client barrel, which
// pulls in collaboration.ts and mutates the global DOM at import time), matching
// the other converter unit tests. markdownToProseMirror is imported for the
// round-trip cases; loading it mutates the global DOM via jsdom (required for
// @tiptap/html's generateJSON under Node) — this is expected.
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

// Wrap one or more nodes in a minimal ProseMirror doc. The top-level converter
// joins doc children with "\n\n" then .trim()s, so a single-node doc yields
// exactly that node's rendered (trimmed) string.
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const text = (t: string) => ({ type: 'text', text: t });
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

// Run a full export -> import -> export cycle and return both markdown strings
// plus the intermediate ProseMirror doc (mirrors the property test's helper).
async function roundTrip(node: any): Promise<{ md1: string; doc2: any; md2: string }> {
  const md1 = convertProseMirrorToMarkdown(doc(node));
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, doc2, md2 };
}

// ---------------------------------------------------------------------------
// 1. pageBreak DATA LOSS (markdown-converter.ts has NO `case "pageBreak"`).
//
// The schema declares a `pageBreak` block atom (docmost-schema.ts ~L1009), so a
// real document CAN legally contain one. The converter's switch has no branch
// for it, so it falls through to `default`, which renders only the node's
// children — and a pageBreak atom has NONE. It therefore exports to "" and the
// node silently disappears: an exported markdown file can never carry a page
// break, and a round-trip cannot reconstruct it. We pin this as a known
// divergence with an `it.fails` round-trip repro (mirroring the package's two
// existing documented `it.fails` bugs in markdown-roundtrip.property.test.ts).
// ---------------------------------------------------------------------------
describe('pageBreak data loss (no converter case — SPEC §11 divergence)', () => {
  it('exports a pageBreak node to the standalone comment (#293 #5)', () => {
    // #293 canon #5: a standalone pageBreak now serializes as the readable,
    // renderer-invisible comment `<!--pagebreak-->` (re-materialized on import),
    // instead of the earlier raw <div> block.
    expect(convertProseMirrorToMarkdown(doc({ type: 'pageBreak' }))).toBe(
      '<!--pagebreak-->',
    );
  });

  it('keeps a pageBreak sitting BETWEEN two paragraphs on export', () => {
    // With surrounding content the divider is emitted as its own comment line
    // between the two paragraphs (joined by the doc "\n\n"), no longer dropped.
    const out = convertProseMirrorToMarkdown(
      doc(para(text('before')), { type: 'pageBreak' }, para(text('after'))),
    );
    expect(out).toBe(
      'before\n\n<!--pagebreak-->\n\nafter',
    );
    expect(out).toContain('<!--pagebreak-->');
  });

  // FIXED: a pageBreak node now survives an export -> import -> export cycle
  // because the FIRST export emits the standalone comment, which the importer
  // materializes back into a pageBreak node again.
  it('a pageBreak node round-trips (export -> import yields a pageBreak)', async () => {
    const { md1, doc2 } = await roundTrip({ type: 'pageBreak' });
    expect(md1).not.toBe('');
    const types = (doc2.content || []).map((n: any) => n.type);
    expect(types).toContain('pageBreak');
  });
});

// ---------------------------------------------------------------------------
// 2. subpages round-trip (#293 #5 standalone comment).
//
// It used to emit the literal `{{SUBPAGES}}`, which has no markdown/HTML meaning,
// so on re-import the subpages BLOCK came back as a plain PARAGRAPH carrying the
// literal string (the embed rendered as visible "{{SUBPAGES}}" text on the page
// after a sync — data loss). Per canon #5 it now emits the standalone comment
// `<!--subpages-->`, which the importer materializes back into a subpages node.
// ---------------------------------------------------------------------------
describe('subpages round-trip (standalone comment #293 #5)', () => {
  it('emits the subpages comment and re-imports as a subpages node (no literal leak)', async () => {
    const { md1, doc2 } = await roundTrip({ type: 'subpages' });
    expect(md1).toBe('<!--subpages-->');

    const collect = (n: any): string[] => [
      n.type,
      ...((n.content || []) as any[]).flatMap(collect),
    ];
    const allTypes = (doc2.content || []).flatMap(collect);
    // The subpages node survives, and no literal {{SUBPAGES}} text leaked back.
    expect(allTypes).toContain('subpages');
    expect(JSON.stringify(doc2)).not.toContain('{{SUBPAGES}}');
  });
});

// ---------------------------------------------------------------------------
// 3. column.width number<->string drift (`case "column"` + width parseHTML).
//
// The converter emits the width verbatim into `data-width="..."` (a STRING in
// the HTML, as all HTML attributes are). On import the schema's `column.width`
// parseHTML does `parseFloat(value)`, so the attribute always comes back as a
// NUMBER. A document authored/stored with a STRING fractional width therefore
// DRIFTS to a number across a round-trip at the ProseMirror-doc level — even
// though the emitted MARKDOWN stays byte-stable (the number prints the same).
// Pinned here as a documented attribute-type divergence (SPEC §11).
// ---------------------------------------------------------------------------
describe('column.width number<->string drift (schema parseFloat — SPEC §11)', () => {
  const columnsWith = (width: any) => ({
    type: 'columns',
    attrs: { layout: 'two' },
    content: [
      { type: 'column', attrs: { width }, content: [para(text('L'))] },
      { type: 'column', content: [para(text('R'))] },
    ],
  });

  it('a STRING fractional width drifts to a NUMBER across the round-trip', async () => {
    const { md1, doc2, md2 } = await roundTrip(columnsWith('33.3'));

    // The emitted markdown carries the value as an HTML attribute string and is
    // byte-stable across the cycle (the divergence is at the doc level only).
    expect(md1).toContain('data-width="33.3"');
    expect(md2).toBe(md1);

    // But the doc attribute type changed: authored as string "33.3", it comes
    // back as the number 33.3 (schema's parseFloat). This is the drift.
    const rtWidth = doc2.content?.[0]?.content?.[0]?.attrs?.width;
    expect(typeof rtWidth).toBe('number');
    expect(rtWidth).toBe(33.3);
  });

  it('a NUMBER fractional width keeps its value (no precision loss) and is byte-stable', async () => {
    const { md1, doc2, md2 } = await roundTrip(columnsWith(33.333333));
    expect(md1).toContain('data-width="33.333333"');
    expect(md2).toBe(md1);
    const rtWidth = doc2.content?.[0]?.content?.[0]?.attrs?.width;
    expect(typeof rtWidth).toBe('number');
    expect(rtWidth).toBe(33.333333);
  });
});

// ---------------------------------------------------------------------------
// 5b. EMPTY detailsContent (`case "details"` with an empty body).
//
// detailsContent's schema content is `block*` (docmost-schema.ts ~L474), so an
// empty details body is legal. The converter must handle a `detailsContent`
// with no children without crashing and without emitting invalid output that
// breaks the round-trip. This pins that an empty details body exports cleanly
// and re-imports as a valid `details` whose body is an empty `detailsContent`.
// ---------------------------------------------------------------------------
describe('empty detailsContent (schema allows block*)', () => {
  const emptyDetails = doc({
    type: 'details',
    content: [
      { type: 'detailsSummary', content: [text('Summary')] },
      { type: 'detailsContent', content: [] },
    ],
  });

  it('exports an empty details body without crashing or producing junk', () => {
    const md = convertProseMirrorToMarkdown(emptyDetails);
    // The summary survives and the <details> wrapper closes; the empty body adds
    // no content of its own.
    expect(md).toContain('<summary>Summary</summary>');
    expect(md).toContain('</details>');
    expect(md).not.toContain('undefined');
    expect(md).not.toContain('null');
  });

  it('round-trips to a valid details with an empty detailsContent body', async () => {
    const md1 = convertProseMirrorToMarkdown(emptyDetails);
    const doc2 = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(doc2);
    // Export is byte-stable (no growth / no junk on the second pass).
    expect(md2).toBe(md1);

    // The re-imported tree is a details with summary + an empty content body.
    const details = doc2.content?.[0];
    expect(details?.type).toBe('details');
    const childTypes = (details?.content || []).map((c: any) => c.type);
    expect(childTypes).toEqual(['detailsSummary', 'detailsContent']);
    const detailsContent = details.content.find(
      (c: any) => c.type === 'detailsContent',
    );
    // block* — an empty body has no (or empty) content, which is valid.
    expect(detailsContent.content == null || detailsContent.content.length === 0).toBe(
      true,
    );
  });
});

// ===========================================================================
// CONVERTER GAP COVERAGE (specs 1–29)
//
// These describe the converter's exact emission for under-tested branches and,
// for the round-trip cases, pin export byte-stability and/or documented data
// loss. docsCanonicallyEqual is imported here (not at the top) to keep the
// existing block's imports untouched. heading/col are local helpers; doc/text/
// para are reused from the top of the file.
// ===========================================================================
import { docsCanonicallyEqual } from '../src/lib/canonicalize.js';

const heading = (level: number, ...inline: any[]) => ({
  type: 'heading',
  attrs: { level },
  content: inline,
});
// A two-layout columns block carrying a single column with exactly one child —
// the shared shape for the raw-HTML-container round-trip specs (15, 17–29).
const oneColumn = (child: any) => ({
  type: 'columns',
  attrs: { layout: 'two' },
  content: [{ type: 'column', content: [child] }],
});
// Extract the single column's single child node from a round-tripped doc.
const colChildOf = (doc2: any) =>
  doc2?.content?.[0]?.content?.[0]?.content?.[0];

describe('converter gap coverage — emission branches (specs 1–11)', () => {
  // 1. orderedList honors the start attribute (FIXED #351): markers count up
  //    from `start` ("5.","6.",…), which CommonMark round-trips.
  it('orderedList start:5 numbers from 5 (start attr honored)', () => {
    const out = convertProseMirrorToMarkdown(
      doc({
        type: 'orderedList',
        attrs: { start: 5 },
        content: [
          { type: 'listItem', content: [para(text('a'))] },
          { type: 'listItem', content: [para(text('b'))] },
        ],
      }),
    );
    expect(out).toBe('5. a\n6. b');
  });

  // 2. An empty paragraph contributes an empty segment between two "\n\n" joins.
  it('an empty paragraph between two paragraphs yields doubled blank lines', () => {
    const out = convertProseMirrorToMarkdown(
      doc(para(text('a')), { type: 'paragraph' }, para(text('b'))),
    );
    expect(out).toBe('a\n\n\n\nb');
  });

  // 3. A code block inside a blockquote: every physical line gets "> ".
  it('a codeBlock inside a blockquote prefixes every fence/code line with "> "', () => {
    const out = convertProseMirrorToMarkdown(
      doc({
        type: 'blockquote',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [text('a\nb')],
          },
        ],
      }),
    );
    expect(out).toBe('> ```js\n> a\n> b\n> ```');
  });

  // 4. A body cell with TWO block children (paragraph + bulletList) cannot be a
  //    GFM pipe row (inline-only). #8 emits the WHOLE table as HTML <table> so
  //    the paragraph and the list each survive as their own block instead of
  //    being lossily flattened into one "p1 - a" pipe cell.
  it('a table cell with paragraph+list emits an HTML <table> (blocks preserved)', () => {
    const out = convertProseMirrorToMarkdown(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{ type: 'tableHeader', content: [para(text('h'))] }],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [
                  para(text('p1')),
                  {
                    type: 'bulletList',
                    content: [{ type: 'listItem', content: [para(text('a'))] }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(out).toBe(
      '<table><tbody><tr><th><p>h</p></th></tr><tr><td><p>p1</p><ul><li><p>a</p></li></ul></td></tr></tbody></table>',
    );
  });

  // 5. code + link co-occur (#515): the `code` mark no longer excludes the other
  //    marks, so a linked code span keeps BOTH — the backtick span is the link
  //    TEXT (CommonMark: [`x`](href) is <a><code>x</code></a>), which is exactly
  //    what the importer rebuilds.
  it('a code+link run emits the code span as the link text (#515)', () => {
    const out = convertProseMirrorToMarkdown(
      doc(
        para({
          type: 'text',
          text: 'x',
          marks: [
            { type: 'code' },
            { type: 'link', attrs: { href: 'http://a?b&c"d' } },
          ],
        }),
      ),
    );
    expect(out).toBe('[`x`](http://a?b&c"d)');
  });

  // 6. hardBreak inside a heading: prefix applied once, "  \n" between a and b.
  it('a hardBreak inside an h2 heading produces "## a  \\nb"', () => {
    const out = convertProseMirrorToMarkdown(
      doc(heading(2, text('a'), { type: 'hardBreak' }, text('b'))),
    );
    expect(out).toBe('## a  \nb');
  });

  // 7. encodeMdUrl's non-space whitespace sub-path: a newline -> %0A.
  it('an image src containing a newline percent-encodes it to %0A', () => {
    const out = convertProseMirrorToMarkdown(
      doc({ type: 'image', attrs: { alt: 'cap', src: '/a\nb.png' } }),
    );
    expect(out).toBe('![cap](/a%0Ab.png)');
  });

  // 8. spanned-table HTML fallback: rowspan>1 AND align cell-attr branches, <td>.
  it('a spanned cell with rowspan+align emits <td rowspan align> in that order', () => {
    const out = convertProseMirrorToMarkdown(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { rowspan: 2, align: 'center' },
                content: [para(text('m'))],
              },
            ],
          },
        ],
      }),
    );
    expect(out).toBe(
      '<table><tbody><tr><td rowspan="2" align="center"><p>m</p></td></tr></tbody></table>',
    );
  });

  // 9. taskItem fixed indent width of 2 (NOT prefix.length+1) for a nested sublist.
  it('a task item with a nested bullet sublist indents the sublist by 2 columns', () => {
    const out = convertProseMirrorToMarkdown(
      doc({
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [
              para(text('top')),
              {
                type: 'bulletList',
                content: [
                  { type: 'listItem', content: [para(text('child'))] },
                ],
              },
            ],
          },
        ],
      }),
    );
    // Block children of a task item are blank-line separated (loose list) per the
    // #351 fix; the sublist stays at the fixed 2-column continuation indent.
    expect(out).toBe('- [ ] top\n\n  - child');
  });

  // 10. A bulletList inside a blockquote: each list line independently prefixed.
  it('a bulletList inside a blockquote prefixes every list line with "> "', () => {
    const out = convertProseMirrorToMarkdown(
      doc({
        type: 'blockquote',
        content: [
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [para(text('x'))] },
              { type: 'listItem', content: [para(text('y'))] },
            ],
          },
        ],
      }),
    );
    expect(out).toBe('> - x\n> - y');
  });

  // 11. A non-spanned cell with TWO block paragraphs: #8 emits the whole table
  //     as HTML <table>, so each paragraph stays its own <p> and the literal
  //     pipe needs no escaping inside HTML text (the old GFM path space-joined
  //     the blocks into one line and escaped the pipe to \|).
  it('a table cell with two paragraphs emits an HTML <table> (blocks kept, no pipe-escape)', () => {
    const out = convertProseMirrorToMarkdown(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{ type: 'tableHeader', content: [para(text('h'))] }],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [para(text('a|b')), para(text('c'))],
              },
            ],
          },
        ],
      }),
    );
    expect(out).toBe(
      '<table><tbody><tr><th><p>h</p></th></tr><tr><td><p>a|b</p><p>c</p></td></tr></tbody></table>',
    );
  });
});

describe('converter gap coverage — formerly-lossy round-trips, now closed (specs 12–14)', () => {
  // 12. A 3-backtick fence inside a codeBlock body is now lengthened: the outer
  //     fence widens to (longest inner run + 1) backticks per CommonMark, so the
  //     inner ``` is treated as content and the block survives as ONE node.
  it('a triple-backtick fence inside a codeBlock body round-trips via a widened fence', async () => {
    const d = doc({
      type: 'codeBlock',
      attrs: { language: 'js' },
      content: [{ type: 'text', text: '```\ninner\n```' }],
    });
    const md1 = convertProseMirrorToMarkdown(d);
    // Outer fence widened to 4 backticks; the inner 3-backtick fence is content.
    expect(md1).toBe('````js\n```\ninner\n```\n````');

    const doc2 = await markdownToProseMirror(md1);
    // The block survives as a SINGLE code block (no premature split).
    const top = doc2.content || [];
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe('codeBlock');
    expect(top[0].attrs?.language).toBe('js');
    expect(top[0].content?.[0]?.text).toContain('```\ninner\n```');

    const md2 = convertProseMirrorToMarkdown(doc2);
    expect(md2).toBe(md1); // byte-stable
    // Canonically the re-imported code text gains a single trailing newline
    // (marked re-adds it; the exporter strips it back, hence byte stability).
    // The fence is no longer lossy: the inner fence and content fully survive.
    expect(docsCanonicallyEqual(d, doc2)).toBe(false);
  });

  // 13. #493 commit 1: a leading ordered-list marker in paragraph text is now
  //     BLOCK-ESCAPED, so the paragraph round-trips as a paragraph instead of
  //     silently becoming an orderedList (was documented data loss, now closed).
  it('a paragraph starting with "1. " is block-escaped and stays a paragraph', async () => {
    const d = doc({
      type: 'paragraph',
      content: [{ type: 'text', text: '1. not a list' }],
    });
    const md1 = convertProseMirrorToMarkdown(d);
    expect(md1).toBe('1\\. not a list'); // the ordered-list delimiter is escaped

    const doc2 = await markdownToProseMirror(md1);
    expect(doc2.content?.[0]?.type).toBe('paragraph');
    expect(doc2.content[0].content?.[0]).toMatchObject({
      type: 'text',
      text: '1. not a list', // the escape decodes back to the literal text
    });
    expect(docsCanonicallyEqual(d, doc2)).toBe(true);
  });

  // 14. #293 canon #4: the image title now round-trips via the attached
  //     `<!--img {…}-->` comment (previously silently dropped).
  it('an image title attribute round-trips via the attached img-comment', async () => {
    const d = doc({
      type: 'image',
      attrs: { src: '/i.png', alt: 'a', title: 't"q' },
    });
    const md1 = convertProseMirrorToMarkdown(d);
    // The quote in the title is JSON-escaped inside the comment payload.
    expect(md1).toBe('![a](/i.png) <!--img {"title":"t\\"q"}-->');

    const doc2 = await markdownToProseMirror(md1);
    const img = (doc2.content || []).find((n: any) => n.type === 'image');
    expect(img).toBeTruthy();
    expect(img.attrs?.title).toBe('t"q'); // restored byte-exact
    expect(img.attrs?.src).toBe('/i.png');
    expect(img.attrs?.alt).toBe('a');
    expect(docsCanonicallyEqual(d, doc2)).toBe(true);
  });
});

describe('converter gap coverage — raw-HTML container round-trips (specs 15–29)', () => {
  // 15. image inside a column: imageToHtml width+align arms; byte-stable; no
  //     literal-markdown text node leaks.
  it('an image in a column emits <img> (width/align arms) and round-trips byte-stable', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      oneColumn({
        type: 'image',
        attrs: { src: '/i.png', alt: 'cap', width: 320, align: 'center' },
      }),
    );
    // #293 canon #4: image align default is unified to "center", so a center
    // image inside a column no longer emits a redundant align="center".
    expect(md1).toBe(
      '<div data-type="columns" data-layout="two"><div data-type="column"><img src="/i.png" alt="cap" width="320"></div></div>',
    );
    expect(md2).toBe(md1);
    expect(colChildOf(doc2)?.type).toBe('image');
  });

  // 16. image inside a SPANNED table cell (the other raw-HTML container).
  it('an image in a spanned table cell emits <img> (width arm) and round-trips byte-stable', async () => {
    const { md1, md2 } = await roundTrip({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 2 },
              content: [
                {
                  type: 'image',
                  attrs: { src: '/i.png', alt: 'x', width: 100 },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(md1).toBe(
      '<table><tbody><tr><td colspan="2"><img src="/i.png" alt="x" width="100"></td></tr></tbody></table>',
    );
    expect(md2).toBe(md1);
  });

  // 17. callout inside a column: calloutToHtml lower-cases the type; byte-stable.
  it('a callout in a column emits the HTML div (type lower-cased) and round-trips', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      oneColumn({
        type: 'callout',
        attrs: { type: 'WARNING' },
        content: [para(text('a'))],
      }),
    );
    expect(md1).toBe(
      '<div data-type="columns" data-layout="two"><div data-type="column"><div data-type="callout" data-callout-type="warning"><p>a</p></div></div></div>',
    );
    expect(md2).toBe(md1);
    expect(colChildOf(doc2)?.type).toBe('callout');
  });

  // 18. details tree inside a column: summary via inlineToHtml, content via blockToHtml.
  it('a details tree in a column emits <details>/<summary>/<div detailsContent> and round-trips', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      oneColumn({
        type: 'details',
        content: [
          { type: 'detailsSummary', content: [text('S')] },
          { type: 'detailsContent', content: [para(text('body'))] },
        ],
      }),
    );
    expect(md1).toBe(
      '<div data-type="columns" data-layout="two"><div data-type="column"><details><summary data-type="detailsSummary">S</summary><div data-type="detailsContent"><p>body</p></div></details></div></div>',
    );
    expect(md2).toBe(md1);
    expect(colChildOf(doc2)?.type).toBe('details');
  });

  // 19. taskList inside a column: BOTH checked:true and checked:false arms.
  it('a taskList in a column emits both data-checked arms and round-trips', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      oneColumn({
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [para(text('done'))],
          },
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [para(text('todo'))],
          },
        ],
      }),
    );
    expect(md1).toBe(
      '<div data-type="columns" data-layout="two"><div data-type="column"><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li><li data-type="taskItem" data-checked="false"><p>todo</p></li></ul></div></div>',
    );
    expect(md2).toBe(md1);
    expect(colChildOf(doc2)?.type).toBe('taskList');
  });

  // 20. bare taskItem (no wrapping taskList) inside a column self-wraps.
  it('a bare taskItem in a column self-wraps in a single-item taskList and round-trips', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      oneColumn({
        type: 'taskItem',
        attrs: { checked: false },
        content: [para(text('lone'))],
      }),
    );
    expect(md1).toBe(
      '<div data-type="columns" data-layout="two"><div data-type="column"><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>lone</p></li></ul></div></div>',
    );
    expect(md2).toBe(md1);
    expect(colChildOf(doc2)?.type).toBe('taskList');
  });

  // 21. blockquote inside a column: real <blockquote>, not markdown "> q".
  it('a blockquote in a column emits <blockquote> and round-trips', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      oneColumn({ type: 'blockquote', content: [para(text('q'))] }),
    );
    expect(md1).toBe(
      '<div data-type="columns" data-layout="two"><div data-type="column"><blockquote><p>q</p></blockquote></div></div>',
    );
    expect(md2).toBe(md1);
    expect(colChildOf(doc2)?.type).toBe('blockquote');
  });

  // 22. horizontalRule inside a column: literal <hr>, not markdown "---".
  it('a horizontalRule in a column emits <hr> and round-trips', async () => {
    const { md1, doc2, md2 } = await roundTrip(
      oneColumn({ type: 'horizontalRule' }),
    );
    expect(md1).toBe(
      '<div data-type="columns" data-layout="two"><div data-type="column"><hr></div></div>',
    );
    expect(md2).toBe(md1);
    expect(colChildOf(doc2)?.type).toBe('horizontalRule');
  });

  // 23. Unknown block type with NON-text block children -> <div>-wrap of children.
  it('an unknown block with block children wraps them in <div> (no markdown leak)', () => {
    const md1 = convertProseMirrorToMarkdown(
      doc(
        oneColumn({
          type: 'someFutureBlock',
          content: [para(text('a')), para(text('b'))],
        }),
      ),
    );
    expect(md1).toContain('<div><p>a</p><p>b</p></div>');
    // No markdown paragraph separator survives inside the raw-HTML column.
    expect(md1).toBe(
      '<div data-type="columns" data-layout="two"><div data-type="column"><div><p>a</p><p>b</p></div></div></div>',
    );
  });

  // 24. Unknown block with ONLY inline/text children -> <div>inlineToHtml</div>.
  it('an unknown block with only inline children renders inline as HTML (marks not markdown)', () => {
    const md1 = convertProseMirrorToMarkdown(
      doc(
        oneColumn({
          type: 'someInlineOnlyBlock',
          content: [text('hi'), { type: 'text', text: '!', marks: [{ type: 'bold' }] }],
        }),
      ),
    );
    expect(md1).toContain('<div>hi<strong>!</strong></div>');
  });

  // 25. mathBlock inside a column delegates through processNode (NOT $$ fence).
  it('a mathBlock in a column delegates to processNode (HTML div, no $$ fence)', () => {
    const md1 = convertProseMirrorToMarkdown(
      doc(oneColumn({ type: 'mathBlock', attrs: { text: 'a^2+b^2' } })),
    );
    expect(md1).toContain(
      '<div data-type="mathBlock" data-katex="true" text="a^2+b^2"></div>',
    );
    expect(md1).not.toContain('$$');
  });

  // 26. SPANNED table inside a column delegates to processNode -> raw <table>.
  it('a spanned table in a column delegates to raw <table> HTML (no GFM pipes)', () => {
    const md1 = convertProseMirrorToMarkdown(
      doc(
        oneColumn({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 2 },
                  content: [para(text('x'))],
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(md1).toContain('<table');
    expect(md1).toContain('colspan="2"');
    // No GFM pipe-table separator leaked into the raw-HTML column.
    expect(md1).not.toContain('| --- |');
  });

  // 27. list item with TWO block children (paragraph + codeBlock) -> blockChildrenToHtml.
  it('a list item with paragraph+codeBlock in a column emits both blocks as HTML', () => {
    const md1 = convertProseMirrorToMarkdown(
      doc(
        oneColumn({
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('p')),
                {
                  type: 'codeBlock',
                  attrs: { language: 'js' },
                  content: [text('a\nb')],
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(md1).toContain('<p>p</p>');
    expect(md1).toContain('<pre><code class="language-js">a\nb</code></pre>');
    // The two blocks appear sequentially inside the same <li>.
    expect(md1).toContain(
      '<li><p>p</p><pre><code class="language-js">a\nb</code></pre></li>',
    );
  });

  // 28. ordered list item whose 2nd block child is a NESTED bulletList.
  it('an ordered list item with a nested bulletList in a column emits nested <ul> HTML', () => {
    const md1 = convertProseMirrorToMarkdown(
      doc(
        oneColumn({
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('p1')),
                {
                  type: 'bulletList',
                  content: [
                    { type: 'listItem', content: [para(text('nested'))] },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );
    // NOTE(review): the spec's expected literal said '<ul><li>nested</li></ul>',
    // but blockChildrenToHtml renders the nested listItem's paragraph child as a
    // real <p>, so the actual (correct) emission is '<ul><li><p>nested</p></li></ul>'.
    expect(md1).toContain(
      '<ol><li><p>p1</p><ul><li><p>nested</p></li></ul></li></ol>',
    );
    // No markdown list markers leaked into the raw-HTML column.
    expect(md1).not.toContain('1. ');
    expect(md1).not.toContain('- nested');
  });

  // 29. mathInline atom inside a column paragraph -> inlineToHtml delegates via processNode.
  it('a mathInline atom in a column paragraph emits schema HTML (no $...$ fence)', () => {
    const md1 = convertProseMirrorToMarkdown(
      doc(oneColumn(para(text('eq: '), { type: 'mathInline', attrs: { text: 'x_i' } }))),
    );
    expect(md1).toContain(
      '<p>eq: <span data-type="mathInline" data-katex="true" text="x_i"></span></p>',
    );
    expect(md1).not.toContain('$x_i$');
  });
});

// ===========================================================================
// 30. heading.textAlign round-trip (A1). Bare `## text` markdown carries no
// alignment, so an aligned heading used to silently DROP textAlign on export.
// Per #293 canon #9 an aligned heading now keeps the readable `## text` form and
// ATTACHES a trailing `<!--attrs {"textAlign":…}-->` comment (replacing the old
// `<hN style="text-align:…">` HTML form). It re-parses back to a heading
// carrying BOTH the level and the textAlign, so the round-trip is lossless; an
// UNaligned heading still emits the bare `## text` markdown form (no churn).
// ===========================================================================
const alignedHeading = (level: number, align: string, ...inline: any[]) => ({
  type: 'heading',
  attrs: { level, textAlign: align },
  content: inline,
});

describe('heading.textAlign round-trip (A1)', () => {
  it('an aligned heading keeps "## text" and attaches a <!--attrs--> comment (#293 #9)', () => {
    expect(convertProseMirrorToMarkdown(doc(alignedHeading(2, 'center', text('Title'))))).toBe(
      '## Title <!--attrs {"textAlign":"center"}-->',
    );
  });

  it('survives export -> import -> export losslessly (level AND textAlign preserved)', async () => {
    const input = alignedHeading(2, 'center', text('Title'));
    const { md1, doc2, md2 } = await roundTrip(input);
    // Export direction: `## Title` plus the attached alignment comment (#293 #9).
    expect(md1).toBe('## Title <!--attrs {"textAlign":"center"}-->');
    // Import direction: re-parses to a heading node with the level AND textAlign
    // (marked keeps the comment inside the <h2>; applyAttachedComments re-expresses
    // it as an inline style before generateJSON, where the heading parse rule
    // matches and the textAlign global attr reads it back). Byte-stable second
    // export closes the loop.
    const h = doc2.content[0];
    expect(h.type).toBe('heading');
    expect(h.attrs.level).toBe(2);
    expect(h.attrs.textAlign).toBe('center');
    expect(md2).toBe(md1);
    // Canonical equality of the re-parsed doc against the original input doc.
    expect(docsCanonicallyEqual(doc2, doc(input))).toBe(true);
  });

  it('a right-aligned h3 round-trips its level and alignment', async () => {
    const { doc2 } = await roundTrip(alignedHeading(3, 'right', text('Head')));
    const h = doc2.content[0];
    expect(h.type).toBe('heading');
    expect(h.attrs.level).toBe(3);
    expect(h.attrs.textAlign).toBe('right');
  });

  it('an UNaligned heading still emits the bare "## text" form (no HTML churn)', () => {
    const bare = convertProseMirrorToMarkdown(doc(heading(2, text('Plain'))));
    expect(bare).toBe('## Plain');
    expect(bare).not.toContain('<h2');
    // The default "left" alignment is likewise NOT wrapped.
    expect(
      convertProseMirrorToMarkdown(doc(alignedHeading(2, 'left', text('Plain')))),
    ).toBe('## Plain');
  });
});

// ---------------------------------------------------------------------------
// KNOWN GAP (PRE-EXISTING, not a #515 regression): an inline `code` run whose
// text contains an UNBALANCED `[` or `]` inside a FOOTNOTE BODY silently mutates.
//
// A footnote body is serialized inline as `^[…]`, and the importer's tokenizer
// locates the closing `]` by COUNTING BRACKETS — it does not know what a code
// span is. So a stray bracket anywhere in the body must be backslash-escaped
// (`balanceBrackets`), or the footnote fails to parse at all (verified: with a
// raw `[` inside the code span the whole `^[…]` degrades to literal prose, taking
// the footnote AND the code mark with it). But a code span's content is LITERAL
// on import — marked never decodes escapes between backticks — so the escape's
// backslash lands IN THE TEXT: `` `a [ 0` `` re-imports as `` `a \[ 0` ``, and
// every git-sync cycle grows another backslash-bearing diff.
//
// Verified PRE-EXISTING: the serializer at `gitea/develop` produces the identical
// `` `a \[ 0` `` for this document (whose code run carries NO other mark, so the
// shape long predates #515's `excludes: ""`). Closing it requires a footnote-canon
// change — the bracket can be neither left raw (parse breaks) nor backslash-
// escaped (content mutates), so the code span needs a different in-footnote form
// (e.g. an entity-encoded `<code>`), which is a separate decision.
//
// Pinned here so the behavior is DOCUMENTED and the day it is fixed this test
// turns green and demands attention. The generative corpus excludes the shape
// (see node-generators.ts `withoutBracketsInCodeRuns`).
// ---------------------------------------------------------------------------
describe('footnote body + inline code + bracket (pre-existing gap)', () => {
  const footnoteDoc = (codeText: string) => ({
    type: 'doc',
    content: [
      para(text('A'), { type: 'footnoteReference', attrs: { id: 'fn1' } }),
      {
        type: 'footnotesList',
        content: [
          {
            type: 'footnoteDefinition',
            attrs: { id: 'fn1' },
            content: [
              para(text('body '), {
                type: 'text',
                text: codeText,
                marks: [{ type: 'code' }],
              }),
            ],
          },
        ],
      },
    ],
  });

  const codeRunText = (d: any): string | undefined => {
    let found: string | undefined;
    const walk = (n: any) => {
      if (
        n.type === 'text' &&
        (n.marks || []).some((m: any) => m.type === 'code')
      ) {
        found ??= n.text;
      }
      (n.content || []).forEach(walk);
    };
    walk(d);
    return found;
  };

  it.fails(
    'a code run with a stray "[" inside a footnote body keeps its text (KNOWN BUG: gains a backslash)',
    async () => {
      const md1 = convertProseMirrorToMarkdown(footnoteDoc('a [ 0'));
      const doc2 = await markdownToProseMirror(md1);
      // Today: "a \[ 0" — the balanceBrackets escape leaks into the literal
      // code-span content.
      expect(codeRunText(doc2)).toBe('a [ 0');
    },
  );

  it('a code run with BALANCED brackets inside a footnote body is unaffected', async () => {
    // The balance pass only escapes STRAY brackets, so a matched pair inside a
    // code span survives untouched — the gap above is strictly about unbalanced
    // brackets.
    const md1 = convertProseMirrorToMarkdown(footnoteDoc('a [ ] 0'));
    const doc2 = await markdownToProseMirror(md1);
    expect(codeRunText(doc2)).toBe('a [ ] 0');
  });
});
