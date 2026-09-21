import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src (NOT the docmost-client barrel, which pulls in
// collaboration.ts and mutates global DOM at import time).
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';

// markdown-converter.ts is the weakest pure module (report §2). These golden
// tests close the gaps the base markdown-converter.test.ts leaves open:
// columns/column wrapper, embed/audio/pdf (used to emit nothing), drawio/
// excalidraw data-align presence rule, the remaining inline-mark matrix,
// paragraph.textAlign, subpages + unknown-in-container fallback, escaping
// idempotence, table-cell pipe/newline sanitization, and empty/single-column
// tables. Cases already asserted in the base file are NOT repeated.

const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const c = (node: any) => convertProseMirrorToMarkdown(doc(node));
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

describe('columns / column (raw-HTML layout wrapper)', () => {
  it('wraps a multi-column layout as nested data-type divs with the children inside (regression: children unwrapped)', () => {
    const out = c({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        { type: 'column', attrs: { width: 50 }, content: [para(text('L'))] },
        { type: 'column', content: [para(text('R'))] },
      ],
    });
    expect(out).toBe(
      '<div data-type="columns" data-layout="two">' +
        '<div data-type="column" data-width="50"><p>L</p></div>' +
        '<div data-type="column"><p>R</p></div>' +
        '</div>',
    );
  });

  it('omits the default widthMode "normal" but emits a non-default one', () => {
    const normal = c({
      type: 'columns',
      attrs: { layout: 'two', widthMode: 'normal' },
      content: [{ type: 'column', content: [para(text('x'))] }],
    });
    expect(normal).not.toContain('data-width-mode');
    const wide = c({
      type: 'columns',
      attrs: { layout: 'two', widthMode: 'full' },
      content: [{ type: 'column', content: [para(text('x'))] }],
    });
    expect(wide).toContain('data-width-mode="full"');
  });
});

describe('embed / audio / pdf top-level md-form + discriminator (#293 #8)', () => {
  it('embed emits link-form [provider](src) + bare discriminator (defaults omitted)', () => {
    // provider is the visible link text; align/width/height are all at their
    // schema defaults (center/800/600), so the comment is name-only.
    expect(c({ type: 'embed', attrs: { src: 'https://x.com/e', provider: 'iframe' } })).toBe(
      '[iframe](https://x.com/e)<!--embed-->',
    );
  });

  it('audio emits image-form ![](src) + bare discriminator', () => {
    expect(c({ type: 'audio', attrs: { src: '/a.mp3' } })).toBe('![](/a.mp3)<!--audio-->');
  });

  it('pdf emits link-form [name](src) + bare discriminator', () => {
    expect(c({ type: 'pdf', attrs: { src: '/d.pdf', name: 'd.pdf' } })).toBe(
      '[d.pdf](/d.pdf)<!--pdf-->',
    );
  });
});

describe('drawio / excalidraw align emission in the discriminator comment (#293 #8)', () => {
  it('drawio: NO align key when align is unset (bare discriminator)', () => {
    const out = c({ type: 'drawio', attrs: { src: '/d.drawio' } });
    expect(out).toBe('![](/d.drawio)<!--drawio-->');
    expect(out).not.toContain('align');
  });

  it('drawio: an "align" key IS present for a non-default align', () => {
    expect(c({ type: 'drawio', attrs: { src: '/d.drawio', align: 'right' } })).toBe(
      '![](/d.drawio)<!--drawio {"align":"right"}-->',
    );
  });

  it('drawio: the default align "center" is OMITTED (byte-stable image-form parity)', () => {
    const out = c({ type: 'drawio', attrs: { src: '/d.drawio', align: 'center' } });
    expect(out).toBe('![](/d.drawio)<!--drawio-->');
    expect(out).not.toContain('align');
  });

  it('excalidraw: NO align key when align is unset (bare discriminator)', () => {
    const out = c({ type: 'excalidraw', attrs: { src: '/e.excalidraw' } });
    expect(out).toBe('![](/e.excalidraw)<!--excalidraw-->');
    expect(out).not.toContain('align');
  });
});

