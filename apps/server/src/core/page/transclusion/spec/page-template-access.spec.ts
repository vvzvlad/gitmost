import { TransclusionService } from '../transclusion.service';

/**
 * Exercises the REAL security core of the whole-page template feature rather
 * than mocking it away:
 *  - `filterViewerAccessiblePageIds` runs for real (space-visibility query +
 *    page-permission filter are stubbed, but the branching/AND-ing is real), so
 *    `lookupTemplate` actually maps no_access vs content based on it.
 *  - the workspace scoping of `page_template_references` writes is verified to
 *    drop cross-workspace source ids before they are persisted.
 */
describe('TransclusionService — template access core (real filter)', () => {
  /**
   * Build a chainable kysely `db` stub. `selectFrom(...).select(...).where(...)`
   * all return the same builder; `.execute()` resolves the supplied rows. The
   * `where('spaceId','in', getUserSpaceIdsQuery(...))` sub-query argument is
   * ignored — space visibility is decided by what `execute()` returns.
   */
  function makeDb(executeRows: Array<{ id: string }>) {
    const builder: any = {};
    builder.selectFrom = jest.fn(() => builder);
    builder.select = jest.fn(() => builder);
    builder.where = jest.fn(() => builder);
    builder.execute = jest.fn(async () => executeRows);
    return builder;
  }

  function makeService(opts: {
    /** rows returned by the space-visibility query (workspace + space scoped) */
    spaceVisibleRows: Array<{ id: string }>;
    /** ids that survive page-level permission filtering */
    permissionAccessibleIds: string[];
    pages?: Array<{
      id: string;
      slugId?: string;
      title: string | null;
      icon: string | null;
      content: unknown;
      updatedAt: Date;
    }>;
  }) {
    const db = makeDb(opts.spaceVisibleRows);

    const spaceMemberRepo = {
      // The real code only passes this query object into `.where(...)`; our db
      // stub ignores it, so a sentinel is fine.
      getUserSpaceIdsQuery: jest.fn(() => ({ __subquery: true })),
    };

    const pagePermissionRepo = {
      filterAccessiblePageIds: jest
        .fn()
        .mockResolvedValue(opts.permissionAccessibleIds),
    };

    const pageRepo = {
      findManyByIds: jest.fn().mockResolvedValue(opts.pages ?? []),
    };

    const service = new TransclusionService(
      db as any,
      {} as any, // pageTransclusionsRepo
      {} as any, // pageTransclusionReferencesRepo
      {} as any, // pageTemplateReferencesRepo
      pageRepo as any,
      pagePermissionRepo as any,
      spaceMemberRepo as any,
      {} as any, // attachmentRepo
      {} as any, // storageService
      {} as any, // pageAccessService
    );

    return { service, db, pageRepo, spaceMemberRepo, pagePermissionRepo };
  }

  const now = new Date('2026-06-20T00:00:00.000Z');

  it('returns no_access when the viewer fails the page-permission filter (real filter runs)', async () => {
    // Space-visible, but page-permission filter rejects it.
    const { service, pagePermissionRepo } = makeService({
      spaceVisibleRows: [{ id: 'p1' }],
      permissionAccessibleIds: [],
    });

    const { items } = await service.lookupTemplate(['p1'], 'u1', 'w1');
    expect(items).toEqual([{ sourcePageId: 'p1', status: 'no_access' }]);
    // proves the real filter executed and consulted page permissions
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['p1'],
      userId: 'u1',
    });
  });

  it('returns no_access for a cross-workspace id (space-visibility query excludes it)', async () => {
    // The workspace/space-scoped query returns nothing → permission filter is
    // never reached and the id is not returned as accessible.
    const { service, pagePermissionRepo } = makeService({
      spaceVisibleRows: [],
      permissionAccessibleIds: ['cross-ws'],
    });

    const { items } = await service.lookupTemplate(['cross-ws'], 'u1', 'w1');
    expect(items).toEqual([{ sourcePageId: 'cross-ws', status: 'no_access' }]);
    // short-circuited before page-permission filtering
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
  });

  it('returns content with comment marks stripped for an accessible page', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'hello',
              marks: [{ type: 'comment', attrs: { commentId: 'c1' } }],
            },
          ],
        },
      ],
    };

    const { service } = makeService({
      spaceVisibleRows: [{ id: 'p1' }],
      permissionAccessibleIds: ['p1'],
      pages: [
        {
          id: 'p1',
          slugId: 's1',
          title: 'Tmpl',
          icon: '📄',
          content,
          updatedAt: now,
        },
      ],
    });

    const { items } = await service.lookupTemplate(['p1'], 'u1', 'w1');
    const item = items[0] as any;
    expect(item.status).toBeUndefined();
    expect(item.title).toBe('Tmpl');
    const json = JSON.stringify(item.content);
    expect(json).not.toContain('comment');
    expect(json).toContain('hello');
  });

  it('mixes accessible and inaccessible ids in one batch positionally', async () => {
    const { service } = makeService({
      spaceVisibleRows: [{ id: 'ok' }, { id: 'denied' }],
      permissionAccessibleIds: ['ok'],
      pages: [
        {
          id: 'ok',
          slugId: 's',
          title: 'A',
          icon: null,
          content: { type: 'doc', content: [] },
          updatedAt: now,
        },
      ],
    });

    const { items } = await service.lookupTemplate(
      ['denied', 'ok', 'cross'],
      'u1',
      'w1',
    );
    expect((items[0] as any).status).toBe('no_access'); // space-visible but no perm
    expect((items[1] as any).status).toBeUndefined(); // accessible
    expect((items[2] as any).status).toBe('no_access'); // not space-visible
  });

  it('honours the DTO-level ≤50 cap by deduping ids passed to the filter', async () => {
    // The DTO enforces ArrayMaxSize(50); the service dedupes before filtering.
    const ids = ['a', 'a', 'b'];
    const { service, db } = makeService({
      spaceVisibleRows: [],
      permissionAccessibleIds: [],
    });

    await service.lookupTemplate(ids, 'u1', 'w1');
    // db.where('id','in', <uniqueIds>) — verify the in-clause got deduped ids
    const inCall = db.where.mock.calls.find((c: any[]) => c[0] === 'id');
    expect(inCall?.[2]).toEqual(['a', 'b']);
  });
});

