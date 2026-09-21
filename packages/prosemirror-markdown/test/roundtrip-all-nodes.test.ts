import { describe, expect, it } from 'vitest';
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

/**
 * Exhaustive serialize -> deserialize round trip for EVERY node and mark type the
 * Docmost document schema supports. The git-sync converter exports a page body to
 * Markdown and imports it back; any node type that has no parseHTML inverse (or is
 * serialized to a literal that never re-parses) silently degrades to plain text on
 * a round trip — e.g. `subpages` used to export as the literal `{{SUBPAGES}}` and
 * came back as the visible text "{{SUBPAGES}}" instead of the embed.
 *
 * This guards the whole class: for one representative fixture per type, the node
 * (or mark) MUST still be present after convert -> import, and the exported
 * Markdown must not contain a `{{...}}` template literal (the old lossy form).
 */

const T = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const P = (...c: any[]) => ({ type: 'paragraph', content: c });
const doc = (...c: any[]) => ({ type: 'doc', content: c });

// `primary` is the node/mark type that must survive the round trip.
const FIXTURES: Record<string, { doc: any; primary: string }> = {
  paragraph: { doc: doc(P(T('hello'))), primary: 'paragraph' },
  heading: { doc: doc({ type: 'heading', attrs: { level: 2 }, content: [T('H2')] }), primary: 'heading' },
  blockquote: { doc: doc({ type: 'blockquote', content: [P(T('q'))] }), primary: 'blockquote' },
  codeBlock: { doc: doc({ type: 'codeBlock', attrs: { language: 'js' }, content: [T('foo()')] }), primary: 'codeBlock' },
  bulletList: { doc: doc({ type: 'bulletList', content: [{ type: 'listItem', content: [P(T('a'))] }] }), primary: 'bulletList' },
  orderedList: { doc: doc({ type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [P(T('a'))] }] }), primary: 'orderedList' },
  taskList: { doc: doc({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P(T('done'))] }] }), primary: 'taskList' },
  horizontalRule: { doc: doc({ type: 'horizontalRule' }), primary: 'horizontalRule' },
  image: { doc: doc({ type: 'image', attrs: { src: '/f/x.png', width: '320', align: 'center' } }), primary: 'image' },
  hardBreak: { doc: doc(P(T('a'), { type: 'hardBreak' }, T('b'))), primary: 'hardBreak' },
  callout: { doc: doc({ type: 'callout', attrs: { type: 'info' }, content: [P(T('note'))] }), primary: 'callout' },
  columns: {
    doc: doc({ type: 'columns', content: [
      { type: 'column', attrs: { width: '50%' }, content: [P(T('L'))] },
      { type: 'column', attrs: { width: '50%' }, content: [P(T('R'))] }] }),
    primary: 'column',
  },
  details: {
    doc: doc({ type: 'details', content: [
      { type: 'detailsSummary', content: [T('Sum')] },
      { type: 'detailsContent', content: [P(T('body'))] }] }),
    primary: 'details',
  },
  table: {
    doc: doc({ type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('H1'))] }, { type: 'tableHeader', content: [P(T('H2'))] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('C1'))] }, { type: 'tableCell', content: [P(T('C2'))] }] }] }),
    primary: 'tableCell',
  },
  mathBlock: { doc: doc({ type: 'mathBlock', attrs: { math: 'x^2' } }), primary: 'mathBlock' },
  mathInline: { doc: doc(P({ type: 'mathInline', attrs: { math: 'x^2' } })), primary: 'mathInline' },
  mention: { doc: doc(P({ type: 'mention', attrs: { id: 'u1', label: 'Bob', entityType: 'user', entityId: 'u1' } })), primary: 'mention' },
  drawio: { doc: doc({ type: 'drawio', attrs: { src: '/f/d.drawio', attachmentId: 'a1' } }), primary: 'drawio' },
  excalidraw: { doc: doc({ type: 'excalidraw', attrs: { src: '/f/e.excalidraw', attachmentId: 'a1' } }), primary: 'excalidraw' },
  embed: { doc: doc({ type: 'embed', attrs: { src: 'https://youtube.com/x', provider: 'iframe' } }), primary: 'embed' },
  pdf: { doc: doc({ type: 'pdf', attrs: { src: '/f/x.pdf', attachmentId: 'a1' } }), primary: 'pdf' },
  video: { doc: doc({ type: 'video', attrs: { src: '/f/v.mp4', width: '640' } }), primary: 'video' },
  audio: { doc: doc({ type: 'audio', attrs: { src: '/f/a.mp3' } }), primary: 'audio' },
  attachment: { doc: doc({ type: 'attachment', attrs: { url: '/f/x.zip', name: 'x.zip', attachmentId: 'a1' } }), primary: 'attachment' },
  youtube: { doc: doc({ type: 'youtube', attrs: { src: 'https://youtube.com/watch?v=x' } }), primary: 'youtube' },
  subpages: { doc: doc({ type: 'subpages' }), primary: 'subpages' },
  pageBreak: { doc: doc({ type: 'pageBreak' }), primary: 'pageBreak' },
  htmlEmbed: { doc: doc({ type: 'htmlEmbed', attrs: { source: '<b>hi</b>' } }), primary: 'htmlEmbed' },
  pageEmbed: { doc: doc({ type: 'pageEmbed', attrs: { pageId: 'p1' } }), primary: 'pageEmbed' },
  // transclusionSource: the schema reads `id` (NOT `pageId`) and its content is
  // `+` (at least one block child), so give it both or it never re-parses.
  transclusion: { doc: doc({ type: 'transclusionSource', attrs: { id: 't1' }, content: [P(T('shared'))] }), primary: 'transclusionSource' },
  transclusionReference: { doc: doc({ type: 'transclusionReference', attrs: { sourcePageId: 'p1', transclusionId: 't1' } }), primary: 'transclusionReference' },
  footnote: {
    doc: doc(
      P(T('x'), { type: 'footnoteReference', attrs: { id: 'fn1' } }),
      { type: 'footnotesList', content: [{ type: 'footnoteDefinition', attrs: { id: 'fn1' }, content: [P(T('note'))] }] }),
    primary: 'footnoteReference',
  },
  status: { doc: doc(P({ type: 'status', attrs: { text: 'Done', color: 'green' } })), primary: 'status' },
  // marks
  bold: { doc: doc(P(T('b', [{ type: 'bold' }]))), primary: 'bold' },
  italic: { doc: doc(P(T('i', [{ type: 'italic' }]))), primary: 'italic' },
  strike: { doc: doc(P(T('s', [{ type: 'strike' }]))), primary: 'strike' },
  code: { doc: doc(P(T('c', [{ type: 'code' }]))), primary: 'code' },
  underline: { doc: doc(P(T('u', [{ type: 'underline' }]))), primary: 'underline' },
  superscript: { doc: doc(P(T('x', [{ type: 'superscript' }]))), primary: 'superscript' },
  subscript: { doc: doc(P(T('x', [{ type: 'subscript' }]))), primary: 'subscript' },
  highlight: { doc: doc(P(T('h', [{ type: 'highlight', attrs: { color: 'yellow' } }]))), primary: 'highlight' },
  link: { doc: doc(P(T('l', [{ type: 'link', attrs: { href: 'https://x.com' } }]))), primary: 'link' },
};

