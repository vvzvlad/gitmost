import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src (NOT the docmost-client barrel, which pulls in
// collaboration.ts and mutates the global DOM at import time), matching the
// other converter unit tests.
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';
import { standaloneCommentFor } from '../src/lib/attached-comment.js';

// #293 canon decision #5: `subpages` and `pageBreak` serialize as STANDALONE
// HTML comments on their own line —
//   <!--subpages-->            <!--subpages {"recursive":true}-->   <!--pagebreak-->
// — invisible in any markdown renderer, yet round-tripping (the importer
// materializes them back into the block atom before generateJSON drops the
// comment). Position determines legality: they are honored ONLY standalone; a
// comment attached after visible text is INERT. Inside a raw-HTML container
// (columns/cells) the DOM parse stage discards comment nodes, so there the
// schema `<div data-type="...">` form is emitted instead. These tests assert the
// EXACT emitted markdown and a lossless round trip (non-vacuous).

const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const text = (t: string) => ({ type: 'text', text: t });
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

// Recursively collect every node type present in a doc.
const collectTypes = (n: any, set = new Set<string>()): Set<string> => {
  if (!n || typeof n !== 'object') return set;
  if (n.type) set.add(n.type);
  if (Array.isArray(n.content)) n.content.forEach((c: any) => collectTypes(c, set));
  return set;
};

// Find the subpages node anywhere in a doc (for attribute assertions).
const findNode = (n: any, type: string): any => {
  if (!n || typeof n !== 'object') return undefined;
  if (n.type === type) return n;
  if (Array.isArray(n.content)) {
    for (const c of n.content) {
      const hit = findNode(c, type);
      if (hit) return hit;
    }
  }
  return undefined;
};

describe('standaloneCommentFor primitive (#293 #5)', () => {
  it('emits a name-only comment when there are no attrs', () => {
    expect(standaloneCommentFor('pagebreak')).toBe('<!--pagebreak-->');
    expect(standaloneCommentFor('subpages')).toBe('<!--subpages-->');
    expect(standaloneCommentFor('subpages', {})).toBe('<!--subpages-->');
    expect(standaloneCommentFor('subpages', null)).toBe('<!--subpages-->');
  });

  it('emits a compact JSON body when attrs are present', () => {
    expect(standaloneCommentFor('subpages', { recursive: true })).toBe(
      '<!--subpages {"recursive":true}-->',
    );
  });

  it('shares the attached encoder `--` escaping (payload cannot close early)', () => {
    const s = standaloneCommentFor('subpages', { note: 'a--b' });
    expect(s).toBe('<!--subpages {"note":"a\\u002d\\u002db"}-->');
    // No premature `--` inside the payload -> the comment cannot terminate early.
    expect(s.slice('<!--'.length, -'-->'.length)).not.toContain('--');
  });
});

describe('subpages standalone serialization (#293 #5)', () => {
  it('default subpages -> exactly <!--subpages-->', () => {
    expect(convertProseMirrorToMarkdown(doc({ type: 'subpages' }))).toBe('<!--subpages-->');
  });

  it('markdown <!--subpages--> -> a subpages node, byte-stable re-export', async () => {
    const md = '<!--subpages-->';
    const doc2 = await markdownToProseMirror(md);
    expect(collectTypes(doc2).has('subpages')).toBe(true);
    expect(convertProseMirrorToMarkdown(doc2)).toBe(md);
  });

  it('recursive subpages -> <!--subpages {"recursive":true}--> and round-trips recursive:true', async () => {
    const md = convertProseMirrorToMarkdown(
      doc({ type: 'subpages', attrs: { recursive: true } }),
    );
    expect(md).toBe('<!--subpages {"recursive":true}-->');
    const doc2 = await markdownToProseMirror(md);
    const node = findNode(doc2, 'subpages');
    expect(node).toBeTruthy();
    expect(node.attrs.recursive).toBe(true);
    // Byte-stable second export closes the loop.
    expect(convertProseMirrorToMarkdown(doc2)).toBe(md);
  });
});

describe('pageBreak standalone serialization (#293 #5)', () => {
  it('pageBreak -> exactly <!--pagebreak-->', () => {
    expect(convertProseMirrorToMarkdown(doc({ type: 'pageBreak' }))).toBe('<!--pagebreak-->');
  });

  it('markdown <!--pagebreak--> round-trips to a pageBreak node, byte-stable', async () => {
    const md = '<!--pagebreak-->';
    const doc2 = await markdownToProseMirror(md);
    expect(collectTypes(doc2).has('pageBreak')).toBe(true);
    expect(convertProseMirrorToMarkdown(doc2)).toBe(md);
  });
});

describe('subpages inside a column uses the div-form, not a comment (#293 #5)', () => {
  // A column is a raw-HTML block: the DOM parse stage discards comment nodes, so
  // a comment inside it would silently vanish. The converter MUST emit the
  // schema div-form there instead.
  const columnsDoc = doc({
    type: 'columns',
    content: [
      { type: 'column', attrs: { width: '50%' }, content: [{ type: 'subpages' }] },
      { type: 'column', attrs: { width: '50%' }, content: [para(text('side'))] },
    ],
  });

  it('serializes the column subpages as <div data-type="subpages">, not <!--subpages-->', () => {
    const md = convertProseMirrorToMarkdown(columnsDoc);
    expect(md).toContain('data-type="subpages"');
    // The bare standalone comment must NOT appear inside the raw-HTML column.
    expect(md).not.toContain('<!--subpages-->');
  });

  it('round-trips back to a subpages node still inside a column', async () => {
    const md = convertProseMirrorToMarkdown(columnsDoc);
    const doc2 = await markdownToProseMirror(md);
    const column = findNode(doc2, 'column');
    expect(column).toBeTruthy();
    expect(collectTypes(column).has('subpages')).toBe(true);
  });
});

describe('position legality / fail-open (#293 #5)', () => {
  it('an ATTACHED <!--subpages--> after paragraph text is INERT (no subpages node)', async () => {
    const doc2 = await markdownToProseMirror('para text <!--subpages-->');
    expect(collectTypes(doc2).has('subpages')).toBe(false);
    // The paragraph text survives, and no comment marker leaks into the body.
    expect(JSON.stringify(doc2)).not.toContain('<!--');
  });

  it('a malformed <!--subpages {bad--> is INERT (no crash, no subpages node)', async () => {
    const doc2 = await markdownToProseMirror('<!--subpages {bad-->');
    expect(collectTypes(doc2).has('subpages')).toBe(false);
  });
});

describe('multi-node document order across standalone comments (#293 #5)', () => {
  // The riskiest part of the parser change: a LEADING standalone comment is
  // parsed at document level (outside <body>) and must be re-inserted into the
  // body in document order, interleaved correctly with real block content. A
  // MID-document comment (pageBreak here) exercises the in-body branch. This
  // locks the ordering the review flagged as covered only by manual checks.
  const topTypes = (d: any) => (d.content || []).map((n: any) => n.type);

  it('leading + mid + trailing standalone comments keep document order', async () => {
    const d = doc(
      { type: 'subpages' }, // leading -> parsed at document level
      para(text('a')),
      { type: 'pageBreak' }, // mid -> parsed in-body
      para(text('b')),
    );
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe('<!--subpages-->\n\na\n\n<!--pagebreak-->\n\nb');
    const d2 = await markdownToProseMirror(md);
    // Order must be preserved exactly, not just membership.
    expect(topTypes(d2)).toEqual([
      'subpages',
      'paragraph',
      'pageBreak',
      'paragraph',
    ]);
    // And byte-stable on re-export.
    expect(convertProseMirrorToMarkdown(d2)).toBe(md);
  });

  it('two leading standalone comments keep their relative order', async () => {
    const d = doc({ type: 'subpages' }, { type: 'pageBreak' }, para(text('x')));
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe('<!--subpages-->\n\n<!--pagebreak-->\n\nx');
    const d2 = await markdownToProseMirror(md);
    expect(topTypes(d2)).toEqual(['subpages', 'pageBreak', 'paragraph']);
    expect(convertProseMirrorToMarkdown(d2)).toBe(md);
  });

  it('a trailing standalone comment stays last', async () => {
    const d = doc(para(text('x')), { type: 'subpages' });
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toBe('x\n\n<!--subpages-->');
    const d2 = await markdownToProseMirror(md);
    expect(topTypes(d2)).toEqual(['paragraph', 'subpages']);
    expect(convertProseMirrorToMarkdown(d2)).toBe(md);
  });
});