describe('inline-mark matrix (underline/sub/sup/highlight±color/textStyle/comment)', () => {
  it('emits the schema HTML for each remaining inline mark in one matrix', () => {
    const cases: [any[], string][] = [
      [[{ type: 'underline' }], '<u>m</u>'],
      [[{ type: 'subscript' }], '<sub>m</sub>'],
      [[{ type: 'superscript' }], '<sup>m</sup>'],
      // #293 canon #7: a no-color highlight now serializes as `==m==` (Obsidian
      // syntax); only a COLORED highlight keeps the `<mark style=…>` HTML form.
      [[{ type: 'highlight' }], '==m=='],
      [
        [{ type: 'highlight', attrs: { color: '#ff0000' } }],
        '<mark style="background-color: #ff0000">m</mark>',
      ],
      [
        [{ type: 'textStyle', attrs: { color: '#00ff00' } }],
        '<span style="color: #00ff00">m</span>',
      ],
      [
        [{ type: 'comment', attrs: { commentId: 'cid-1' } }],
        '<span data-comment-id="cid-1">m</span>',
      ],
      [
        [{ type: 'comment', attrs: { commentId: 'cid-1', resolved: true } }],
        '<span data-comment-id="cid-1" data-resolved="true">m</span>',
      ],
    ];
    for (const [marks, expected] of cases) {
      expect(c(para(text('m', marks)))).toBe(expected);
    }
  });

  it('a textStyle mark with no color emits nothing (plain text passes through)', () => {
    expect(c(para(text('plain', [{ type: 'textStyle', attrs: {} }])))).toBe('plain');
  });

  it('a comment mark with no commentId emits nothing (plain text)', () => {
    expect(c(para(text('plain', [{ type: 'comment', attrs: {} }])))).toBe('plain');
  });
});

describe('paragraph.textAlign -> attached <!--attrs--> comment (#293 #9)', () => {
  it('non-default alignment emits a trailing <!--attrs {"textAlign":…}--> comment', () => {
    // #293 canon #9: a non-default paragraph alignment now round-trips as an
    // ATTACHED HTML comment at the END of the block line instead of the old
    // `<p style="text-align:center">` wrapper (which the maintainer had to patch
    // A14->A15->A16). The importer's applyAttachedComments step reads the comment
    // back onto `textAlign` before the DOM stage drops it.
    expect(c({ type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('x')] })).toBe(
      'x <!--attrs {"textAlign":"center"}-->',
    );
  });

  it('textAlign "left" (the default) emits NO comment', () => {
    expect(c({ type: 'paragraph', attrs: { textAlign: 'left' }, content: [text('x')] })).toBe('x');
  });
});

describe('subpages token + unknown-in-container fallback', () => {
  it('subpages emits the standalone comment (#293 #5, unlike the old {{SUBPAGES}} literal)', () => {
    expect(c({ type: 'subpages' })).toBe('<!--subpages-->');
  });

  it('an unknown block inside a raw-HTML container is wrapped in <div> (never markdown)', () => {
    // Inside columns the children are rendered as HTML; an unknown block type
    // must NOT fall back to markdown (which would land as literal text on
    // re-import). It is wrapped in a <div> so its children survive.
    const out = c({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        { type: 'column', content: [{ type: 'weirdBlock', content: [para(text('kept'))] }] },
      ],
    });
    expect(out).toBe(
      '<div data-type="columns" data-layout="two">' +
        '<div data-type="column"><div><p>kept</p></div></div>' +
        '</div>',
    );
  });

  it('an unknown TOP-LEVEL block falls back to its children only (markdown context)', () => {
    expect(c({ type: 'totallyUnknown', content: [text('inner')] })).toBe('inner');
  });
});

