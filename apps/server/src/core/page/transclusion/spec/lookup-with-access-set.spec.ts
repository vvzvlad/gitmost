import { TransclusionService } from '../transclusion.service';

/**
 * Tests for TransclusionService.lookupWithAccessSet — the positional resolver
 * that maps an ordered list of `(sourcePageId, transclusionId)` references onto
 * an output array of the SAME length and order. The caller supplies the set of
 * accessible source page ids; this method only resolves content for those, and
 * must never let one page's content surface under another page's slot.
 *
 * The two repos it touches:
 *   - pageTransclusionsRepo.findManyByPageAndTransclusion(keys, workspaceId)
 *       -> rows of { pageId, transclusionId, content }
 *   - pageRepo.findManyByIds(ids, { workspaceId })
 *       -> pages of { id, updatedAt } (used only for sourceUpdatedAt / not_found)
 *
 * Result statuses (transclusion.service.ts ~533):
 *   - source not in accessibleSet            -> 'no_access'
 *   - accessible but page meta missing       -> 'not_found'
 *   - accessible + page present, row missing -> 'not_found'
 *   - accessible + page present + row present-> { content, sourceUpdatedAt }
 *
 * Catch: positional misalignment leaking one page's content under another's
 * slot. We assert each output index carries the right sourcePageId/content.
 */

const now = (n: number) => new Date(`2026-06-2${n}T00:00:00.000Z`);

function buildService(opts: {
  rows: Array<{ pageId: string; transclusionId: string; content: unknown }>;
  pages: Array<{ id: string; updatedAt: Date }>;
}) {
  const findManyByPageAndTransclusion = jest
    .fn()
    .mockResolvedValue(opts.rows);
  const findManyByIds = jest.fn().mockResolvedValue(opts.pages);

  const pageTransclusionsRepo = { findManyByPageAndTransclusion };
  const pageRepo = { findManyByIds };

  const service = new TransclusionService(
    {} as any, // db
    pageTransclusionsRepo as any,
    {} as any, // pageTransclusionReferencesRepo
    {} as any, // pageTemplateReferencesRepo
    pageRepo as any,
    {} as any, // pagePermissionRepo
    {} as any, // spaceMemberRepo
    {} as any, // attachmentRepo
    {} as any, // storageService
    {} as any, // pageAccessService
  );
  return { service, findManyByPageAndTransclusion, findManyByIds };
}

