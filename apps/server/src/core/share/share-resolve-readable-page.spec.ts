import { ShareService } from './share.service';

/**
 * Focused unit test for ShareService.resolveReadableSharePage — THE single
 * share-access boundary that every public-share read path funnels through.
 *
 * The security invariant, in one place: a (shareId, pageId) pair resolves to a
 * usable page ONLY when it is reachable in this workspace's share graph, is the
 * SAME share the caller asked for, is a live (non-deleted) page, and has NO
 * restricted ancestor. ANY failure must return null (no exception, no leak of
 * which check failed). These cases pin the boundary directly so it cannot drift
 * even if a downstream call-site is refactored.
 *
 * getShareForPage itself is a raw recursive-CTE db query, so it is spied; every
 * other collaborator is a plain mock. The restricted-ancestor gate is exercised
 * for real (it is the gate getShareForPage does NOT itself perform).
 */
const WS = 'ws-1';
const SHARE = 'SHARE-A';
const PAGE = 'page-1';

function buildService(over: {
  resolvedShare?: unknown;
  page?: unknown;
  restricted?: boolean;
  // #370 Stage B — the latest manual page-history row returned for the approved
  // swap. `undefined` (the default) means the repo finds no manual version.
  manualHistory?: unknown;
} = {}) {
  const pageRepo = {
    findById: jest.fn(async () =>
      'page' in over
        ? over.page
        : { id: PAGE, deletedAt: null, content: {} },
    ),
  };
  const pagePermissionRepo = {
    hasRestrictedAncestor: jest.fn(async () => over.restricted ?? false),
  };
  const pageHistoryRepo = {
    findLatestByPageIdAndKind: jest.fn(async () => over.manualHistory ?? undefined),
  };

  const service = new ShareService(
    {} as any, // shareRepo (unused on this path)
    pageRepo as any,
    pagePermissionRepo as any,
    {} as any, // db (getShareForPage is spied)
    {} as any, // tokenService (unused)
    {} as any, // transclusionService (unused)
    {} as any, // workspaceRepo (unused)
    pageHistoryRepo as any,
  );

  jest
    .spyOn(service, 'getShareForPage')
    .mockResolvedValue(
      ('resolvedShare' in over
        ? over.resolvedShare
        : { id: SHARE, pageId: PAGE, spaceId: 'space-1' }) as any,
    );

  return { service, pageRepo, pagePermissionRepo, pageHistoryRepo };
}

