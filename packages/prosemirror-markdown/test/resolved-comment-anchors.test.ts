import { describe, expect, it } from 'vitest';
// Import the converter DIRECTLY from src (NOT the docmost-client barrel, which
// pulls in collaboration.ts and mutates the global DOM at import time), matching
// the other converter unit tests (see markdown-converter-html-marks.test.ts).
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';

// gitmost #328 Channel 1: the `dropResolvedCommentAnchors` converter option
// hides RESOLVED comment anchors from agent reads while keeping ACTIVE anchors.
// The option defaults to false (zero behavior change for the lossless git-sync
// export path). Two emitters read it: the top-level marks loop and the raw-HTML
// inlineToHtml path (inside columns / spanned table cells).

const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });

const commentMark = (commentId: string, resolved: boolean) => ({
  type: 'comment',
  attrs: { commentId, resolved },
});

// A columns node (raw-HTML container) so its children render via the
// blockToHtml -> inlineToHtml path (the SECOND `case "comment"` emitter).
const oneColumn = (...blocks: any[]) => ({
  type: 'columns',
  attrs: { layout: 'two' },
  content: [{ type: 'column', content: blocks }],
});

describe('#328 Channel 1 — top-level emitter: dropResolvedCommentAnchors', () => {
  const resolvedDoc = doc(
    para(text('kept '), text('resolved', [commentMark('r1', true)])),
  );
  const activeDoc = doc(
    para(text('kept '), text('active', [commentMark('a1', false)])),
  );

  it('drops a RESOLVED anchor (bare text) WITH the flag', () => {
    const out = convertProseMirrorToMarkdown(resolvedDoc, {
      dropResolvedCommentAnchors: true,
    });
    expect(out).toBe('kept resolved');
    expect(out).not.toContain('data-comment-id');
  });

  it('PRESERVES a RESOLVED anchor WITHOUT the flag (default off)', () => {
    const out = convertProseMirrorToMarkdown(resolvedDoc);
    expect(out).toContain(
      '<span data-comment-id="r1" data-resolved="true">resolved</span>',
    );
  });

  it('KEEPS an ACTIVE anchor in BOTH cases', () => {
    const withFlag = convertProseMirrorToMarkdown(activeDoc, {
      dropResolvedCommentAnchors: true,
    });
    const withoutFlag = convertProseMirrorToMarkdown(activeDoc);
    expect(withFlag).toContain('<span data-comment-id="a1">active</span>');
    expect(withoutFlag).toContain('<span data-comment-id="a1">active</span>');
  });
});

describe('#328 Channel 1 — raw-HTML inlineToHtml emitter (columns)', () => {
  const resolvedCol = doc(
    oneColumn(para(text('resolved', [commentMark('r1', true)]))),
  );
  const activeCol = doc(
    oneColumn(para(text('active', [commentMark('a1', false)]))),
  );

  it('drops a RESOLVED anchor (bare text) WITH the flag', () => {
    const out = convertProseMirrorToMarkdown(resolvedCol, {
      dropResolvedCommentAnchors: true,
    });
    expect(out).toContain('<p>resolved</p>');
    expect(out).not.toContain('data-comment-id');
  });

  it('PRESERVES a RESOLVED anchor WITHOUT the flag', () => {
    const out = convertProseMirrorToMarkdown(resolvedCol);
    expect(out).toContain(
      '<span data-comment-id="r1" data-resolved="true">resolved</span>',
    );
  });

  it('KEEPS an ACTIVE anchor in BOTH cases', () => {
    const withFlag = convertProseMirrorToMarkdown(activeCol, {
      dropResolvedCommentAnchors: true,
    });
    const withoutFlag = convertProseMirrorToMarkdown(activeCol);
    expect(withFlag).toContain('<span data-comment-id="a1">active</span>');
    expect(withoutFlag).toContain('<span data-comment-id="a1">active</span>');
  });
});
