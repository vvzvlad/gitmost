import { TransclusionService } from '../transclusion.service';

/**
 * Edge-case + anti-leak coverage for `lookupTemplate` that the existing
 * `page-template-lookup.spec.ts` (stubbed filter) and `page-template-access.spec.ts`
 * (real filter, happy paths) do not exercise:
 *
 *  1. SECURITY anti-leak: when comment-mark stripping THROWS, the item must come
 *     back as `not_found` and NEVER carry raw content (the source's comment marks
 *     could otherwise leak to a viewer). See the `catch` branch in `lookupTemplate`.
 *  2. A soft-deleted source page resolved through the REAL
 *     `filterViewerAccessiblePageIds` (space-visibility query filters `deletedAt`),
 *     asserting it maps to `not_found`/`no_access` rather than content.
 */
describe('TransclusionService.lookupTemplate — anti-leak catch branch', () => {
  const now = new Date('2026-06-20T00:00:00.000Z');

  function makeService(opts: {
    accessibleIds: string[];
    pages: Array<{
      id: string;
      slugId?: string;
      title: string | null;
      icon: string | null;
      content: unknown;
      updatedAt: Date;
    }>;
  }) {
    const pageRepo = {
      findManyByIds: jest.fn().mockResolvedValue(opts.pages),
    };

    const service = new TransclusionService(
      {} as any, // db
      {} as any, // pageTransclusionsRepo
      {} as any, // pageTransclusionReferencesRepo
      {} as any, // pageTemplateReferencesRepo
      pageRepo as any,
      {} as any, // pagePermissionRepo
      {} as any, // spaceMemberRepo
      {} as any, // attachmentRepo
      {} as any, // storageService
      {} as any, // pageAccessService
      {} as any, // workspaceRepo
    );

    // Stub the access decision; we are testing the content-prep stage, not access.
    jest
      .spyOn(service, 'filterViewerAccessiblePageIds')
      .mockResolvedValue(opts.accessibleIds);

    return { service, pageRepo };
  }

  it('returns not_found (NOT raw content) when comment-mark stripping throws', async () => {
    // An accessible, present page whose stored content is structurally invalid PM:
    // a `text` node without a `text` field. `jsonToNode` (called inside the try
    // block) throws "Invalid text node in JSON" on this, which exercises the
    // service's catch -> not_found anti-leak guard. This uses a REAL malformed
    // input (no module mocking) so the test stays faithful to production behaviour.
    const malformedContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              // Missing `text` — Node.fromJSON rejects this and jsonToNode rethrows.
              type: 'text',
              marks: [{ type: 'comment', attrs: { commentId: 'leak-me' } }],
            },
          ],
        },
      ],
    };

    const { service } = makeService({
      accessibleIds: ['p1'],
      pages: [
        {
          id: 'p1',
          slugId: 's1',
          title: 'Secret',
          icon: '📄',
          content: malformedContent,
          updatedAt: now,
        },
      ],
    });

    // Silence the expected error log so the suite output stays clean.
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

    const { items } = await service.lookupTemplate(['p1'], 'u1', 'w1');

    expect(items).toHaveLength(1);
    const item = items[0] as any;

    // Must degrade to not_found...
    expect(item.status).toBe('not_found');
    expect(item.sourcePageId).toBe('p1');

    // ...and must NOT leak ANY content/metadata of the source page.
    expect(item).not.toHaveProperty('content');
    expect(item).not.toHaveProperty('title');
    expect(item).not.toHaveProperty('icon');
    expect(item).not.toHaveProperty('slugId');
    expect(item).not.toHaveProperty('sourceUpdatedAt');

    // Hard guarantee: the would-be-leaked comment mark appears nowhere in output.
    expect(JSON.stringify(item)).not.toContain('leak-me');
    expect(JSON.stringify(item)).not.toContain('comment');
  });
});

describe('TransclusionService.lookupTemplate — soft-deleted source via real filter', () => {
  const now = new Date('2026-06-20T00:00:00.000Z');

  /**
   * Chainable kysely `db` stub mirroring `page-template-access.spec.ts`. The
   * space-visibility query in `filterViewerAccessiblePageIds` filters
   * `where('deletedAt','is',null)`; a soft-deleted page is therefore absent from
   * the rows we resolve here, so the REAL filter is what drops it.
   */
  function makeDb(executeRows: Array<{ id: string }>) {
    const builder: any = {};
    builder.selectFrom = jest.fn(() => builder);
    builder.select = jest.fn(() => builder);
    builder.where = jest.fn(() => builder);
    builder.execute = jest.fn(async () => executeRows);
    return builder;
  }

  it('resolves a soft-deleted source to not_found/no_access through the REAL filter', async () => {
    // The page IS soft-deleted, so the space-visibility query returns no rows for
    // it (deletedAt filter). We let the real filter run end-to-end.
    const db = makeDb([]); // soft-deleted -> excluded by the deletedAt='is null' clause

    const spaceMemberRepo = {
      getUserSpaceIdsQuery: jest.fn(() => ({ __subquery: true })),
    };
    const pagePermissionRepo = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue([]),
    };
    const pageRepo = {
      // Even if it were queried, the page is gone; assert via the filter instead.
      findManyByIds: jest.fn().mockResolvedValue([]),
    };

    const service = new TransclusionService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
      pageRepo as any,
      pagePermissionRepo as any,
      spaceMemberRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const { items } = await service.lookupTemplate(['deleted-src'], 'u1', 'w1');

    // Soft-deleted source must never resolve to content.
    expect(items).toEqual([
      { sourcePageId: 'deleted-src', status: 'no_access' },
    ]);
    const item = items[0] as any;
    expect(item).not.toHaveProperty('content');

    // The real filter short-circuited before page-permission filtering because
    // the deletedAt-filtered space-visibility query returned nothing.
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
    // And the verb on the db builder included a deletedAt 'is null' guard, proving
    // the real path (not a stub) excluded the soft-deleted page.
    const deletedAtCall = db.where.mock.calls.find(
      (c: any[]) => c[0] === 'deletedAt',
    );
    expect(deletedAtCall).toEqual(['deletedAt', 'is', null]);
  });
});
