import { TransclusionService } from '../transclusion.service';
import { hasHtmlEmbedNode } from '../../../../common/helpers/prosemirror/html-embed.util';

// Exercises the REAL TransclusionService.unsyncReference htmlEmbed admin gate.
// unsync returns a source snapshot the client materializes into the reference
// page; a non-admin must never receive an embed payload to re-persist. The gate
// reads `user.role` and strips before returning. All repos / access checks are
// mocked so the REAL gate logic runs end-to-end. Complements the existing
// transclusion specs (rewriteAttachmentsForUnsync, controller).

const WS = 'ws-1';
const REF_PAGE = 'ref-1';
const SRC_PAGE = 'src-1';
const TX_ID = 'tx-1';

const sourceContentWithEmbed = () => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'snapshot body' }] },
    { type: 'htmlEmbed', attrs: { source: '<script>steal()</script>' } },
  ],
});

function buildService(featureEnabled = true) {
  const pageRepo = {
    findById: jest.fn(async (id: string) => ({
      id,
      workspaceId: WS,
      spaceId: 'space-1',
      deletedAt: null,
    })),
  };
  const pageTransclusionsRepo = {
    findByPageAndTransclusion: jest.fn(async () => ({
      content: sourceContentWithEmbed(),
    })),
  };
  const pageTransclusionReferencesRepo = {
    deleteOne: jest.fn(async () => undefined),
  };
  const attachmentRepo = { findByIds: jest.fn(async () => []) };
  const storageService = { copy: jest.fn(async () => undefined) };
  const pageAccessService = {
    validateCanEdit: jest.fn(async () => undefined),
    validateCanView: jest.fn(async () => undefined),
  };
  // Workspace settings read used by the toggle-AND-admin gate.
  const workspaceRepo = {
    findById: jest.fn(async () => ({
      id: WS,
      settings: { htmlEmbed: featureEnabled },
    })),
  };

  const service = new TransclusionService(
    {} as any, // db (unused on this path)
    pageTransclusionsRepo as any,
    pageTransclusionReferencesRepo as any,
    {} as any, // pageTemplateReferencesRepo (unused on this path)
    pageRepo as any,
    {} as any, // pagePermissionRepo (unused)
    {} as any, // spaceMemberRepo (unused)
    attachmentRepo as any,
    storageService as any,
    pageAccessService as any,
    workspaceRepo as any,
  );
  return service;
}

function userWithRole(role: string | null | undefined) {
  return { id: 'u1', workspaceId: WS, role } as any;
}

describe('TransclusionService.unsyncReference htmlEmbed admin gate (real code)', () => {
  it('non-admin (member): returned content has htmlEmbed stripped', async () => {
    const service = buildService();
    const { content } = await service.unsyncReference(
      REF_PAGE,
      SRC_PAGE,
      TX_ID,
      userWithRole('member'),
    );
    expect(hasHtmlEmbedNode(content)).toBe(false);
    // Non-embed content is preserved.
    expect(JSON.stringify(content)).toContain('snapshot body');
  });

  it('unknown/empty role: fails closed (stripped)', async () => {
    for (const role of [undefined, null, 'viewer'] as const) {
      const service = buildService();
      const { content } = await service.unsyncReference(
        REF_PAGE,
        SRC_PAGE,
        TX_ID,
        userWithRole(role),
      );
      expect(hasHtmlEmbedNode(content)).toBe(false);
    }
  });

  it('toggle ON + admin: returned content keeps the htmlEmbed', async () => {
    const service = buildService(true);
    const { content } = await service.unsyncReference(
      REF_PAGE,
      SRC_PAGE,
      TX_ID,
      userWithRole('admin'),
    );
    expect(hasHtmlEmbedNode(content)).toBe(true);
  });

  it('toggle ON + owner: returned content keeps the htmlEmbed', async () => {
    const service = buildService(true);
    const { content } = await service.unsyncReference(
      REF_PAGE,
      SRC_PAGE,
      TX_ID,
      userWithRole('owner'),
    );
    expect(hasHtmlEmbedNode(content)).toBe(true);
  });

  it('toggle OFF + admin: stripped (feature disabled for everyone)', async () => {
    const service = buildService(false);
    const { content } = await service.unsyncReference(
      REF_PAGE,
      SRC_PAGE,
      TX_ID,
      userWithRole('admin'),
    );
    expect(hasHtmlEmbedNode(content)).toBe(false);
  });

  it('toggle OFF + member: stripped', async () => {
    const service = buildService(false);
    const { content } = await service.unsyncReference(
      REF_PAGE,
      SRC_PAGE,
      TX_ID,
      userWithRole('member'),
    );
    expect(hasHtmlEmbedNode(content)).toBe(false);
  });
});
