import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src (NOT the docmost-client barrel, which pulls in
// collaboration.ts and mutates global DOM at import time).
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';
import {
  attachedCommentFor,
  parseAttachedComment,
} from '../src/lib/attached-comment.js';

// #293 canon decision #9: paragraph/heading `textAlign` serializes as an
// ATTACHED HTML comment at the END of the block line —
//   `some text <!--attrs {"textAlign":"center"}-->`
// — replacing the old `<div align>` / `<p style="text-align:…">` wrappers, which
// did NOT round-trip cleanly (alignment was lost on the first stabilize pass).
// These tests are non-vacuous: they assert the EXACT emitted markdown (so they
// fail against any wrapper form) AND that the alignment survives a full
// PM -> MD -> PM round trip (which the old `<div align>` never did).

const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const text = (t: string) => ({ type: 'text', text: t });
const para = (align: string | null, ...inline: any[]) => ({
  type: 'paragraph',
  attrs: align === null ? {} : { textAlign: align },
  content: inline,
});
const heading = (level: number, align: string | null, ...inline: any[]) => ({
  type: 'heading',
  attrs: align === null ? { level } : { level, textAlign: align },
  content: inline,
});

// Find the first paragraph/heading node in a generated doc (skips the doc root).
const firstBlock = (d: any) => d.content?.[0];

describe('attached-comment primitives (reusable for #9/#4/#8)', () => {
  it('attachedCommentFor emits a compact `<!--name {json}-->`', () => {
    expect(attachedCommentFor('attrs', { textAlign: 'center' })).toBe(
      '<!--attrs {"textAlign":"center"}-->',
    );
  });

  it('attachedCommentFor escapes a `--` pair so it cannot close the comment early', () => {
    // A string value containing `--` would otherwise inject `-->`. Each hyphen of
    // the pair is emitted as the JSON unicode escape -; JSON.parse restores
    // the original hyphens on the reading side.
    const s = attachedCommentFor('img', { alt: 'a--b' });
    expect(s).toBe('<!--img {"alt":"a\\u002d\\u002db"}-->');
    // No premature `--` inside the payload (between the `<!--` opener and the
    // `-->` closer), so the comment cannot terminate early.
    expect(s.slice(4, -3)).not.toContain('--');
    // Round-trip through the parser primitive restores the exact value.
    const inner = s.slice('<!--'.length, -'-->'.length);
    expect(parseAttachedComment(inner)).toEqual({ name: 'img', attrs: { alt: 'a--b' } });
  });

  it('parseAttachedComment fails open on malformed JSON and non-objects', () => {
    expect(parseAttachedComment('attrs {not json}')).toBeNull();
    expect(parseAttachedComment('attrs [1,2]')).toBeNull();
    expect(parseAttachedComment('   ')).toBeNull();
    // Name-only comment is a valid marker with empty attrs.
    expect(parseAttachedComment('attrs')).toEqual({ name: 'attrs', attrs: {} });
  });
});

describe('paragraph.textAlign serialization (#293 #9)', () => {
  for (const align of ['center', 'right', 'justify']) {
    it(`paragraph textAlign "${align}" -> trailing <!--attrs--> comment`, () => {
      expect(convertProseMirrorToMarkdown(doc(para(align, text('hello'))))).toBe(
        `hello <!--attrs {"textAlign":"${align}"}-->`,
      );
    });
  }

  it('default textAlign (null) emits NO comment', () => {
    expect(convertProseMirrorToMarkdown(doc(para(null, text('hello'))))).toBe('hello');
  });

  it('"left" (visual default) emits NO comment', () => {
    expect(convertProseMirrorToMarkdown(doc(para('left', text('hello'))))).toBe('hello');
  });
});

describe('heading.textAlign serialization (#293 #9)', () => {
  it('heading keeps "## text" and attaches the alignment comment', () => {
    expect(convertProseMirrorToMarkdown(doc(heading(2, 'center', text('Title'))))).toBe(
      '## Title <!--attrs {"textAlign":"center"}-->',
    );
  });

  it('default heading emits the bare "## text" form', () => {
    expect(convertProseMirrorToMarkdown(doc(heading(3, null, text('Plain'))))).toBe('### Plain');
  });
});

describe('paragraph.textAlign round-trip PM -> MD -> PM (#293 #9)', () => {
  for (const align of ['center', 'right', 'justify']) {
    it(`preserves paragraph textAlign "${align}"`, async () => {
      const md1 = convertProseMirrorToMarkdown(doc(para(align, text('hello'))));
      expect(md1).toBe(`hello <!--attrs {"textAlign":"${align}"}-->`);
      const doc2 = await markdownToProseMirror(md1);
      const block = firstBlock(doc2);
      expect(block.type).toBe('paragraph');
      expect(block.attrs.textAlign).toBe(align);
      // Text is intact (the trailing space before the comment is trimmed).
      expect(block.content?.[0]?.text).toBe('hello');
      // Byte-stable second export closes the loop.
      expect(convertProseMirrorToMarkdown(doc2)).toBe(md1);
    });
  }

  it('default paragraph re-imports with textAlign null (no comment survives)', async () => {
    const md1 = convertProseMirrorToMarkdown(doc(para(null, text('hello'))));
    const doc2 = await markdownToProseMirror(md1);
    const block = firstBlock(doc2);
    expect(block.type).toBe('paragraph');
    expect(block.attrs.textAlign ?? null).toBeNull();
  });
});

describe('heading.textAlign round-trip PM -> MD -> PM (#293 #9)', () => {
  for (const [level, align] of [
    [2, 'center'],
    [3, 'right'],
    [1, 'justify'],
  ] as [number, string][]) {
    it(`preserves h${level} textAlign "${align}"`, async () => {
      const md1 = convertProseMirrorToMarkdown(doc(heading(level, align, text('Head'))));
      expect(md1).toBe(`${'#'.repeat(level)} Head <!--attrs {"textAlign":"${align}"}-->`);
      const doc2 = await markdownToProseMirror(md1);
      const block = firstBlock(doc2);
      expect(block.type).toBe('heading');
      expect(block.attrs.level).toBe(level);
      expect(block.attrs.textAlign).toBe(align);
      expect(convertProseMirrorToMarkdown(doc2)).toBe(md1);
    });
  }
});

describe('attached-comment fail-open in the import pipeline (#293 #9)', () => {
  it('a malformed attrs comment is ignored (default attrs kept)', async () => {
    const doc2 = await markdownToProseMirror('hello <!--attrs {bad json}-->');
    const block = firstBlock(doc2);
    expect(block.type).toBe('paragraph');
    expect(block.attrs.textAlign ?? null).toBeNull();
    expect(block.content?.[0]?.text).toBe('hello');
  });

  it('an unknown key in a valid attrs comment is ignored, no comment leaks', async () => {
    const doc2 = await markdownToProseMirror('hello <!--attrs {"bogus":"x"}-->');
    const block = firstBlock(doc2);
    expect(block.type).toBe('paragraph');
    expect(block.attrs.textAlign ?? null).toBeNull();
    // The unknown key and the comment marker must not survive into the body.
    expect(block.content?.[0]?.text).toBe('hello');
    const serialized = JSON.stringify(doc2);
    expect(serialized).not.toContain('bogus');
    expect(serialized).not.toContain('<!--');
  });
});
