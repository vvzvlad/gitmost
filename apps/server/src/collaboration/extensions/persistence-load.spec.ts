/**
 * gitmost #401 fix 2 — onLoadDocument applies the DB state directly into the
 * hook's target document and returns undefined (instead of building a NEW Y.Doc
 * and returning it, which made hocuspocus re-encode+apply the whole state a
 * SECOND time on every cold load).
 *
 * These tests assert:
 *  - the hook mutates `data.document` in place so its content equals the DB doc,
 *  - onLoadDocument returns undefined (so hocuspocus keeps the mutated doc and
 *    does NOT run its own applyUpdate(encodeStateAsUpdate(...)) merge),
 *  - both the raw-ydoc branch and the json→ydoc conversion branch behave so.
 *
 * Returning undefined is the observable signal that the double-encode is gone
 * (the old code returned a new Y.Doc, which made hocuspocus re-encode+apply the
 * state a second time); we assert that contract rather than counting internal
 * encode calls, which is brittle given the encodes inside toYdoc and the test's
 * own `expected` fixtures.
 */
import * as Y from 'yjs';
import { Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PersistenceExtension } from './persistence.extension';
import { tiptapExtensions } from '../collaboration.util';

// A fresh hocuspocus Document (extends Y.Doc, adds isEmpty()) as hocuspocus
// hands to onLoadDocument on a cold load.
const freshDoc = () => new Document(`page.${PAGE_ID}`, {});

const PAGE_ID = '550e8400-e29b-41d4-a716-446655440000';

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const jsonOf = (ydoc: Y.Doc) =>
  TiptapTransformer.fromYdoc(ydoc, 'default');

describe('PersistenceExtension.onLoadDocument — #401 fix 2 (apply-into-hook-doc)', () => {
  let ext: PersistenceExtension;
  let pageRepo: { findById: jest.Mock };

  beforeEach(() => {
    pageRepo = { findById: jest.fn() };
    ext = new PersistenceExtension(
      pageRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(ext['logger'], 'debug').mockImplementation(() => undefined);
    jest.spyOn(ext['logger'], 'warn').mockImplementation(() => undefined);
  });

  const load = (document: Document) =>
    ext.onLoadDocument({ documentName: `page.${PAGE_ID}`, document } as any);

  it('raw ydoc branch: mutates the hook doc to the DB state and returns undefined', async () => {
    // Source doc representing the persisted ydoc state.
    const source = TiptapTransformer.toYdoc(
      doc('DB CONTENT'),
      'default',
      tiptapExtensions,
    );
    const dbState = Buffer.from(Y.encodeStateAsUpdate(source));
    pageRepo.findById.mockResolvedValue({ id: PAGE_ID, ydoc: dbState });

    // The hook target is a fresh empty doc (as hocuspocus supplies on cold load).
    const target = freshDoc();
    const result = await load(target);

    // Return undefined so hocuspocus keeps `target` as-is (no second merge).
    expect(result).toBeUndefined();
    // The hook document now carries the DB content.
    expect(jsonOf(target)).toEqual(jsonOf(source));
  });

  it('json→ydoc branch: converts page.content into the hook doc and returns undefined', async () => {
    pageRepo.findById.mockResolvedValue({
      id: PAGE_ID,
      ydoc: null,
      content: doc('JSON CONTENT'),
    });

    const target = freshDoc();
    const result = await load(target);

    // Returning undefined is what keeps hocuspocus from re-encoding+applying the
    // state a second time (the old code returned the doc, forcing that extra
    // encode). We assert the observable contract here — the return value and the
    // resulting content — rather than counting internal encode calls, which is
    // brittle: toYdoc and the `expected` build below both encode too.
    expect(result).toBeUndefined();

    // The converted content landed in the hook document.
    const expected = TiptapTransformer.toYdoc(
      doc('JSON CONTENT'),
      'default',
      tiptapExtensions,
    );
    expect(jsonOf(target)).toEqual(jsonOf(expected));
  });

  it('live doc already non-empty: early return, no DB read', async () => {
    // A hocuspocus Document carrying live content (isEmpty('default') === false).
    const target = freshDoc();
    const live = TiptapTransformer.toYdoc(
      doc('LIVE'),
      'default',
      tiptapExtensions,
    );
    Y.applyUpdate(target, Y.encodeStateAsUpdate(live));

    const result = await load(target);
    expect(result).toBeUndefined();
    expect(pageRepo.findById).not.toHaveBeenCalled();
  });

  it('no persisted state: leaves the fresh empty doc untouched, returns undefined', async () => {
    pageRepo.findById.mockResolvedValue({ id: PAGE_ID, ydoc: null, content: null });
    const target = freshDoc();
    const result = await load(target);
    expect(result).toBeUndefined();
    expect(target.isEmpty('default')).toBe(true);
  });
});