describe('escaping idempotence (SPEC §11 phantom-diff guard)', () => {
  it('escapeAttr escapes ONLY & and " in an attribute context, and is idempotent', () => {
    // #293 canon #6: a TOP-LEVEL mathBlock now serializes as a `$$` fence, so
    // to exercise the schema-HTML `text` attr (which DOES go through escapeAttr)
    // we wrap the math in a COLUMN — the raw-HTML path keeps the `<div>` form.
    const col = (child: any) => ({
      type: 'columns',
      content: [{ type: 'column', content: [child] }],
    });
    // & -> &amp;, " -> &quot; in the attribute context.
    const once = c(col({ type: 'mathBlock', attrs: { text: 'a & "b"' } }));
    expect(once).toContain(
      '<div data-type="mathBlock" data-katex="true" text="a &amp; &quot;b&quot;"></div>',
    );
    // < and > are deliberately NOT escaped (would accumulate on round-trips).
    const angled = c(col({ type: 'mathBlock', attrs: { text: 'a < b > c' } }));
    expect(angled).toContain('text="a < b > c"');
    expect(angled).not.toContain('&lt;');
    expect(angled).not.toContain('&gt;');
  });

  it('encodeMdUrl turns a space into %20 in an image src (single inert URL token)', () => {
    expect(c({ type: 'image', attrs: { alt: 'c', src: '/my pic.png' } })).toBe(
      '![c](/my%20pic.png)',
    );
  });
});

describe('multi-block table cell -> HTML <table> (#8: GFM pipes cannot hold block content)', () => {
  it('emits the whole table as HTML <table> so a multi-paragraph cell survives', () => {
    // A cell holding TWO block paragraphs cannot be represented by a GFM pipe
    // row (one inline line only) — the old GFM path collapsed the two blocks
    // into one line ("a\|b c"), losing the block boundary and forcing a fragile
    // pipe-escape. #8 emits the WHOLE table as raw HTML <table> instead: the
    // schema's table-family parseHTML round-trips it, each paragraph stays its
    // own <p>, and the literal pipe needs no escaping inside HTML text.
    const out = c({
      type: 'table',
      content: [
        { type: 'tableRow', content: [
          { type: 'tableHeader', content: [para(text('H'))] },
        ]},
        { type: 'tableRow', content: [
          { type: 'tableCell', content: [para(text('a|b')), para(text('c'))] },
        ]},
      ],
    });
    expect(out).toBe(
      '<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>a|b</p><p>c</p></td></tr></tbody></table>',
    );
  });
});

describe('empty / single-column tables', () => {
  it('a table with no rows renders as the empty string', () => {
    expect(c({ type: 'table', content: [] })).toBe('');
  });

  it('a single-column GFM table emits one column with a "---" separator', () => {
    const out = c({
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [para(text('Only'))] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('v'))] }] },
      ],
    });
    expect(out).toBe('| Only |\n| --- |\n| v |');
  });
});

