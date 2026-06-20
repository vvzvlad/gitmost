import { ShareService } from './share.service';
import { hasHtmlEmbedNode } from '../../common/helpers/prosemirror/html-embed.util';

// Exercises the REAL ShareService server-authoritative htmlEmbed kill-switch for
// shared content. An anonymous public-share viewer cannot read the per-workspace
// htmlEmbed toggle, so the SERVER must decide what to serve: when the toggle is
// OFF, htmlEmbed nodes are stripped from the shared doc; when ON they are kept so
// the read-only client executes them. All repos / token service are mocked so the
// real prepareContentForShare logic runs end-to-end via getSharedPage.

const WS = 'ws-1';
const PAGE = 'page-1';

const pageContentWithEmbed = () => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'shared body' }] },
    { type: 'htmlEmbed', attrs: { source: '<script>track()</script>' } },
  ],
});

function buildService(opts: {
  // undefined => workspaceRepo.findById returns undefined (fail-closed case)
  htmlEmbed?: boolean | undefined;
  workspaceMissing?: boolean;
}) {
  const shareRepo = { findById: jest.fn() };

  const pageRepo = {
    findById: jest.fn(async () => ({
      id: PAGE,
      workspaceId: WS,
      spaceId: 'space-1',
      deletedAt: null,
      content: pageContentWithEmbed(),
    })),
  };

  const pagePermissionRepo = {
    hasRestrictedAncestor: jest.fn(async () => false),
  };

  const tokenService = {
    generateAttachmentToken: jest.fn(async () => 'tok'),
  };

  const workspaceRepo = {
    findById: jest.fn(async () =>
      opts.workspaceMissing
        ? undefined
        : { id: WS, settings: { htmlEmbed: opts.htmlEmbed } },
    ),
  };

  const service = new ShareService(
    shareRepo as any,
    pageRepo as any,
    pagePermissionRepo as any,
    {} as any, // db (unused on this path)
    tokenService as any,
    {} as any, // transclusionService (unused)
    workspaceRepo as any,
  );

  // getSharedPage resolves the share via getShareForPage (a raw db query).
  // Stub it so we exercise prepareContentForShare deterministically.
  jest
    .spyOn(service, 'getShareForPage')
    .mockResolvedValue({ pageId: PAGE, key: 'k', id: 's1' } as any);

  return { service, workspaceRepo };
}

describe('ShareService htmlEmbed server-authoritative kill-switch (real code)', () => {
  it('toggle ON: shared content keeps the htmlEmbed (served to anonymous viewer)', async () => {
    const { service } = buildService({ htmlEmbed: true });
    const { page } = await service.getSharedPage(
      { pageId: PAGE } as any,
      WS,
    );
    expect(hasHtmlEmbedNode(page.content)).toBe(true);
    expect(JSON.stringify(page.content)).toContain('shared body');
  });

  it('toggle OFF: htmlEmbed stripped from shared content', async () => {
    const { service } = buildService({ htmlEmbed: false });
    const { page } = await service.getSharedPage(
      { pageId: PAGE } as any,
      WS,
    );
    expect(hasHtmlEmbedNode(page.content)).toBe(false);
    // Non-embed content is preserved.
    expect(JSON.stringify(page.content)).toContain('shared body');
  });

  it('toggle ABSENT: defaults OFF and strips', async () => {
    const { service } = buildService({ htmlEmbed: undefined });
    const { page } = await service.getSharedPage(
      { pageId: PAGE } as any,
      WS,
    );
    expect(hasHtmlEmbedNode(page.content)).toBe(false);
  });

  it('workspace missing: fails closed (stripped)', async () => {
    const { service } = buildService({ workspaceMissing: true });
    const { page } = await service.getSharedPage(
      { pageId: PAGE } as any,
      WS,
    );
    expect(hasHtmlEmbedNode(page.content)).toBe(false);
  });

  it('updatePublicAttachments strips htmlEmbed when toggle OFF', async () => {
    const { service } = buildService({ htmlEmbed: false });
    const out = await service.updatePublicAttachments({
      id: PAGE,
      workspaceId: WS,
      content: pageContentWithEmbed(),
    } as any);
    expect(hasHtmlEmbedNode(out)).toBe(false);
  });

  it('updatePublicAttachments keeps htmlEmbed when toggle ON', async () => {
    const { service } = buildService({ htmlEmbed: true });
    const out = await service.updatePublicAttachments({
      id: PAGE,
      workspaceId: WS,
      content: pageContentWithEmbed(),
    } as any);
    expect(hasHtmlEmbedNode(out)).toBe(true);
  });
});

