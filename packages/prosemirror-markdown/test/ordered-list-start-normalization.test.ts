import { describe, expect, it } from 'vitest';
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

// ---------------------------------------------------------------------------
// #351 regression — DEGENERATE orderedList `start` normalization (DO-1).
//
// Only an INTEGER >= 2 is a valid explicit start. A degenerate start (0,
// negative, fractional, non-number) MUST collapse to the default 1 on export:
// emitting the raw value would produce an untokenizable marker (e.g. "-3.",
// "2.5.") that `marked` cannot parse, causing the WHOLE orderedList (and its
// listItems) to re-import as a PARAGRAPH — structural corruption. This test
// pins that each degenerate start:
//   (1) exports to "1."/"2." markers (default numbering),
//   (2) re-imports as a VALID `orderedList` (not a paragraph) with `start`
//       defaulting, structure preserved,
//   (3) is byte-stable (md1 === md2).
//
// Mutation check: revert the converter guard to `Number(raw) || 1` and this
// test goes RED (a fractional/negative start leaks into the marker).
// ---------------------------------------------------------------------------

const makeDoc = (start: unknown) => ({
  type: 'doc',
  content: [
    {
      type: 'orderedList',
      attrs: { type: null, start },
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] },
          ],
        },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'beta' }] },
          ],
        },
      ],
    },
  ],
});

describe('#351 orderedList degenerate start normalization', () => {
  for (const start of [0, -3, 2.5]) {
    it(`start=${start} exports as default "1."/"2." markers`, () => {
      const md = convertProseMirrorToMarkdown(makeDoc(start));
      expect(md).toContain('1. alpha');
      expect(md).toContain('2. beta');
      // The degenerate value must NOT leak into any marker.
      expect(md).not.toMatch(/-?\d*\.\d+\.\s/); // no fractional marker like "2.5."
      expect(md).not.toContain('-3.');
    });

    it(`start=${start} re-imports as a valid orderedList (not a paragraph)`, async () => {
      const md = convertProseMirrorToMarkdown(makeDoc(start));
      const doc = (await markdownToProseMirror(md)) as any;
      const top = doc.content?.[0];
      expect(top?.type).toBe('orderedList');
      // start defaults (never the degenerate value); tiptap materializes 1.
      expect(top?.attrs?.start ?? 1).toBe(1);
      expect(top?.content?.length).toBe(2);
    });

    it(`start=${start} is byte-stable across a re-export`, async () => {
      const md1 = convertProseMirrorToMarkdown(makeDoc(start));
      const doc = await markdownToProseMirror(md1);
      const md2 = convertProseMirrorToMarkdown(doc);
      expect(md2).toBe(md1);
    });
  }
});