// ---------------------------------------------------------------------------
// Media / attachment / container full-attribute coverage. The base golden file
// only sets the minimal attrs for each media node (src, or src+name), so the
// optional-attribute emission branches and their exact ORDERING are uncovered.
// These cases pin the full ordered attribute string for video/youtube/embed/
// audio/pdf/attachment plus the all-absent side of every optional guard, and
// the distinct HTML-container (blockToHtml / inlineToHtml) paths for an
// orderedList and a hardBreak inside a column.
// ---------------------------------------------------------------------------
describe('media / attachment / container full-attribute golden coverage', () => {
  it('video: emits all optional attrs in the comment JSON in stable order (align center omitted)', () => {
    // #293 canon #8 image-form: src in the target, all OTHER non-default attrs in
    // the comment JSON (stable order alt/attachmentId/width/height/size/
    // aspectRatio; align="center" is the default and is omitted).
    expect(
      c({
        type: 'video',
        attrs: {
          src: '/v.mp4',
          alt: 'clip',
          attachmentId: 'att-1',
          width: 640,
          height: 480,
          size: 1234,
          align: 'center',
          aspectRatio: 1.777,
        },
      }),
    ).toBe(
      '![](/v.mp4)<!--video {"alt":"clip","attachmentId":"att-1","width":"640","height":"480","size":"1234","aspectRatio":"1.777"}-->',
    );
  });

  it('video: with only src, the discriminator is still emitted name-only (bare ![](src)<!--video-->)', () => {
    expect(c({ type: 'video', attrs: { src: '/v.mp4' } })).toBe('![](/v.mp4)<!--video-->');
  });

  it('youtube + embed: each emits its full optional attr set in the discriminator comment', () => {
    // (a) youtube (image-form): width/height/align(right) in the comment JSON.
    expect(
      c({
        type: 'youtube',
        attrs: { src: 'https://youtu.be/abc', width: 560, height: 315, align: 'right' },
      }),
    ).toBe(
      '![](https://youtu.be/abc)<!--youtube {"width":"560","height":"315","align":"right"}-->',
    );
    // (b) embed (link-form): provider is the visible text; a non-default align/
    // width/height (left/600/400 — the defaults are center/800/600) ride in JSON.
    expect(
      c({
        type: 'embed',
        attrs: { src: 'https://x.com/e', provider: 'iframe', align: 'left', width: 600, height: 400 },
      }),
    ).toBe(
      '[iframe](https://x.com/e)<!--embed {"align":"left","width":"600","height":"400"}-->',
    );
  });

  it('audio: emits attachmentId then size in the comment JSON when both are set', () => {
    expect(c({ type: 'audio', attrs: { src: '/a.mp3', attachmentId: 'att-7', size: 9001 } })).toBe(
      '![](/a.mp3)<!--audio {"attachmentId":"att-7","size":"9001"}-->',
    );
  });

  it('audio: with attachmentId but no size, the size key is suppressed (size != null false branch)', () => {
    expect(c({ type: 'audio', attrs: { src: '/a.mp3', attachmentId: 'att-7' } })).toBe(
      '![](/a.mp3)<!--audio {"attachmentId":"att-7"}-->',
    );
  });

  it('pdf: emits the full optional attr set in the comment JSON (attachmentId, size, width, height)', () => {
    expect(
      c({
        type: 'pdf',
        attrs: {
          src: '/d.pdf',
          name: 'd.pdf',
          attachmentId: 'att-9',
          size: 2048,
          width: 800,
          height: 600,
        },
      }),
    ).toBe(
      '[d.pdf](/d.pdf)<!--pdf {"attachmentId":"att-9","size":"2048","width":"800","height":"600"}-->',
    );
  });

  it('attachment: emits mime/size/attachmentId in the comment JSON after the [name](url) target', () => {
    expect(
      c({
        type: 'attachment',
        attrs: {
          url: '/f.zip',
          name: 'f.zip',
          mime: 'application/zip',
          size: 512,
          attachmentId: 'att-3',
        },
      }),
    ).toBe(
      '[f.zip](/f.zip)<!--attachment {"mime":"application/zip","size":"512","attachmentId":"att-3"}-->',
    );
  });

  it('attachment: with only a url, the link text is empty and the discriminator is name-only', () => {
    // name is null -> empty visible text `[]`; no mime/size/id -> bare comment.
    expect(c({ type: 'attachment', attrs: { url: '/f.zip' } })).toBe(
      '[](/f.zip)<!--attachment-->',
    );
  });

  it('orderedList inside a column renders via blockToHtml as <ol start="N"> (start attr PRESERVED) with bold->strong, code->code', () => {
    const out = c({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        {
          type: 'column',
          content: [
            {
              type: 'orderedList',
              attrs: { start: 3 },
              content: [
                {
                  type: 'listItem',
                  content: [para(text('a', [{ type: 'bold' }]))],
                },
                {
                  type: 'listItem',
                  content: [para(text('b', [{ type: 'code' }]))],
                },
              ],
            },
          ],
        },
      ],
    });
    // blockToHtml orderedList path emits <ol start="3"> (FIXED #351), and
    // inlineToHtml maps bold->strong, code->code.
    expect(out).toContain(
      '<ol start="3"><li><p><strong>a</strong></p></li><li><p><code>b</code></p></li></ol>',
    );
    // The start:3 attr IS preserved in the HTML/column container path.
    expect(out).toContain('start="3"');
  });

  it('hardBreak inside a column renders as <br> via inlineToHtml (not the markdown two-space form)', () => {
    const out = c({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        {
          type: 'column',
          content: [para(text('a'), { type: 'hardBreak' }, text('b'))],
        },
      ],
    });
    expect(out).toContain('<p>a<br>b</p>');
    // The processNode markdown "  \n" hard-break form must NOT appear in the
    // raw-HTML column container path.
    expect(out).not.toContain('  \n');
  });
});