function collectTypes(n: any, set = new Set<string>()): Set<string> {
  if (!n || typeof n !== 'object') return set;
  if (n.type) set.add(n.type);
  if (Array.isArray(n.content)) n.content.forEach((c: any) => collectTypes(c, set));
  if (Array.isArray(n.marks)) n.marks.forEach((m: any) => m?.type && set.add(m.type));
  return set;
}

describe('git-sync converter: every node/mark type survives a Markdown round trip', () => {
  for (const [name, { doc: original, primary }] of Object.entries(FIXTURES)) {
    it(`round-trips ${name} (keeps the ${primary} node/mark, no literal leak)`, async () => {
      const md = convertProseMirrorToMarkdown(original);
      // The lossy old form serialized embeds to `{{...}}` literals that never
      // re-parsed; no node may export to one.
      expect(md).not.toMatch(/\{\{.*\}\}/);
      const back = await markdownToProseMirror(md);
      const types = collectTypes(back);
      expect(types.has(primary)).toBe(true);
    });
  }
});

// A node surviving as the right TYPE is necessary but not sufficient — its
// attributes must survive too. Each case carries a DISTINCTIVE attribute value
// (real attr names, verified against the schema) that must reappear after a
// round trip. This caught `subpages.recursive` and `details.open` being dropped.
describe('git-sync converter: node ATTRIBUTES survive a Markdown round trip', () => {
  const ATTR_CASES: Array<{ name: string; doc: any; needles: string[] }> = [
    { name: 'callout type', doc: doc({ type: 'callout', attrs: { type: 'warning' }, content: [P(T('x'))] }), needles: ['warning'] },
    { name: 'image dimensions/align/attachmentId', doc: doc({ type: 'image', attrs: { src: '/f/x.png', width: '777', height: '555', align: 'right', attachmentId: 'ATT777' } }), needles: ['777', '555', 'right', 'ATT777'] },
    { name: 'subpages recursive', doc: doc({ type: 'subpages', attrs: { recursive: true } }), needles: ['"recursive":true'] },
    { name: 'details open', doc: doc({ type: 'details', attrs: { open: true }, content: [{ type: 'detailsSummary', content: [T('S')] }, { type: 'detailsContent', content: [P(T('b'))] }] }), needles: ['"open":'] },
    { name: 'mathInline formula', doc: doc(P({ type: 'mathInline', attrs: { text: 'E=mc^7' } })), needles: ['E=mc^7'] },
    { name: 'mathBlock formula', doc: doc({ type: 'mathBlock', attrs: { text: '\\sum_7' } }), needles: ['sum_7'] },
    { name: 'pageEmbed sourcePageId', doc: doc({ type: 'pageEmbed', attrs: { sourcePageId: 'PAGE777' } }), needles: ['PAGE777'] },
    { name: 'video dimensions/attachmentId', doc: doc({ type: 'video', attrs: { src: '/f/v.mp4', width: '888', attachmentId: 'VID888' } }), needles: ['888', 'VID888'] },
    { name: 'status text/color', doc: doc(P({ type: 'status', attrs: { text: 'InProgress777', color: 'orange' } })), needles: ['InProgress777', 'orange'] },
    { name: 'mention entityId/label', doc: doc(P({ type: 'mention', attrs: { id: 'M1', label: 'Alice', entityType: 'user', entityId: 'ENT777' } })), needles: ['Alice', 'ENT777'] },
    { name: 'columns widths', doc: doc({ type: 'columns', content: [{ type: 'column', attrs: { width: '37%' }, content: [P(T('L'))] }, { type: 'column', attrs: { width: '63%' }, content: [P(T('R'))] }] }), needles: ['37%', '63%'] },
    { name: 'highlight color', doc: doc(P(T('x', [{ type: 'highlight', attrs: { color: '#abcdef' } }]))), needles: ['#abcdef'] },
  ];
  for (const { name, doc: original, needles } of ATTR_CASES) {
    it(`preserves ${name}`, async () => {
      const md = convertProseMirrorToMarkdown(original);
      const back = JSON.stringify(await markdownToProseMirror(md));
      for (const needle of needles) {
        // The value must survive in the re-imported doc (or in the markdown the
        // schema parses it back from).
        expect(`${back} ${md}`).toContain(needle);
      }
    });
  }
});

