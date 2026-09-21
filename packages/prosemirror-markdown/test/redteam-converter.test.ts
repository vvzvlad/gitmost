import { describe, expect, it } from 'vitest';
// Import the converter DIRECTLY from src (NOT the docmost-client barrel, which
// pulls in collaboration.ts and mutates the global DOM at import time), matching
// the other converter unit tests. markdownToProseMirror is imported for the
// round-trip cases; loading it mutates the global DOM via jsdom (required for
// @tiptap/html's generateJSON under Node) — this is expected.
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });

// ---------------------------------------------------------------------------
// #1 editor-ext atoms dropped: the `default` branch (markdown-converter.ts
// ~584-586) collapses unknown atoms to "" by mapping their (empty) children.
// ---------------------------------------------------------------------------
describe('#1 editor-ext atoms dropped', () => {
  it('preserves an inline status atom text', () => {
    const d = doc({
      type: 'paragraph',
      content: [{ type: 'status', attrs: { text: 'Done' } }],
    });
    expect(convertProseMirrorToMarkdown(d)).toContain('Done');
  });

  it('preserves a block htmlEmbed atom', () => {
    const d = doc({ type: 'htmlEmbed', attrs: { source: '<b>hi</b>' } });
    expect(convertProseMirrorToMarkdown(d)).not.toBe('');
  });

  it('preserves a footnoteReference atom', () => {
    const d = doc({
      type: 'paragraph',
      content: [{ type: 'footnoteReference', attrs: { id: 'fn1', referenceNumber: 1 } }],
    });
    expect(convertProseMirrorToMarkdown(d)).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// #2 top-level image attrs lost: a top-level image emits markdown ![](src),
// which carries no width/height/align/attachmentId.
// ---------------------------------------------------------------------------
describe('#2 top-level image attrs lost', () => {
  it('keeps width through export and re-import', async () => {
    const d = doc({
      type: 'image',
      attrs: { src: '/files/x.png', width: '320', height: '200', align: 'right', attachmentId: 'a1' },
    });
    const md = convertProseMirrorToMarkdown(d);
    expect(md).toContain('320');
    const back = await markdownToProseMirror(md);
    expect(back.content[0].attrs.width).toBe('320');
  });
});

// ---------------------------------------------------------------------------
// #3 code-fence corruption: a code block whose TEXT contains a ``` fence must
// be emitted with a wider outer fence so the inner fence survives.
// ---------------------------------------------------------------------------
describe('#3 code-fence corruption', () => {
  it('round-trips a code block containing an inner fence', async () => {
    const code = '```js\nfoo()\n```';
    const d = doc({
      type: 'codeBlock',
      attrs: { language: '' },
      content: [{ type: 'text', text: code }],
    });
    const md1 = convertProseMirrorToMarkdown(d);
    const back = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(back);
    expect(md2).toBe(md1);
  });
});

// ---------------------------------------------------------------------------
// #16 depth guard: deep recursion in processNode overflows the stack (today a
// RangeError) instead of being guarded.
// ---------------------------------------------------------------------------
describe('#16 depth guard', () => {
  it('does not throw on a deeply nested blockquote doc', () => {
    const DEPTH = 50000;
    let node: any = { type: 'paragraph', content: [{ type: 'text', text: 'x' }] };
    for (let i = 0; i < DEPTH; i++) {
      node = { type: 'blockquote', content: [node] };
    }
    const d = doc(node);
    expect(() => convertProseMirrorToMarkdown(d)).not.toThrow();
  });
});
