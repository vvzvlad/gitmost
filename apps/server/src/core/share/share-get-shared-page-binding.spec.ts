import { NotFoundException } from '@nestjs/common';
import { ShareService } from './share.service';

/**
 * Regression for issue #218: public-share content must be bound to the requested
 * shareId. `getSharedPage` resolves the page off its slug, but when the caller
 * supplies a shareId it must be reachable THROUGH that exact share — a forged or
 * mismatched shareId 404s instead of rendering the page off its slug alone. A
 * request with no shareId keeps the legacy slug-capability behavior.
 */
const WS = 'ws-1';
const PAGE_ID = 'page-uuid-1';
const OWN_SHARE_ID = 'share-own';
const OWN_SHARE_KEY = 'ownkey';

function buildService(over: {
  resolvedShare?: any;
  ancestorShare?: any; // returned by shareRepo.findById(requestedShareId)
  ancestorFound?: boolean; // getShareAncestorPage result
} = {}) {
  const resolvedShare = over.resolvedShare ?? {
    id: OWN_SHARE_ID,
    key: OWN_SHARE_KEY,
    includeSubPages: false,
    spaceId: 'space-1',
    workspaceId: WS,
  };
  const page = { id: PAGE_ID, deletedAt: null, content: { type: 'doc' } };

  const shareRepo = {
    findById: jest.fn(async () => over.ancestorShare ?? null),
  };

  const service = new ShareService(
    shareRepo as any,
    {} as any, // pageRepo (resolveReadableSharePage is spied)
    {} as any, // pagePermissionRepo
    {} as any, // db
    {} as any, // tokenService
    {} as any, // transclusionService
    {} as any, // workspaceRepo
  );

  jest
    .spyOn(service, 'resolveReadableSharePage')
    .mockResolvedValue({ share: resolvedShare, page } as any);
  jest
    .spyOn(service, 'updatePublicAttachments')
    .mockResolvedValue(page.content as any);
  jest
    .spyOn(service, 'getShareAncestorPage')
    .mockResolvedValue(over.ancestorFound ? { id: 'anc' } : null);

  return { service, shareRepo, page, resolvedShare };
}

describe('ShareService.getSharedPage — share binding (#218)', () => {
  it('returns the page when no shareId is supplied (legacy slug path)', async () => {
    const { service } = buildService();
    const out = await service.getSharedPage({ pageId: PAGE_ID } as any, WS);
    expect(out.page.id).toBe(PAGE_ID);
  });

  it('returns the page when the shareId matches the resolved share key', async () => {
    const { service } = buildService();
    const out = await service.getSharedPage(
      { pageId: PAGE_ID, shareId: OWN_SHARE_KEY } as any,
      WS,
    );
    expect(out.page.id).toBe(PAGE_ID);
  });

  it('returns the page when the shareId matches the resolved share id (case-insensitive key)', async () => {
    const { service } = buildService();
    const out = await service.getSharedPage(
      { pageId: PAGE_ID, shareId: OWN_SHARE_KEY.toUpperCase() } as any,
      WS,
    );
    expect(out.page.id).toBe(PAGE_ID);
  });

  it('404s for a forged shareId that resolves to nothing', async () => {
    const { service } = buildService({ ancestorShare: null });
    await expect(
      service.getSharedPage(
        { pageId: PAGE_ID, shareId: 'doesnotexist99' } as any,
        WS,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows an includeSubPages ANCESTOR share that contains the page', async () => {
    const { service } = buildService({
      ancestorShare: {
        id: 'ancestor-share',
        pageId: 'ancestor-page',
        includeSubPages: true,
        workspaceId: WS,
      },
      ancestorFound: true,
    });
    const out = await service.getSharedPage(
      { pageId: PAGE_ID, shareId: 'ancestorkey' } as any,
      WS,
    );
    expect(out.page.id).toBe(PAGE_ID);
  });

  it('404s for a different share WITHOUT includeSubPages', async () => {
    const { service } = buildService({
      ancestorShare: {
        id: 'other-share',
        pageId: 'other-page',
        includeSubPages: false,
        workspaceId: WS,
      },
    });
    await expect(
      service.getSharedPage(
        { pageId: PAGE_ID, shareId: 'otherkey' } as any,
        WS,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s for an includeSubPages share that does NOT contain the page', async () => {
    const { service } = buildService({
      ancestorShare: {
        id: 'unrelated-share',
        pageId: 'unrelated-page',
        includeSubPages: true,
        workspaceId: WS,
      },
      ancestorFound: false,
    });
    await expect(
      service.getSharedPage(
        { pageId: PAGE_ID, shareId: 'unrelatedkey' } as any,
        WS,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s for a share in a different workspace', async () => {
    const { service } = buildService({
      ancestorShare: {
        id: 'foreign-share',
        pageId: 'foreign-page',
        includeSubPages: true,
        workspaceId: 'other-ws',
      },
      ancestorFound: true,
    });
    await expect(
      service.getSharedPage(
        { pageId: PAGE_ID, shareId: 'foreignkey' } as any,
        WS,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
