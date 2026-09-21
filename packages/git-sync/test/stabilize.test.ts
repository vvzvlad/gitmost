import { describe, expect, it } from 'vitest';
import { stabilizePageFile, type PageMeta } from '../src/engine/stabilize.js';
// markdownToProseMirror lives in collaboration.ts; importing it mutates the
// global DOM via jsdom at module load time (required for @tiptap/html under Node).
import { markdownToProseMirror } from '@docmost/prosemirror-markdown';
import { parseDocmostMarkdown } from '@docmost/prosemirror-markdown';
import { ConverterLossError } from '@docmost/prosemirror-markdown';

// stabilize.ts (SPEC §11 normalize-on-write) was 0% covered (only the gated e2e
// touched it). stabilizePageFile is import-testable: build a small ProseMirror
// content + meta and assert (1) the normalize-on-write pass reaches a fixpoint
// (a SECOND pass over the written body is byte-identical), and (2) the meta is
// serialized verbatim, including a null parentPageId.

const meta: PageMeta = {
  version: 1,
  pageId: 'pg-1',
  slugId: 'sl-1',
  title: 'My Title',
  spaceId: 'sp-1',
  parentPageId: null,
};

describe('stabilizePageFile — normalize-on-write fixpoint (SPEC §11)', () => {
  it('reaches a byte-identical fixpoint after one extra export/import/export pass', async () => {
    // A diagram inside a column is the canonical one-pass asymmetry: on the
    // raw-HTML/columns path a diagram's `align` default of "center" materializes
    // on import, so a NAIVE export differs on the second export. (#293 canon #8
    // made the TOP-LEVEL diagram form — `![](src)<!--drawio …-->` — byte-stable by
    // omitting the default, so the asymmetry now lives only on the columns path
    // where the schema `<div data-type="drawio">` form is retained.)
    // stabilizePageFile runs the convergence pass at write time, so the written
    // body must already be at the fixpoint: re-importing its body and
    // re-stabilizing yields the exact same bytes.
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        {
          type: 'columns',
          attrs: { layout: 'two_equal' },
          content: [
            { type: 'column', content: [{ type: 'drawio', attrs: { src: '/d.drawio' } }] },
            { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'side' }] }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'outro' }] },
      ],
    };

    const file1 = await stabilizePageFile(content, meta);
    // Re-import the written body and stabilize again — the second pass must be
    // byte-identical to the first (the fixpoint property git relies on).
    const body1 = parseDocmostMarkdown(file1).body;
    const doc2 = await markdownToProseMirror(body1);
    const file2 = await stabilizePageFile(doc2, meta);
    expect(file2).toBe(file1);

    // The drawio node was materialized to its canonical HTML form by the
    // convergence pass — a bare `{ src }` doc node becomes the full
    // `<div data-type="drawio" data-src=...>` — proof the pass actually ran, not
    // just two naive exports happening to match. Assert on the stable canonical
    // markers rather than `data-align="center"`: center is a schema default the
    // converter may omit (see prosemirror-markdown media-html.ts), so it is not
    // a reliable convergence proof.
    expect(body1).toContain('data-type="drawio"');
    expect(body1).toContain('data-src="/d.drawio"');
  });

  it('runs the serializer in STRICT mode — an unmappable node throws, not a lossy write (#493)', async () => {
    // git-sync is the lossless mirror path: a node type the converter has no
    // case for (here a fabricated one, standing in for a schema type added
    // without a matching serializer arm) must surface loudly at write time
    // rather than being silently flattened into a lossy .md file.
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'ok' }] },
        { type: 'quantumWidget', content: [{ type: 'text', text: 'lost?' }] },
      ],
    };
    await expect(stabilizePageFile(content, meta)).rejects.toBeInstanceOf(
      ConverterLossError,
    );
  });

  it('already-stable content is unchanged by the pass (idempotent)', async () => {
    // Plain prose is already a fixpoint; stabilizing it once and twice agree.
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'just plain text' }] }],
    };
    const file1 = await stabilizePageFile(content, meta);
    const body1 = parseDocmostMarkdown(file1).body;
    const doc2 = await markdownToProseMirror(body1);
    const file2 = await stabilizePageFile(doc2, meta);
    expect(file2).toBe(file1);
    expect(body1).toBe('just plain text');
  });
});

describe('stabilizePageFile — meta serialization', () => {
  it('preserves a null parentPageId verbatim in the meta block', async () => {
    const file = await stabilizePageFile(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
      meta,
    );
    const parsed = parseDocmostMarkdown(file);
    // The whole meta round-trips, and parentPageId is exactly null (root page).
    expect(parsed.meta).toEqual(meta);
    expect(parsed.meta!.parentPageId).toBeNull();
    // No trailing docmost:comments block — the sync body serializer omits it.
    expect(file).not.toContain('docmost:comments');
  });

  it('keeps a non-null parentPageId as-is', async () => {
    const childMeta: PageMeta = { ...meta, parentPageId: 'parent-99' };
    const file = await stabilizePageFile(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
      childMeta,
    );
    expect(parseDocmostMarkdown(file).meta).toEqual(childMeta);
  });
});