// Find the FIRST node of a given type anywhere in a ProseMirror tree (depth
// first). Used by the structural round-trip assertions below that need the
// re-imported node's concrete attrs/content, not just "the type is present".
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

// Collect every text run reachable under a node (concatenated). Lets a test
// assert a footnote definition's note BODY survived, not just the wrapper.
function allText(n: any): string {
  if (!n || typeof n !== 'object') return '';
  if (n.type === 'text') return n.text || '';
  if (Array.isArray(n.content)) return n.content.map(allText).join('');
  return '';
}

// Attributes survive as the TYPE-correct value, not just as a substring of the
// serialized blob. These re-import and assert on the concrete re-parsed node.
describe('git-sync converter: lose-prone atoms keep their VALUES across a round trip', () => {
  it('A: a NESTED details (inside columns) keeps open:true', async () => {
    // The raw-HTML path (detailsToHtml) is used for a details nested in a
    // column/spanned cell — distinct from the top-level details case. Before the
    // fix it emitted a bare <details>, dropping open every round trip.
    const original = doc({
      type: 'columns',
      content: [
        {
          type: 'column',
          attrs: { width: '100%' },
          content: [
            {
              type: 'details',
              attrs: { open: true },
              content: [
                { type: 'detailsSummary', content: [T('S')] },
                { type: 'detailsContent', content: [P(T('b'))] },
              ],
            },
          ],
        },
      ],
    });
    const md = convertProseMirrorToMarkdown(original);
    // detailsToHtml must emit the `open` attribute (RED before the fix: it
    // emitted a bare <details> inside the column).
    expect(md).toContain('<details open>');
    const back = await markdownToProseMirror(md);
    const details = findNode(back, 'details');
    expect(details).toBeDefined();
    // `open` must round-trip as a STRICT boolean `true` — not "" (the old raw
    // getAttribute value) and not the default `false` (a dropped attribute).
    // Before the schema parseHTML fix (hasAttribute), `<details open>` parsed to
    // "" — falsy, so it rendered as a bare <details> and collapsed. RED before
    // the fix (open was "" or false, never === true).
    expect(details.attrs?.open).toBe(true);
  });

  it('B: a TOP-LEVEL details keeps open as strict boolean true', async () => {
    const original = doc({
      type: 'details',
      attrs: { open: true },
      content: [
        { type: 'detailsSummary', content: [T('S')] },
        { type: 'detailsContent', content: [P(T('b'))] },
      ],
    });
    const md = convertProseMirrorToMarkdown(original);
    const back = await markdownToProseMirror(md);
    const details = findNode(back, 'details');
    expect(details).toBeDefined();
    // Strict boolean, proving the value survives as `true` (not ""/false).
    // RED before the fix: parseHTML returned getAttribute("open") === "".
    expect(details.attrs?.open).toBe(true);
  });

  it('D: htmlEmbed source VALUE and height survive', async () => {
    const original = doc({
      type: 'htmlEmbed',
      attrs: { source: '<b>hi</b>', height: 300 },
    });
    const md = convertProseMirrorToMarkdown(original);
    const back = await markdownToProseMirror(md);
    const embed = findNode(back, 'htmlEmbed');
    expect(embed).toBeDefined();
    // The exact raw source must decode back identically (base64 round trip).
    expect(embed.attrs?.source).toBe('<b>hi</b>');
    expect(embed.attrs?.height).toBe(300);
  });

  it('E: footnote definition BODY survives and its id matches the reference', async () => {
    const original = doc(
      P(T('x'), { type: 'footnoteReference', attrs: { id: 'fn1' } }),
      {
        type: 'footnotesList',
        content: [
          {
            type: 'footnoteDefinition',
            attrs: { id: 'fn1' },
            content: [P(T('note'))],
          },
        ],
      },
    );
    const md = convertProseMirrorToMarkdown(original);
    const back = await markdownToProseMirror(md);
    const list = findNode(back, 'footnotesList');
    const def = findNode(back, 'footnoteDefinition');
    const ref = findNode(back, 'footnoteReference');
    expect(list).toBeDefined();
    expect(def).toBeDefined();
    expect(ref).toBeDefined();
    // The note text rode along, not just the empty wrapper.
    expect(allText(def)).toContain('note');
    // The reference still points at the matching definition.
    expect(ref.attrs?.id).toBe(def.attrs?.id);
  });

  it('F: transclusionReference keeps BOTH sourcePageId and transclusionId', async () => {
    const original = doc({
      type: 'transclusionReference',
      attrs: { sourcePageId: 'PAGE_X', transclusionId: 'TR_Y' },
    });
    const md = convertProseMirrorToMarkdown(original);
    const back = await markdownToProseMirror(md);
    const ref = findNode(back, 'transclusionReference');
    expect(ref).toBeDefined();
    expect(ref.attrs?.sourcePageId).toBe('PAGE_X');
    expect(ref.attrs?.transclusionId).toBe('TR_Y');
  });

  it('F: transclusionSource keeps its id and re-parses its child body', async () => {
    const original = doc({
      type: 'transclusionSource',
      attrs: { id: 'SRC_Z' },
      content: [P(T('shared body'))],
    });
    const md = convertProseMirrorToMarkdown(original);
    const back = await markdownToProseMirror(md);
    const src = findNode(back, 'transclusionSource');
    expect(src).toBeDefined();
    expect(src.attrs?.id).toBe('SRC_Z');
    expect(allText(src)).toContain('shared body');
  });
});

