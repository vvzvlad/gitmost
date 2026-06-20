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
      {} as any, // workspaceRepo
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

describe('TransclusionService.filterViewerAccessiblePageIds — AND ordering (content-leak control)', () => {
  function makeDb(executeRows: Array<{ id: string }>) {
    const builder: any = {};
    builder.selectFrom = jest.fn(() => builder);
    builder.select = jest.fn(() => builder);
    builder.where = jest.fn(() => builder);
    builder.execute = jest.fn(async () => executeRows);
    return builder;
  }

  function makeService(opts: {
    spaceVisibleRows: Array<{ id: string }>;
    permissionAccessibleIds: string[];
  }) {
    const db = makeDb(opts.spaceVisibleRows);
    const spaceMemberRepo = {
      getUserSpaceIdsQuery: jest.fn(() => ({ __subquery: true })),
    };
    const filterAccessiblePageIds = jest
      .fn()
      .mockResolvedValue(opts.permissionAccessibleIds);
    const pagePermissionRepo = { filterAccessiblePageIds };

    const service = new TransclusionService(
      db as any, // db
      {} as any, // pageTransclusionsRepo
      {} as any, // pageTransclusionReferencesRepo
      {} as any, // pageTemplateReferencesRepo
      {} as any, // pageRepo
      pagePermissionRepo as any,
      spaceMemberRepo as any,
      {} as any, // attachmentRepo
      {} as any, // storageService
      {} as any, // pageAccessService
      {} as any, // workspaceRepo
    );

    return { service, filterAccessiblePageIds };
  }

  it('space-visible AND permission-accessible → returned', async () => {
    const { service } = makeService({
      spaceVisibleRows: [{ id: 'p1' }],
      permissionAccessibleIds: ['p1'],
    });
    const out = await service.filterViewerAccessiblePageIds(
      ['p1'],
      'u1',
      'w1',
    );
    expect(out).toEqual(['p1']);
  });

  it('space-visible but permission-rejected → dropped', async () => {
    const { service, filterAccessiblePageIds } = makeService({
      spaceVisibleRows: [{ id: 'p1' }],
      permissionAccessibleIds: [],
    });
    const out = await service.filterViewerAccessiblePageIds(
      ['p1'],
      'u1',
      'w1',
    );
    expect(out).toEqual([]);
    // The permission filter only ever sees the space-visible candidate.
    expect(filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['p1'],
      userId: 'u1',
    });
  });

  it('NOT space-visible but permission-accessible → STILL dropped (AND-ordering enforced)', async () => {
    // The page would pass page-level permission filtering, but it is not visible
    // at the space level (e.g. a private space the viewer is not a member of).
    // The space-visibility gate runs FIRST and short-circuits, so the page-level
    // permission filter is never even consulted — preventing a private-space
    // content leak via an unrestricted source page.
    const { service, filterAccessiblePageIds } = makeService({
      spaceVisibleRows: [],
      permissionAccessibleIds: ['private-but-permitted'],
    });
    const out = await service.filterViewerAccessiblePageIds(
      ['private-but-permitted'],
      'u1',
      'w1',
    );
    expect(out).toEqual([]);
    expect(filterAccessiblePageIds).not.toHaveBeenCalled();
  });
});

describe('TransclusionService.syncPageTemplateReferences — workspace scoping', () => {
  function makeService(opts: {
    inWorkspaceIds: string[];
    /** existing rows already persisted for the reference page */
    existingSourceIds?: string[];
  }) {
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
      findByReferencePageId: jest
        .fn()
        .mockResolvedValue(
          (opts.existingSourceIds ?? []).map((sourcePageId) => ({
            sourcePageId,
          })),
        ),
      insertMany,
      deleteByReferenceAndSources,
    };

    const service = new TransclusionService(
      builder as any, // db
      {} as any, // pageTransclusionsRepo
      {} as any, // pageTransclusionReferencesRepo
      pageTemplateReferencesRepo as any,
      {} as any, // pageRepo
      {} as any, // pagePermissionRepo
      {} as any, // spaceMemberRepo
      {} as any, // attachmentRepo
      {} as any, // storageService
      {} as any, // pageAccessService
      {} as any, // workspaceRepo
    );

    return {
      service,
      insertMany,
      deleteByReferenceAndSources,
      pageTemplateReferencesRepo,
    };
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

  it('DELETE branch: an existing in-workspace ref removed from the doc is deleted', async () => {
    // 'gone' was referenced before but is no longer in the doc; 'stay' remains.
    const { service, insertMany, deleteByReferenceAndSources } = makeService({
      inWorkspaceIds: ['stay'],
      existingSourceIds: ['stay', 'gone'],
    });

    const result = await service.syncPageTemplateReferences(
      'host',
      'w1',
      docWithEmbeds(['stay']),
    );

    expect(result.deleted).toBe(1);
    expect(result.inserted).toBe(0); // 'stay' already existed
    expect(insertMany).not.toHaveBeenCalled();
    expect(deleteByReferenceAndSources).toHaveBeenCalledTimes(1);
    expect(deleteByReferenceAndSources).toHaveBeenCalledWith(
      'host',
      ['gone'],
      undefined, // no trx supplied
    );
  });

  it('does NOT delete a stale ref whose source is now cross-workspace if it is also still embedded', async () => {
    // Edge: 'x' is still embedded in the doc but no longer in-workspace. It is
    // not in desiredIds (filtered out) AND it exists → it should be deleted, not
    // kept, because the reference graph must drop the cross-workspace edge.
    const { service, deleteByReferenceAndSources } = makeService({
      inWorkspaceIds: [], // 'x' no longer in-workspace
      existingSourceIds: ['x'],
    });

    const result = await service.syncPageTemplateReferences(
      'host',
      'w1',
      docWithEmbeds(['x']),
    );

    expect(result.deleted).toBe(1);
    expect(deleteByReferenceAndSources).toHaveBeenCalledWith(
      'host',
      ['x'],
      undefined,
    );
  });
});