describe('TransclusionService.lookupWithAccessSet', () => {
  it('returns {items:[]} for empty references and queries nothing', async () => {
    const { service, findManyByPageAndTransclusion, findManyByIds } =
      buildService({ rows: [], pages: [] });

    const result = await service.lookupWithAccessSet([], new Set(['p1']), 'w1');
    expect(result).toEqual({ items: [] });
    expect(findManyByPageAndTransclusion).not.toHaveBeenCalled();
    expect(findManyByIds).not.toHaveBeenCalled();
  });

  it('marks a source not in the accessibleSet as no_access', async () => {
    const { service } = buildService({ rows: [], pages: [] });
    const { items } = await service.lookupWithAccessSet(
      [{ sourcePageId: 'private', transclusionId: 't1' }],
      new Set(), // nothing accessible
      'w1',
    );
    expect(items).toEqual([
      { sourcePageId: 'private', transclusionId: 't1', status: 'no_access' },
    ]);
  });

  it('marks an accessible page with no meta (missing/deleted) as not_found', async () => {
    // Accessible, but pageRepo returns no page row -> no updatedAt -> not_found.
    const { service } = buildService({ rows: [], pages: [] });
    const { items } = await service.lookupWithAccessSet(
      [{ sourcePageId: 'gone', transclusionId: 't1' }],
      new Set(['gone']),
      'w1',
    );
    expect(items).toEqual([
      { sourcePageId: 'gone', transclusionId: 't1', status: 'not_found' },
    ]);
  });

  it('accessible page present but no transclusion row -> not_found', async () => {
    const { service } = buildService({
      rows: [], // no matching transclusion row
      pages: [{ id: 'p1', updatedAt: now(0) }],
    });
    const { items } = await service.lookupWithAccessSet(
      [{ sourcePageId: 'p1', transclusionId: 't1' }],
      new Set(['p1']),
      'w1',
    );
    expect(items).toEqual([
      { sourcePageId: 'p1', transclusionId: 't1', status: 'not_found' },
    ]);
  });

  it('accessible + row present -> content with sourceUpdatedAt', async () => {
    const content = { type: 'doc', content: [{ type: 'paragraph' }] };
    const { service } = buildService({
      rows: [{ pageId: 'p1', transclusionId: 't1', content }],
      pages: [{ id: 'p1', updatedAt: now(0) }],
    });
    const { items } = await service.lookupWithAccessSet(
      [{ sourcePageId: 'p1', transclusionId: 't1' }],
      new Set(['p1']),
      'w1',
    );
    expect(items).toEqual([
      {
        sourcePageId: 'p1',
        transclusionId: 't1',
        content,
        sourceUpdatedAt: now(0),
      },
    ]);
  });

  it('keeps positional alignment across a mixed batch (no cross-slot leakage)', async () => {
    // Order: [no_access, content(p2/t-a), not_found(no row), content(p3/t-b)]
    const cA = { type: 'doc', content: [{ type: 'text', text: 'A' }] };
    const cB = { type: 'doc', content: [{ type: 'text', text: 'B' }] };
    const { service } = buildService({
      rows: [
        { pageId: 'p2', transclusionId: 't-a', content: cA },
        { pageId: 'p3', transclusionId: 't-b', content: cB },
      ],
      pages: [
        { id: 'p2', updatedAt: now(1) },
        { id: 'p3', updatedAt: now(2) },
      ],
    });

    const { items } = await service.lookupWithAccessSet(
      [
        { sourcePageId: 'p1', transclusionId: 't-x' }, // not accessible
        { sourcePageId: 'p2', transclusionId: 't-a' }, // content A
        { sourcePageId: 'p2', transclusionId: 't-missing' }, // no row -> not_found
        { sourcePageId: 'p3', transclusionId: 't-b' }, // content B
      ],
      new Set(['p2', 'p3']),
      'w1',
    );

    expect(items[0]).toEqual({
      sourcePageId: 'p1',
      transclusionId: 't-x',
      status: 'no_access',
    });
    expect(items[1]).toEqual({
      sourcePageId: 'p2',
      transclusionId: 't-a',
      content: cA,
      sourceUpdatedAt: now(1),
    });
    expect(items[2]).toEqual({
      sourcePageId: 'p2',
      transclusionId: 't-missing',
      status: 'not_found',
    });
    expect(items[3]).toEqual({
      sourcePageId: 'p3',
      transclusionId: 't-b',
      content: cB,
      sourceUpdatedAt: now(2),
    });
  });

  it('resolves duplicate (sourcePageId, transclusionId) references independently and keeps position', async () => {
    // The same ref appears twice; both slots must resolve to the same content,
    // and a DIFFERENT transclusionId on the same page must not bleed in.
    const cSame = { type: 'doc', content: [{ type: 'text', text: 'same' }] };
    const cOther = { type: 'doc', content: [{ type: 'text', text: 'other' }] };
    const { service } = buildService({
      rows: [
        { pageId: 'p1', transclusionId: 't1', content: cSame },
        { pageId: 'p1', transclusionId: 't2', content: cOther },
      ],
      pages: [{ id: 'p1', updatedAt: now(3) }],
    });

    const { items } = await service.lookupWithAccessSet(
      [
        { sourcePageId: 'p1', transclusionId: 't1' },
        { sourcePageId: 'p1', transclusionId: 't2' },
        { sourcePageId: 'p1', transclusionId: 't1' }, // duplicate of slot 0
      ],
      new Set(['p1']),
      'w1',
    );

    expect(items[0]).toEqual({
      sourcePageId: 'p1',
      transclusionId: 't1',
      content: cSame,
      sourceUpdatedAt: now(3),
    });
    expect(items[1]).toEqual({
      sourcePageId: 'p1',
      transclusionId: 't2',
      content: cOther,
      sourceUpdatedAt: now(3),
    });
    expect(items[2]).toEqual({
      sourcePageId: 'p1',
      transclusionId: 't1',
      content: cSame,
      sourceUpdatedAt: now(3),
    });
  });

  it('only queries transclusions for accessible references', async () => {
    // The inaccessible page id must never appear in the repo key list — that
    // would itself be an existence-leak surface.
    const { service, findManyByPageAndTransclusion, findManyByIds } =
      buildService({
        rows: [{ pageId: 'ok', transclusionId: 't1', content: {} }],
        pages: [{ id: 'ok', updatedAt: now(0) }],
      });

    await service.lookupWithAccessSet(
      [
        { sourcePageId: 'secret', transclusionId: 'tz' },
        { sourcePageId: 'ok', transclusionId: 't1' },
      ],
      new Set(['ok']),
      'w1',
    );

    const keys = findManyByPageAndTransclusion.mock.calls[0][0];
    expect(keys).toEqual([{ pageId: 'ok', transclusionId: 't1' }]);
    expect(findManyByPageAndTransclusion.mock.calls[0][1]).toBe('w1');
    expect(findManyByIds.mock.calls[0][0]).toEqual(['ok']);
  });
});
