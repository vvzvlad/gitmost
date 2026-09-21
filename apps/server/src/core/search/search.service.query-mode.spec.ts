import { SearchService } from './search.service';

/**
 * Unit coverage for SearchService.searchPage SCOPE-SECURITY early returns — the
 * branches that must yield an empty result WITHOUT ever touching the DB, so they
 * can leak nothing. The happy-path scope SQL (explicit space / member spaces /
 * share id set) is covered against the real schema in the integration spec.
 *
 * Every case here returns BEFORE the raw-SQL candidate query runs, so a bare `db`
 * stub (never called) is enough — a call to it would itself be a failure signal.
 */
describe('SearchService.searchPage — scope-security early returns', () => {
  function makeService(opts?: {
    share?: any;
    isRestricted?: boolean;
    memberSpaceIds?: string[];
  }) {
    // A db that THROWS if touched — these branches must not reach SQL.
    const db: any = new Proxy(
      {},
      {
        get() {
          throw new Error('db must not be touched on an empty-scope branch');
        },
      },
    );

    const pageRepo = {
      getPageAndDescendantsExcludingRestricted: jest.fn(),
      getPageAndDescendants: jest.fn(),
    };
    const shareRepo = {
      findById: jest.fn().mockResolvedValue(opts?.share ?? null),
    };
    const spaceMemberRepo = {
      getUserSpaceIds: jest.fn().mockResolvedValue(opts?.memberSpaceIds ?? []),
    };
    const pagePermissionRepo = {
      hasRestrictedAncestor: jest
        .fn()
        .mockResolvedValue(opts?.isRestricted ?? false),
      filterAccessiblePageIds: jest.fn(),
    };

    const service = new SearchService(
      db as any,
      pageRepo as any,
      shareRepo as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
      { vectorCandidateArm: jest.fn() } as any,
      // #530/#599 semantic path off for these query-mode unit tests: the query-embed
      // funnel throws, so the service degrades to the byte-identical lexical path.
      {
        embedQueryForActiveGeneration: jest
          .fn()
          .mockRejectedValue(new Error('no embed')),
      } as any,
    );
    return { service, pageRepo, shareRepo, spaceMemberRepo, pagePermissionRepo };
  }

  it('returns total:0 for a blank query WITHOUT touching the DB or any repo', async () => {
    const { service, shareRepo, spaceMemberRepo } = makeService();
    const result = await service.searchPage(
      { query: '' } as any,
      { userId: 'user-1', workspaceId: 'ws-1' },
    );
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(shareRepo.findById).not.toHaveBeenCalled();
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  it('only-negation short-circuits with reason "only-negation", never scanning', async () => {
    const { service, spaceMemberRepo } = makeService();
    const result = await service.searchPage(
      { query: '-архив' } as any,
      { userId: 'user-1', workspaceId: 'ws-1' },
    );
    expect(result.total).toBe(0);
    expect(result.query.parsed.reason).toBe('only-negation');
    // Never resolves scope (returns before) — no expensive NOT-only scan.
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  it('returns empty when the share belongs to a DIFFERENT workspace (no leak)', async () => {
    const { service, shareRepo, pagePermissionRepo } = makeService({
      share: { id: 's1', pageId: 'p1', workspaceId: 'OTHER', includeSubPages: false },
    });
    const result = await service.searchPage(
      { query: 'plan', shareId: 's1' } as any,
      { workspaceId: 'ws-1' },
    );
    expect(shareRepo.findById).toHaveBeenCalledWith('s1');
    expect(result.items).toEqual([]);
    // Workspace mismatch short-circuits before restricted-ancestor / enumeration.
    expect(pagePermissionRepo.hasRestrictedAncestor).not.toHaveBeenCalled();
  });

  it('returns empty when the shared page has a restricted ancestor', async () => {
    const { service, pagePermissionRepo, pageRepo } = makeService({
      share: { id: 's1', pageId: 'p1', workspaceId: 'ws-1', includeSubPages: true },
      isRestricted: true,
    });
    const result = await service.searchPage(
      { query: 'plan', shareId: 's1' } as any,
      { workspaceId: 'ws-1' },
    );
    expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalledWith('p1');
    expect(result.items).toEqual([]);
    expect(
      pageRepo.getPageAndDescendantsExcludingRestricted,
    ).not.toHaveBeenCalled();
  });

  it('returns empty with no userId, no spaceId and no shareId', async () => {
    const { service, shareRepo } = makeService();
    const result = await service.searchPage(
      { query: 'plan' } as any,
      { workspaceId: 'ws-1' },
    );
    expect(result.items).toEqual([]);
    expect(shareRepo.findById).not.toHaveBeenCalled();
  });

  it('an authenticated user with NO member spaces gets an empty result', async () => {
    const { service, spaceMemberRepo } = makeService({ memberSpaceIds: [] });
    const result = await service.searchPage(
      { query: 'plan' } as any,
      { userId: 'user-1', workspaceId: 'ws-1' },
    );
    expect(spaceMemberRepo.getUserSpaceIds).toHaveBeenCalledWith('user-1');
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});
