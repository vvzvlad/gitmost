/**
 * JEST CONFIG NOTE (#119 ESM refactor): this is the one spec that needs the REAL
 * `@docmost/git-sync` converter (not a mock). The package is now ESM, which jest
 * cannot `require()` nor `import()` without --experimental-vm-modules, so the
 * server jest config `moduleNameMapper`s `@docmost/git-sync` to its TS SOURCE and
 * strips the ESM `.js` import suffixes. ts-jest then type-checks that source under
 * the server's (looser) tsconfig and trips a benign narrowing; the global
 * `isolatedModules: true` on the ts-jest transform (apps/server/package.json)
 * makes it transpile-only so this spec loads. Full type-checking of the package
 * is still enforced by its own `tsc`/vitest gates and the server `tsc --noEmit`.
 *
 * §13.1 IDEMPOTENCY GATE — the blocking gate for git-sync Phase B.
 *
 * Proves the `@docmost/git-sync` pure converter is schema-compatible
 * with the server's REAL editor-ext document schema: a representative corpus of
 * editor-ext ProseMirror documents must survive a full round trip through the
 * actual server write path without losing any node / mark / attribute.
 *
 * Pipeline per document (issue #194 §13.1):
 *   1. md   = convertProseMirrorToMarkdown(content)          // git-sync export
 *   2. doc  = await markdownToProseMirror(md)                // git-sync import
 *   3. push `doc` through the REAL editor-ext Yjs write path the server uses:
 *        ydoc       = TiptapTransformer.toYdoc(doc, 'default', tiptapExtensions)
 *        normalized = TiptapTransformer.fromYdoc(ydoc, 'default')
 *      This is exactly what PersistenceExtension does on store
 *      (apps/server/src/collaboration/extensions/persistence.extension.ts:96/115)
 *      with the same `tiptapExtensions` (collaboration.util.ts) and the same
 *      `@hocuspocus/transformer`, so the gate exercises the real schema
 *      validation that runs on a git-sync write (issue #194 §3.3).
 *   4. assert docsCanonicallyEqual(canon(original), canon(normalized)) === true
 *
 * Any node / mark / attr that editor-ext drops (because the git-sync
 * docmost-schema named it differently, or declares a different default) makes
 * the gate FAIL for that document — exactly the schema-divergence issue #194 §3.3 /
 * §13.1 warn about. Genuine, irreducible divergences are isolated into the
 * clearly-named `KNOWN DIVERGENCE` block at the bottom (never silently hidden).
 *
 * Requires the workspace packages built first:
 *   pnpm --filter @docmost/editor-ext build
 *   pnpm --filter @docmost/git-sync  build
 */
import { TiptapTransformer } from '@hocuspocus/transformer';
// Import the server's real schema FIRST so `@docmost/editor-ext` resolves to its
// built CJS `dist` (its `main`). The ESM-only `@docmost/git-sync` package is
// mapped to its TS SOURCE by the jest `moduleNameMapper` (the built ESM cannot
// be `require()`d nor dynamically `import()`ed under jest's node VM), so ts-jest
// transpiles the real converter to CJS here — exercising the actual converter
// the server ships, not a stub.
import { tiptapExtensions } from './collaboration.util';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  canonicalizeContent,
  docsCanonicallyEqual,
} from '@docmost/git-sync';

/**
 * Run a single editor-ext document through the full gate pipeline and return
 * the canonical original vs the canonical doc as it lands after the real Yjs
 * write path, plus the intermediate markdown for diagnostics.
 */