describe('TransclusionService.syncPageTemplateReferences — workspace scoping', () => {
  function makeService(opts: { inWorkspaceIds: string[] }) {
    // db stub: the in-workspace existence query returns only allowed ids.
    const builder: any = {};
    builder.selectFrom = jest.fn(() => builder);
    builder.select = jest.fn(() => builder);
    builder.where = jest.fn(() => builder);
    builder.execute = jest.fn(async () =>
      opts.inWorkspaceIds.map((id) => ({ id })),
    );

    const insertMany = jest.fn().mockResolvedValue(undefined);
    const deleteByReferenceAndSources = jest.fn().mockResolvedValue(undefined);
    const pageTemplateReferencesRepo = {
      findByReferencePageId: jest.fn().mockResolvedValue([]),
      insertMany,
      deleteByReferenceAndSources,
    };

    const service = new TransclusionService(
      builder as any,
      {} as any,
      {} as any,
      pageTemplateReferencesRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    return { service, insertMany, pageTemplateReferencesRepo };
  }

  function docWithEmbeds(sourceIds: string[]) {
    return {
      type: 'doc',
      content: sourceIds.map((id) => ({
        type: 'pageEmbed',
        attrs: { sourcePageId: id },
      })),
    };
  }

  it('does NOT write a row for a cross-workspace sourcePageId, but writes the in-workspace one', async () => {
    const { service, insertMany } = makeService({
      // only the in-workspace id survives the existence query
      inWorkspaceIds: ['in-ws'],
    });

    const result = await service.syncPageTemplateReferences(
      'host',
      'w1',
      docWithEmbeds(['in-ws', 'cross-ws']),
    );

    expect(result.inserted).toBe(1);
    expect(insertMany).toHaveBeenCalledTimes(1);
    const rows = insertMany.mock.calls[0][0];
    expect(rows).toEqual([
      { workspaceId: 'w1', referencePageId: 'host', sourcePageId: 'in-ws' },
    ]);
  });

  it('inserts nothing when every embed points at a cross-workspace source', async () => {
    const { service, insertMany } = makeService({ inWorkspaceIds: [] });

    const result = await service.syncPageTemplateReferences(
      'host',
      'w1',
      docWithEmbeds(['cross-a', 'cross-b']),
    );

    expect(result.inserted).toBe(0);
    expect(insertMany).not.toHaveBeenCalled();
  });
});