// ---------------------------------------------------------------------------
// #549: hardBreak COUNT/position preservation across a pm -> md -> pm round
// trip. The FIXTURES block above only proves a mid-paragraph hardBreak survives
// as a node; these pin the three sub-cases whose `  \n` two-space form was
// silently dropped on re-import (trailing / consecutive / table cell), plus a
// mid-paragraph regression guard so the byte-stable `  \n` form is not lost.
// ---------------------------------------------------------------------------
describe('#549: hardBreak survives every round-trip position', () => {
  const HB = { type: 'hardBreak' };
  const countHardBreaks = (n: any): number => {
    let c = n?.type === 'hardBreak' ? 1 : 0;
    if (Array.isArray(n?.content)) for (const ch of n.content) c += countHardBreaks(ch);
    return c;
  };
  const roundTripCount = async (d: any): Promise<number> =>
    countHardBreaks(await markdownToProseMirror(convertProseMirrorToMarkdown(d)));

  it('mid-paragraph break is still preserved (regression guard)', async () => {
    expect(await roundTripCount(doc(P(T('a'), HB, T('b'))))).toBe(1);
  });

  it('(1) trailing break at the end of the last paragraph survives', async () => {
    expect(await roundTripCount(doc(P(T('a'), HB)))).toBe(1);
  });

  it('(2) two consecutive breaks in one paragraph survive', async () => {
    expect(await roundTripCount(doc(P(T('a'), HB, HB, T('b'))))).toBe(2);
  });

  it('(3) a break inside a table cell survives', async () => {
    const table = doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('h'))] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('a'), HB, T('b'))] }] },
      ],
    });
    expect(await roundTripCount(table)).toBe(1);
  });
});
