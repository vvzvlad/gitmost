import { SearchService } from './search.service';

/**
 * Coverage for SearchService.searchPage query-mode selection (search.service.ts
 * @25). searchPage chooses HOW the result set is scoped — by explicit space, by
 * the authenticated user's member spaces, or by a share — and must return an
 * empty set (without leaking data) for every disallowed combination.
 *
 * The kysely query builder is mocked with the same chainable pattern as the
 * existing search.service.spec.ts: every builder method returns the same builder
 * and `.execute()` resolves the supplied rows. Each `.where(...)` call is
 * recorded so we can assert exactly which scope clause was applied — that is the
 * mutation-resistant signal that distinguishes one query mode from another.
 *
 * These specs catch cross-space / cross-workspace search leakage and
 * share-scope bypass (data exposure).
 */
describe('SearchService.searchPage — query-mode selection', () => {
  // Build a chainable selectFrom('pages') builder that records its calls. The
  // builder is returned from `db.selectFrom` and is the single object every
  // chained call mutates/returns, mirroring the existing spec's pattern.
  function makeBuilder(rows: Array<{ id: string; highlight?: string }>) {
    const builder: any = {};
    builder.select = jest.fn(() => builder);
    builder.where = jest.fn(() => builder);
    builder.$if = jest.fn(() => builder);
    builder.orderBy = jest.fn(() => builder);
    builder.limit = jest.fn(() => builder);
    builder.offset = jest.fn(() => builder);
    builder.execute = jest.fn(async () => rows);
    return builder;
  }

  function makeService(opts?: {
    rows?: Array<{ id: string; highlight?: string }>;
    share?: any;
    isRestricted?: boolean;
    descendants?: Array<{ id: string }>;
  }) {
    const builder = makeBuilder(opts?.rows ?? []);

    const db: any = {
      selectFrom: jest.fn(() => builder),
    };

    // `getUserSpaceIdsQuery` returns a sub-query object that searchPage passes
    // straight into `.where('spaceId', 'in', <subquery>)`. A sentinel is enough
    // to assert the user-scoped branch was taken.
    const userSpaceIdsQuery = { __userSpaceIdsQuery: true };

    const pageRepo = {
      // `.select((eb) => this.pageRepo.withSpace(eb))` — value ignored by stub.
      withSpace: jest.fn(() => ({ __withSpace: true })),
      getPageAndDescendantsExcludingRestricted: jest
        .fn()
        .mockResolvedValue(opts?.descendants ?? []),
    };
    const shareRepo = {
      findById: jest.fn().mockResolvedValue(opts?.share ?? null),
    };
    const spaceMemberRepo = {
      getUserSpaceIdsQuery: jest.fn(() => userSpaceIdsQuery),
    };
    const pagePermissionRepo = {
      hasRestrictedAncestor: jest
        .fn()
        .mockResolvedValue(opts?.isRestricted ?? false),
      // Let everything through page-level permission filtering by default.
      filterAccessiblePageIds: jest
        .fn()
        .mockImplementation(async ({ pageIds }: { pageIds: string[] }) => pageIds),
    };

    const service = new SearchService(
      db as any,
      pageRepo as any,
      shareRepo as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
    );

    return {
      service,
      db,
      builder,
      pageRepo,
      shareRepo,
      spaceMemberRepo,
      pagePermissionRepo,
      userSpaceIdsQuery,
    };
  }

  const whereCallFor = (builder: any, column: any) =>
    builder.where.mock.calls.find((c: any[]) => c[0] === column);

  it('returns {items:[]} for a blank query WITHOUT touching the DB', async () => {
    const { service, db } = makeService();

    const result = await service.searchPage(
      { query: '' } as any,
      { userId: 'user-1', workspaceId: 'ws-1' },
    );

    expect(result).toEqual({ items: [] });
    // Blank query is rejected before any query builder is constructed.
    expect(db.selectFrom).not.toHaveBeenCalled();
  });

  it('scopes to the explicit spaceId branch', async () => {
    const { service, builder, db, spaceMemberRepo, shareRepo } = makeService({
      rows: [{ id: 'p-1' }],
    });

    const result = await service.searchPage(
      { query: 'plan', spaceId: 'space-42' } as any,
      { userId: 'user-1', workspaceId: 'ws-1' },
    );

    expect(db.selectFrom).toHaveBeenCalledWith('pages');
    // The explicit-space branch adds exactly `.where('spaceId', '=', 'space-42')`.
    expect(whereCallFor(builder, 'spaceId')).toEqual([
      'spaceId',
      '=',
      'space-42',
    ]);
    // It must NOT fall through to the user-member-spaces or share branch.
    expect(spaceMemberRepo.getUserSpaceIdsQuery).not.toHaveBeenCalled();
    expect(shareRepo.findById).not.toHaveBeenCalled();
    expect(result.items.map((i: any) => i.id)).toEqual(['p-1']);
  });

  it('scopes an authenticated user WITHOUT spaceId to their member spaces', async () => {
    const { service, builder, spaceMemberRepo, userSpaceIdsQuery, shareRepo } =
      makeService({ rows: [{ id: 'p-9' }] });

    await service.searchPage(
      { query: 'plan' } as any,
      { userId: 'user-7', workspaceId: 'ws-1' },
    );

    // The user-scoped branch resolves the member-spaces sub-query for that user
    // and restricts both spaceId (to that sub-query) and workspaceId.
    expect(spaceMemberRepo.getUserSpaceIdsQuery).toHaveBeenCalledWith('user-7');
    expect(whereCallFor(builder, 'spaceId')).toEqual([
      'spaceId',
      'in',
      userSpaceIdsQuery,
    ]);
    expect(whereCallFor(builder, 'workspaceId')).toEqual([
      'workspaceId',
      '=',
      'ws-1',
    ]);
    // Authenticated user path must not consult shares.
    expect(shareRepo.findById).not.toHaveBeenCalled();
  });

  it('returns {items:[]} when the share belongs to a DIFFERENT workspace', async () => {
    const { service, builder, shareRepo, pagePermissionRepo } = makeService({
      share: {
        id: 'share-1',
        pageId: 'page-1',
        workspaceId: 'OTHER-ws',
        includeSubPages: false,
      },
    });

    const result = await service.searchPage(
      { query: 'plan', shareId: 'share-1' } as any,
      { workspaceId: 'ws-1' },
    );

    expect(shareRepo.findById).toHaveBeenCalledWith('share-1');
    expect(result).toEqual({ items: [] });
    // Workspace mismatch short-circuits before any restricted-ancestor / id
    // scoping or DB execution: no leak across workspaces.
    expect(pagePermissionRepo.hasRestrictedAncestor).not.toHaveBeenCalled();
    expect(builder.execute).not.toHaveBeenCalled();
  });

  it('returns {items:[]} when the shared page has a restricted ancestor', async () => {
    const { service, builder, pagePermissionRepo, pageRepo } = makeService({
      share: {
        id: 'share-1',
        pageId: 'page-1',
        workspaceId: 'ws-1',
        includeSubPages: true,
      },
      isRestricted: true,
    });

    const result = await service.searchPage(
      { query: 'plan', shareId: 'share-1' } as any,
      { workspaceId: 'ws-1' },
    );

    expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalledWith(
      'page-1',
    );
    expect(result).toEqual({ items: [] });
    // Restricted ancestor must block before page enumeration and DB execution.
    expect(
      pageRepo.getPageAndDescendantsExcludingRestricted,
    ).not.toHaveBeenCalled();
    expect(builder.execute).not.toHaveBeenCalled();
  });

  it('returns {items:[]} with no userId, no spaceId and no shareId', async () => {
    const { service, builder, shareRepo } = makeService();

    const result = await service.searchPage(
      { query: 'plan' } as any,
      { workspaceId: 'ws-1' },
    );

    expect(result).toEqual({ items: [] });
    // The catch-all else returns empty without scoping/executing or hitting shares.
    expect(shareRepo.findById).not.toHaveBeenCalled();
    expect(builder.execute).not.toHaveBeenCalled();
  });
});