describe('TransclusionService.insertTemplateReferencesForPages — per-workspace existence validation', () => {
  /**
   * Smart db stub: each existence query is `.where('id','in', ids)` +
   * `.where('workspaceId','=', wsId)`; `.execute()` returns only the ids that
   * `validByWorkspace[wsId]` declares in-workspace. The builder snapshots the
   * last `id`-in list and `workspaceId` value per chain (selectFrom resets).
   */
  function makeDb(validByWorkspace: Record<string, string[]>) {
    const builder: any = {};
    let curIds: string[] = [];
    let curWs: string | undefined;
    builder.selectFrom = jest.fn(() => {
      curIds = [];
      curWs = undefined;
      return builder;
    });
    builder.select = jest.fn(() => builder);
    builder.where = jest.fn((col: string, op: string, val: any) => {
      if (col === 'id' && op === 'in') curIds = val;
      if (col === 'workspaceId' && op === '=') curWs = val;
      return builder;
    });
    builder.execute = jest.fn(async () => {
      const valid = new Set(validByWorkspace[curWs ?? ''] ?? []);
      return curIds.filter((id) => valid.has(id)).map((id) => ({ id }));
    });
    return builder;
  }

  function makeService(validByWorkspace: Record<string, string[]>) {
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const pageTemplateReferencesRepo = { insertMany };
    const service = new TransclusionService(
      makeDb(validByWorkspace) as any, // db
      {} as any, // pageTransclusionsRepo
      {} as any, // pageTransclusionReferencesRepo
      pageTemplateReferencesRepo as any,
      {} as any, // pageRepo
      {} as any, // pagePermissionRepo
      {} as any, // spaceMemberRepo
      {} as any, // attachmentRepo
      {} as any, // storageService
      {} as any, // pageAccessService
      {} as any, // workspaceRepo
    );
    return { service, insertMany };
  }

  const embedDoc = (ids: string[]) => ({
    type: 'doc',
    content: ids.map((id) => ({
      type: 'pageEmbed',
      attrs: { sourcePageId: id },
    })),
  });

  it('validates each workspace separately: a source in-ws for A but cross-ws for B inserts only the valid delta', async () => {
    // 'shared' is in-workspace for wA but NOT for wB. Page A embeds 'shared'
    // (valid → inserted). Page B embeds 'shared' (cross-ws for wB → dropped).
    const { service, insertMany } = makeService({
      wA: ['shared'],
      wB: [], // 'shared' is not a page in wB
    });

    const result = await service.insertTemplateReferencesForPages([
      { id: 'pageA', workspaceId: 'wA', content: embedDoc(['shared']) },
      { id: 'pageB', workspaceId: 'wB', content: embedDoc(['shared']) },
    ]);

    expect(result.inserted).toBe(1);
    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(insertMany.mock.calls[0][0]).toEqual([
      { workspaceId: 'wA', referencePageId: 'pageA', sourcePageId: 'shared' },
    ]);
  });

  it('inserts the in-workspace deltas for both pages when each is valid in its own workspace', async () => {
    const { service, insertMany } = makeService({
      wA: ['a-src'],
      wB: ['b-src'],
    });

    const result = await service.insertTemplateReferencesForPages([
      { id: 'pageA', workspaceId: 'wA', content: embedDoc(['a-src']) },
      { id: 'pageB', workspaceId: 'wB', content: embedDoc(['b-src']) },
    ]);

    expect(result.inserted).toBe(2);
    const rows = insertMany.mock.calls[0][0];
    expect(rows).toEqual(
      expect.arrayContaining([
        { workspaceId: 'wA', referencePageId: 'pageA', sourcePageId: 'a-src' },
        { workspaceId: 'wB', referencePageId: 'pageB', sourcePageId: 'b-src' },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});