describe('ShareService.resolveReadableSharePage (the share-access boundary)', () => {
  it('resolves { share, page } for a readable, in-share, live, unrestricted page', async () => {
    const page = { id: PAGE, deletedAt: null, content: { type: 'doc' } };
    const { service, pageRepo, pagePermissionRepo } = buildService({ page });

    const out = await service.resolveReadableSharePage(SHARE, PAGE, WS);

    expect(out).not.toBeNull();
    expect(out!.share.id).toBe(SHARE);
    expect(out!.page).toBe(page);
    // The restricted-ancestor gate ran on the resolved page id.
    expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalledWith(PAGE);
    // Content is fetched (callers sanitize it); creator off by default.
    expect(pageRepo.findById).toHaveBeenCalledWith(PAGE, {
      includeContent: true,
      includeCreator: false,
    });
  });

  it('null when the page is not reachable in the share graph (getShareForPage => undefined)', async () => {
    const { service, pageRepo } = buildService({ resolvedShare: undefined });
    expect(await service.resolveReadableSharePage(SHARE, PAGE, WS)).toBeNull();
    // Short-circuits before fetching the page.
    expect(pageRepo.findById).not.toHaveBeenCalled();
  });

  it('null on a cross-share id swap: page resolves to a DIFFERENT share than requested', async () => {
    const { service, pageRepo } = buildService({
      resolvedShare: { id: 'OTHER-SHARE', pageId: PAGE, spaceId: 'space-1' },
    });
    expect(await service.resolveReadableSharePage(SHARE, PAGE, WS)).toBeNull();
    expect(pageRepo.findById).not.toHaveBeenCalled();
  });

  it('null for a soft-deleted page (deletedAt set), without consulting the restricted gate', async () => {
    const { service, pagePermissionRepo } = buildService({
      page: { id: PAGE, deletedAt: new Date(), content: {} },
    });
    expect(await service.resolveReadableSharePage(SHARE, PAGE, WS)).toBeNull();
    expect(pagePermissionRepo.hasRestrictedAncestor).not.toHaveBeenCalled();
  });

  it('null when the page row is missing (findById => null)', async () => {
    const { service } = buildService({ page: null });
    expect(await service.resolveReadableSharePage(SHARE, PAGE, WS)).toBeNull();
  });

  it('null for a restricted descendant (hidden from the public view)', async () => {
    const { service } = buildService({
      page: { id: PAGE, deletedAt: null, content: {} },
      restricted: true,
    });
    expect(await service.resolveReadableSharePage(SHARE, PAGE, WS)).toBeNull();
  });

  it('skips the share-id match when shareId is null (getSharedPage path: share resolved FROM the page)', async () => {
    const { service } = buildService({
      // The page resolves to whatever share owns it; there is no independent
      // requested shareId to cross-check.
      resolvedShare: { id: 'ANY-SHARE', pageId: PAGE, spaceId: 'space-1' },
      page: { id: PAGE, deletedAt: null, content: {} },
    });
    const out = await service.resolveReadableSharePage(null, PAGE, WS);
    expect(out).not.toBeNull();
    expect(out!.share.id).toBe('ANY-SHARE');
  });

  it('passes includeCreator through to the page fetch when requested', async () => {
    const { service, pageRepo } = buildService();
    await service.resolveReadableSharePage(SHARE, PAGE, WS, {
      includeCreator: true,
    });
    expect(pageRepo.findById).toHaveBeenCalledWith(PAGE, {
      includeContent: true,
      includeCreator: true,
    });
  });

  // #370 Stage B — "approved" publication freezes the served content/title to
  // the latest manual page-history version, WITHOUT touching page.id or
  // page.workspaceId (downstream attachment tokens are minted off those, so
  // freezing them would mint tokens for the wrong owner).
  describe('approved publication mode (content freeze)', () => {
    const LIVE_PAGE = {
      id: PAGE,
      workspaceId: WS,
      deletedAt: null,
      title: 'Live draft title',
      content: { type: 'doc', live: true },
    };
    const MANUAL = {
      title: 'Saved version title',
      content: { type: 'doc', saved: true },
    };

    it('swaps content + title to the latest manual version but PRESERVES id + workspaceId', async () => {
      const { service, pageHistoryRepo } = buildService({
        resolvedShare: {
          id: SHARE,
          pageId: PAGE,
          spaceId: 'space-1',
          publishedMode: 'approved',
        },
        page: { ...LIVE_PAGE },
        manualHistory: MANUAL,
      });

      const out = await service.resolveReadableSharePage(SHARE, PAGE, WS);

      expect(out).not.toBeNull();
      // Content + title come from the saved version.
      expect(out!.page.content).toEqual(MANUAL.content);
      expect(out!.page.title).toBe(MANUAL.title);
      // id + workspaceId stay LIVE (attachment-token ownership must not shift).
      expect(out!.page.id).toBe(LIVE_PAGE.id);
      expect(out!.page.workspaceId).toBe(LIVE_PAGE.workspaceId);
      // Resolved against the LIVE page id and the manual tier, with content.
      expect(pageHistoryRepo.findLatestByPageIdAndKind).toHaveBeenCalledWith(
        LIVE_PAGE.id,
        'manual',
        { includeContent: true },
      );
    });

    it('falls back to live content when no manual version exists yet', async () => {
      const { service, pageHistoryRepo } = buildService({
        resolvedShare: {
          id: SHARE,
          pageId: PAGE,
          spaceId: 'space-1',
          publishedMode: 'approved',
        },
        page: { ...LIVE_PAGE },
        // manualHistory omitted → repo returns undefined
      });

      const out = await service.resolveReadableSharePage(SHARE, PAGE, WS);

      expect(out).not.toBeNull();
      expect(out!.page.content).toEqual(LIVE_PAGE.content);
      expect(out!.page.title).toBe(LIVE_PAGE.title);
      expect(pageHistoryRepo.findLatestByPageIdAndKind).toHaveBeenCalled();
    });

    it('does NOT consult page-history for a live share', async () => {
      const { service, pageHistoryRepo } = buildService({
        resolvedShare: {
          id: SHARE,
          pageId: PAGE,
          spaceId: 'space-1',
          publishedMode: 'live',
        },
        page: { ...LIVE_PAGE },
        manualHistory: MANUAL,
      });

      const out = await service.resolveReadableSharePage(SHARE, PAGE, WS);

      expect(out).not.toBeNull();
      expect(out!.page.content).toEqual(LIVE_PAGE.content);
      expect(pageHistoryRepo.findLatestByPageIdAndKind).not.toHaveBeenCalled();
    });
  });
});