async function runGate(original: any): Promise<{
  md: string;
  imported: any;
  normalized: any;
  canonOriginal: any;
  canonNormalized: any;
}> {
  // 1) editor-ext JSON -> markdown (git-sync export).
  const md = convertProseMirrorToMarkdown(original);

  // 2) markdown -> ProseMirror JSON (git-sync import, docmost-schema).
  const imported = await markdownToProseMirror(md);

  // 3) push through the REAL editor-ext schema via the server's Yjs write path.
  //    toYdoc validates `imported` against tiptapExtensions (throws on an
  //    unknown node, drops unknown attrs); fromYdoc reads it back as the
  //    normalized editor-ext JSON the server would persist.
  const ydoc = TiptapTransformer.toYdoc(imported, 'default', tiptapExtensions);
  const normalized = TiptapTransformer.fromYdoc(ydoc, 'default');

  return {
    md,
    imported,
    normalized,
    canonOriginal: canonicalizeContent(original),
    canonNormalized: canonicalizeContent(normalized),
  };
}

const doc = (...content: any[]) => ({ type: 'doc', content });
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...content: any[]) => ({ type: 'paragraph', content });

// ---------------------------------------------------------------------------
// Corpus: editor-ext ProseMirror documents covering the common node/mark types.
// Node / mark / attr names and DEFAULTS are taken from the real schema —
// editor-ext (packages/editor-ext/src) + the server's tiptapExtensions
// (collaboration.util.ts) — NOT guessed. Where editor-ext materializes a
// non-null default on import (e.g. image.align="center", callout.type, list
// start) the fixture pre-authors that materialized value so the round trip is
// already at its fixpoint (matches how the engine normalizes-on-write, SPEC §11).
// ---------------------------------------------------------------------------
const CORPUS: Record<string, any> = {
  'paragraphs + headings (h1-h3)': doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Heading one')] },
    { type: 'heading', attrs: { level: 2 }, content: [text('Heading two')] },
    { type: 'heading', attrs: { level: 3 }, content: [text('Heading three')] },
    para(text('A plain paragraph of text.')),
    para(text('Second paragraph.')),
  ),

  // A non-default paragraph alignment now round-trips (item #7 fix): it exports
  // as `<p style="text-align:center">` and the schema's paragraph parseHTML
  // reads `style="text-align"` back onto `textAlign` on import, so the alignment
  // survives the full editor-ext write path. Promoted from the old KNOWN
  // DIVERGENCE block (which only heading alignment still occupies).
  'aligned paragraph (textAlign center)': doc({
    type: 'paragraph',
    attrs: { textAlign: 'center' },
    content: [text('centered')],
  }),

  'inline marks (bold/italic/strike/code)': doc(
    para(
      text('normal '),
      text('bold', [{ type: 'bold' }]),
      text(' '),
      text('italic', [{ type: 'italic' }]),
      text(' '),
      text('struck', [{ type: 'strike' }]),
      text(' '),
      text('code', [{ type: 'code' }]),
    ),
  ),

  'links': doc(
    para(
      text('see '),
      text('the site', [
        { type: 'link', attrs: { href: 'https://example.com' } },
      ]),
      text(' for more'),
    ),
  ),

  'bullet list': doc({
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [para(text('first'))] },
      { type: 'listItem', content: [para(text('second'))] },
      { type: 'listItem', content: [para(text('third'))] },
    ],
  }),

  'ordered list': doc({
    type: 'orderedList',
    attrs: { start: 1 },
    content: [
      { type: 'listItem', content: [para(text('one'))] },
      { type: 'listItem', content: [para(text('two'))] },
    ],
  }),

  'task list (checkbox)': doc({
    type: 'taskList',
    content: [
      {
        type: 'taskItem',
        attrs: { checked: true },
        content: [para(text('done item'))],
      },
      {
        type: 'taskItem',
        attrs: { checked: false },
        content: [para(text('todo item'))],
      },
    ],
  }),

  'blockquote': doc({
    type: 'blockquote',
    content: [para(text('a quoted line')), para(text('second quoted line'))],
  }),

  'callout (info)': doc({
    type: 'callout',
    attrs: { type: 'info' },
    content: [para(text('an informational callout'))],
  }),

  'callout (warning)': doc({
    type: 'callout',
    attrs: { type: 'warning' },
    content: [para(text('a warning callout'))],
  }),

  'code block (with language)': doc({
    type: 'codeBlock',
    attrs: { language: 'typescript' },
    // A fenced code block's body is stored with a trailing newline (the form a
    // markdown ``` fence round-trips to: marked normalizes the code text to end
    // in "\n"). Authoring the fixture at that fixpoint mirrors how the engine
    // normalizes-on-write (SPEC §11): codeBlock + `language` round-trip exactly.
    content: [text('const a: number = 1;\nconsole.log(a);\n')],
  }),

  'horizontal rule': doc(
    para(text('before')),
    { type: 'horizontalRule' },
    para(text('after')),
  ),

  'table (header row + cells)': doc({
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('Name'))],
          },
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('Value'))],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('alpha'))],
          },
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('1'))],
          },
        ],
      },
    ],
  }),

  // #8 — a table with a MULTI-BLOCK cell (two paragraphs). A GFM pipe table
  // cannot hold two blocks without flattening them; the converter emits a
  // lossless HTML <table> instead, and the two blocks must survive the round trip.
  'table (multi-block cell, #8)': doc({
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('H'))],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('first')), para(text('second'))],
          },
        ],
      },
    ],
  }),

  // #7 — a table nested inside a column. Columns render as HTML containers, and a
  // table inside one must stay an HTML <table> (a GFM pipe table cannot live
  // inside an HTML block), round-tripping without being unwrapped or lost.
  // `widthMode` is pre-authored at its materialized `normal` default (SPEC §11).
  'table inside a column (#7)': doc({
    type: 'columns',
    attrs: { layout: 'two', widthMode: 'normal' },
    content: [
      {
        type: 'column',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableHeader',
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    content: [para(text('C7'))],
                  },
                ],
              },
            ],
          },
        ],
      },
      { type: 'column', content: [para(text('right'))] },
    ],
  }),

  // --- editor-ext nodes/marks beyond the original corpus (item #7) ----------
  // Each of these was verified to round-trip CLEANLY through the real gate
  // (export -> markdown -> import -> editor-ext Yjs write path). Fixtures are
  // pre-authored at the engine's normalize-on-write fixpoint (SPEC §11), e.g.
  // details carries the materialized `open:false`, and color marks use the
  // `rgb(...)` form the HTML re-parser normalizes to.

  'mention (user)': doc(
    para(
      text('hi '),
      {
        type: 'mention',
        attrs: {
          id: 'user-123',
          label: 'Alice',
          entityType: 'user',
          entityId: 'user-123',
          creatorId: 'creator-1',
        },
      },
      text(' there'),
    ),
  ),

  'inline math': doc(
    para(
      text('inline '),
      { type: 'mathInline', attrs: { text: 'x^2' } },
      text(' math'),
    ),
  ),

  'block math': doc({ type: 'mathBlock', attrs: { text: 'x^2 + y^2 = z^2' } }),

  'details (collapsible)': doc({
    type: 'details',
    // `open:false` is the value editor-ext materializes on import; pre-authoring
    // it puts the fixture at its round-trip fixpoint.
    attrs: { open: false },
    content: [
      { type: 'detailsSummary', content: [text('Summary line')] },
      { type: 'detailsContent', content: [para(text('hidden body'))] },
    ],
  }),

  'highlight (mark, no color)': doc(
    para(
      text('a '),
      text('highlighted', [{ type: 'highlight' }]),
      text(' word'),
    ),
  ),

  'highlight (mark, with color)': doc(
    para(
      text('a '),
      text('red', [{ type: 'highlight', attrs: { color: 'rgb(255, 0, 0)' } }]),
      text(' word'),
    ),
  ),

  'subscript': doc(
    para(text('H'), text('2', [{ type: 'subscript' }]), text('O')),
  ),

  'superscript': doc(
    para(text('E=mc'), text('2', [{ type: 'superscript' }])),
  ),

  'text color (textStyle)': doc(
    // The HTML re-parser normalizes CSS colors to the `rgb(...)` form, so the
    // fixture pre-authors that form; a `#hex` color would round-trip to the
    // equivalent rgb() and is therefore a value-normalization divergence (see
    // the KNOWN DIVERGENCE block below).
    para(text('green', [{ type: 'textStyle', attrs: { color: 'rgb(0, 255, 0)' } }])),
  ),

  'nested / mixed document': doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Mixed')] },
    para(
      text('intro with '),
      text('bold', [{ type: 'bold' }]),
      text(' and a '),
      text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
      text('.'),
    ),
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            para(text('item with '), text('code', [{ type: 'code' }])),
          ],
        },
        {
          type: 'listItem',
          content: [
            para(text('item with sublist')),
            {
              type: 'bulletList',
              content: [
                { type: 'listItem', content: [para(text('nested a'))] },
                { type: 'listItem', content: [para(text('nested b'))] },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'callout',
      attrs: { type: 'success' },
      content: [
        para(text('callout body')),
        { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('echo hi\n')] },
      ],
    },
    {
      type: 'blockquote',
      content: [para(text('quote at the end'))],
    },
  ),

  // Atom embeds that carry no inline text: they must round-trip via their
  // schema-matching HTML (data-type div), NOT a literal that re-imports as plain
  // text. `subpages` used to export as the literal "{{SUBPAGES}}" and came back
  // as visible text on the page (red-team round-trip data loss) — this locks it.
  // editor-ext materializes the `recursive: false` default on import, so the
  // fixture pre-authors it to sit at the round-trip fixpoint (matches the other
  // default-materializing fixtures above).
  'subpages embed': doc({ type: 'subpages', attrs: { recursive: false } }),
};