// Exercises the REAL ShareService.lookupTransclusionForShare post-processing for
// the share-served transclusion path: the same server-authoritative htmlEmbed
// kill-switch must apply to each transcluded item's content, and a not_found
// item must never be run through prepareContentForShare (so its absent content
// can't be serialized/leaked). The access graph (shareRepo / isSharingAllowed /
// getShareForPage / restricted-ancestor) is stubbed so the strip/serve mapping
// runs deterministically; lookupWithAccessSet is mocked to control the items.
describe('ShareService.lookupTransclusionForShare htmlEmbed kill-switch (real code)', () => {
  const SHARE = 'share-1';
  const SPACE = 'space-1';
  const SRC = 'src-page';

  function buildTransclusionService(opts: {
    htmlEmbed?: boolean | undefined;
    items: any[];
  }) {
    const shareRepo = {
      findById: jest.fn(async () => ({
        id: SHARE,
        workspaceId: WS,
        spaceId: SPACE,
      })),
    };
    const pageRepo = { findById: jest.fn() };
    const pagePermissionRepo = {
      hasRestrictedAncestor: jest.fn(async () => false),
    };
    const tokenService = {
      generateAttachmentToken: jest.fn(async () => 'tok'),
    };
    const lookupWithAccessSet = jest.fn(async () => ({ items: opts.items }));
    const transclusionService = { lookupWithAccessSet };
    const workspaceRepo = {
      findById: jest.fn(async () => ({
        id: WS,
        settings: { htmlEmbed: opts.htmlEmbed },
      })),
    };

    const service = new ShareService(
      shareRepo as any,
      pageRepo as any,
      pagePermissionRepo as any,
      {} as any, // db (unused — isSharingAllowed stubbed below)
      tokenService as any,
      transclusionService as any,
      workspaceRepo as any,
    );

    // isSharingAllowed and getShareForPage hit the raw db; stub them so the
    // access chain resolves SRC as reachable and prepareContentForShare runs.
    jest.spyOn(service, 'isSharingAllowed').mockResolvedValue(true);
    jest
      .spyOn(service, 'getShareForPage')
      .mockResolvedValue({ pageId: SRC, spaceId: SPACE, id: 's2' } as any);

    return { service, transclusionService, lookupWithAccessSet };
  }

  const transcludedItemWithEmbed = () => ({
    sourcePageId: SRC,
    transclusionId: 't1',
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'block body' }] },
        { type: 'htmlEmbed', attrs: { source: '<script>t()</script>' } },
      ],
    },
    sourceUpdatedAt: new Date('2026-06-20T00:00:00.000Z'),
  });

  const refs = [{ sourcePageId: SRC, transclusionId: 't1' }];

  it('toggle OFF: strips htmlEmbed from each transcluded item content', async () => {
    const { service } = buildTransclusionService({
      htmlEmbed: false,
      items: [transcludedItemWithEmbed()],
    });

    const { items } = await service.lookupTransclusionForShare(SHARE, refs, WS);
    expect(items).toHaveLength(1);
    const item = items[0] as any;
    expect(item.status).toBeUndefined();
    expect(hasHtmlEmbedNode(item.content)).toBe(false);
    // Non-embed body of the transcluded block is preserved.
    expect(JSON.stringify(item.content)).toContain('block body');
  });

  it('toggle ON: serves htmlEmbed in the transcluded item content', async () => {
    const { service } = buildTransclusionService({
      htmlEmbed: true,
      items: [transcludedItemWithEmbed()],
    });

    const { items } = await service.lookupTransclusionForShare(SHARE, refs, WS);
    const item = items[0] as any;
    expect(item.status).toBeUndefined();
    expect(hasHtmlEmbedNode(item.content)).toBe(true);
    expect(JSON.stringify(item.content)).toContain('block body');
  });

  it('a not_found item is NOT run through prepareContentForShare (no token minting)', async () => {
    const notFoundItem = {
      sourcePageId: SRC,
      transclusionId: 't1',
      status: 'not_found' as const,
    };
    const { service } = buildTransclusionService({
      htmlEmbed: true,
      items: [notFoundItem],
    });
    // tokenService is reachable via the service; spy on it to assert it is never
    // touched for a status item (prepareContentForShare mints tokens).
    const tokenSpy = jest.spyOn(
      (service as any).tokenService,
      'generateAttachmentToken',
    );

    const { items } = await service.lookupTransclusionForShare(SHARE, refs, WS);
    // not_found is collapsed to no_access for share viewers and carries NO content.
    const item = items[0] as any;
    expect(item.status).toBe('no_access');
    expect(item.content).toBeUndefined();
    expect(tokenSpy).not.toHaveBeenCalled();
  });
});
