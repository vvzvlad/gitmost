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