describe('git-sync converter §13.1 idempotency gate (editor-ext schema)', () => {
  for (const [name, original] of Object.entries(CORPUS)) {
    it(`round-trips losslessly: ${name}`, async () => {
      const { md, canonOriginal, canonNormalized } = await runGate(original);

      const equal = docsCanonicallyEqual(original, canonNormalized);
      if (!equal) {
        // Surface a readable diff so a real divergence is actionable.
        // eslint-disable-next-line no-console
        console.error(
          `\n[GATE FAIL] ${name}\n--- markdown ---\n${md}\n` +
            `--- canonical original ---\n${JSON.stringify(canonOriginal, null, 2)}\n` +
            `--- canonical round-tripped ---\n${JSON.stringify(canonNormalized, null, 2)}\n`,
        );
      }
      expect(equal).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Image layout attrs preserved by canon #4 (width/height/align all round-trip).
//
// The `image` NODE round-trips through editor-ext fine. Plain markdown `![](src)`
// has no way to express layout attrs, so the canonical converter (#293/#326
// canon decision #4) appends a machine comment `<!--img {...}-->` carrying the
// NON-DEFAULT attrs, and re-parses it on import — the same trailing-comment
// pattern used for media/textAlign.
//
// About `align` — DO NOT repeat an earlier false diagnosis: align is NOT lost.
// `center` is the schema default, so the emitter omits it (only left/right go
// into the comment) and the importer restores it via the image `align` default
// ("center"). `canonNormalized.align` reads `undefined` here ONLY because
// `canonicalizeContent` normalizes the "center" default away SYMMETRICALLY (from
// both the original and the round trip), so docsCanonicallyEqual is unaffected —
// this is canonical-form normalization, not a divergence. Verified empirically:
// left/right survive the raw round trip; center is restored on import then
// canon-stripped on both sides. The real round-trip instability in this family
// was the empty-string-vs-absent class (image.alt `absent -> ""`), fixed
// parse-side in the converter PACKAGE on develop (PR #350). This branch absorbs
// that fix via the next develop merge; nothing to flip here for align.
// ---------------------------------------------------------------------------
describe('git-sync converter §13.1 image layout attrs round-trip (align via schema default)', () => {
  const imageDoc = doc({
    type: 'image',
    attrs: {
      src: 'https://example.com/pic.png',
      width: 640,
      height: 480,
      align: 'center',
    },
  });

  it('preserves width/height via the canon `<!--img {...}-->` comment; center align is the default', async () => {
    const { md, canonNormalized } = await runGate(imageDoc);

    // Canon #4: bare `![](src)` plus a trailing `<!--img {...}-->` comment that
    // carries the non-default layout attrs. `center` is the default, so it is
    // correctly OMITTED from the comment (only width/height appear here).
    expect(md.trim()).toBe(
      '![](https://example.com/pic.png) <!--img {"width":"640","height":"480"}-->',
    );

    // The round-tripped image keeps src + width/height. width/height are
    // re-imported as strings (matching the video/audio/pdf string convention),
    // so assert the values rather than the JS type.
    const imgAttrs = (canonNormalized as any).content[0].attrs;
    expect((canonNormalized as any).content[0].type).toBe('image');
    expect(imgAttrs.src).toBe('https://example.com/pic.png');
    expect(String(imgAttrs.width)).toBe('640');
    expect(String(imgAttrs.height)).toBe('480');
    // `align` is NOT lost — see the block comment above: `center` is the schema
    // default, restored on import then normalized away symmetrically by
    // canonicalize, so it reads `undefined` on the CANONICAL form (not a loss).
    expect(imgAttrs.align).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HEADING text alignment — now round-trips (item A1; formerly a KNOWN DIVERGENCE).
// Symmetric with the paragraph fix: a heading's non-default `textAlign` is
// exported as a styled `<hN style="text-align:…">` (was a bare ATX `## text`
// that dropped it) and re-parsed by the heading + textAlign parseHTML on import,
// so a non-default heading alignment SURVIVES a full round trip.
// ---------------------------------------------------------------------------
describe('git-sync converter §13.1 heading text alignment round-trips', () => {
  it('preserves a heading textAlign across the markdown round trip', async () => {
    const alignedHeading = doc({
      type: 'heading',
      attrs: { level: 2, textAlign: 'center' },
      content: [text('centered heading')],
    });

    const { md, canonNormalized } = await runGate(alignedHeading);

    // Canon #9: ATX heading plus a trailing `<!--attrs {...}-->` comment carrying
    // the non-default textAlign (was a lossy bare `## centered heading`).
    expect(md.trim()).toBe(
      '## centered heading <!--attrs {"textAlign":"center"}-->',
    );
    expect(docsCanonicallyEqual(alignedHeading, canonNormalized)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// textStyle color is now PRESERVED LOSSLESSLY (item #7 — divergence resolved).
//
// The former "KNOWN DIVERGENCE" was that a `#hex` color got value-normalized to
// the equivalent `rgb(...)` string by the HTML re-parser on import. The unified
// `@docmost/prosemirror-markdown` converter this branch rebased onto no longer
// re-normalizes the color format — a `#hex` original round-trips STRING-identical
// (verified against the current converter). Locked here so the boundary stays
// explicit: any `#hex` color fixture is in the green corpus as-is.
// ---------------------------------------------------------------------------
describe('git-sync converter §13.1 (textStyle color #hex preserved losslessly)', () => {
  it('preserves a #hex text color as-is (string-identical round-trip)', async () => {
    const hexDoc = doc(
      para(text('green', [{ type: 'textStyle', attrs: { color: '#00ff00' } }])),
    );

    const { canonNormalized } = await runGate(hexDoc);

    // Color survives verbatim as the original #hex string.
    expect(canonNormalized).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'green',
              marks: [{ type: 'textStyle', attrs: { color: '#00ff00' } }],
            },
          ],
        },
      ],
    });
    // String-identical to the #hex original (the round trip is lossless).
    expect(docsCanonicallyEqual(hexDoc, canonNormalized)).toBe(true);
  });
});
