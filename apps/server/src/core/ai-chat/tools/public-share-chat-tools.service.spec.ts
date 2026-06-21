import { PublicShareChatToolsService } from './public-share-chat-tools.service';

/**
 * Mock-based integration tests for the anonymous public-share toolset built by
 * forShare(). Constructed directly with hand-rolled collaborators (no Nest/DB):
 *  - listSharePages tree assembly (dedupe, single-page root fallback, fail-soft);
 *  - the blank-input guards on search / read.
 */
describe('PublicShareChatToolsService.forShare', () => {
  type ToolExec = { execute: (args: unknown) => Promise<unknown> };

  function makeService(over: {
    getShareTree?: jest.Mock;
    findById?: jest.Mock;
    searchPage?: jest.Mock;
    getShareForPage?: jest.Mock;
  } = {}) {
    const shareService = {
      getShareTree: over.getShareTree ?? jest.fn(),
      getShareForPage: over.getShareForPage ?? jest.fn(),
      updatePublicAttachments: jest.fn(),
    };
    const searchService = { searchPage: over.searchPage ?? jest.fn() };
    const pageRepo = { findById: over.findById ?? jest.fn() };
    const pagePermissionRepo = { hasRestrictedAncestor: jest.fn() };
    const svc = new PublicShareChatToolsService(
      shareService as never,
      searchService as never,
      pageRepo as never,
      pagePermissionRepo as never,
    );
    return { svc, shareService, searchService, pageRepo, pagePermissionRepo };
  }

  describe('listSharePages', () => {
    it('includeSubPages tree: returns deduped, titled pages (root already in tree)', async () => {
      // getShareTree returns the share root + descendants; the root IS in the
      // tree, so no extra title lookup is needed and the tree is listed as-is.
      const { svc, pageRepo } = makeService({
        getShareTree: jest.fn().mockResolvedValue({
          share: { pageId: 'root' },
          pageTree: [
            { id: 'root', title: 'Home' },
            { id: 'child-1', title: 'Child One' },
            { id: 'child-2', title: 'Child Two' },
          ],
        }),
      });
      const tools = svc.forShare('SHARE-A', 'ws-1');
      const out = (await (tools.listSharePages as unknown as ToolExec).execute(
        {},
      )) as Array<{ id: string; title: string }>;
      expect(out).toEqual([
        { id: 'root', title: 'Home' },
        { id: 'child-1', title: 'Child One' },
        { id: 'child-2', title: 'Child Two' },
      ]);
      // The root was already in the tree => no fallback title lookup.
      expect(pageRepo.findById).not.toHaveBeenCalled();
    });

    it('single-page share (empty tree): falls back to the root title and PREPENDS it', async () => {
      const { svc, pageRepo } = makeService({
        getShareTree: jest.fn().mockResolvedValue({
          share: { pageId: 'root' },
          pageTree: [], // includeSubPages=false => empty tree
        }),
        findById: jest.fn().mockResolvedValue({ id: 'root', title: 'Solo Page' }),
      });
      const tools = svc.forShare('SHARE-A', 'ws-1');
      const out = (await (tools.listSharePages as unknown as ToolExec).execute(
        {},
      )) as Array<{ id: string; title: string }>;
      expect(out).toEqual([{ id: 'root', title: 'Solo Page' }]);
      expect(pageRepo.findById).toHaveBeenCalledWith('root');
    });

    it('de-duplicates pages by id, keeping the first (titled) occurrence', async () => {
      const { svc } = makeService({
        getShareTree: jest.fn().mockResolvedValue({
          share: { pageId: 'root' },
          pageTree: [
            { id: 'root', title: 'Home' },
            { id: 'dup', title: 'First' },
            { id: 'dup', title: 'Second (dropped)' },
            { id: 'root', title: 'Home again (dropped)' },
          ],
        }),
      });
      const tools = svc.forShare('SHARE-A', 'ws-1');
      const out = (await (tools.listSharePages as unknown as ToolExec).execute(
        {},
      )) as Array<{ id: string; title: string }>;
      expect(out).toEqual([
        { id: 'root', title: 'Home' },
        { id: 'dup', title: 'First' },
      ]);
    });

    it('getShareTree throws => returns [] (fail-soft, never throws to the model)', async () => {
      const { svc } = makeService({
        getShareTree: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const tools = svc.forShare('SHARE-A', 'ws-1');
      await expect(
        (tools.listSharePages as unknown as ToolExec).execute({}),
      ).resolves.toEqual([]);
    });
  });

  describe('searchSharePages blank guard', () => {
    it('blank query => [] WITHOUT calling searchService', async () => {
      const { svc, searchService } = makeService({ searchPage: jest.fn() });
      const tools = svc.forShare('SHARE-A', 'ws-1');
      await expect(
        (tools.searchSharePages as unknown as ToolExec).execute({ query: '   ' }),
      ).resolves.toEqual([]);
      expect(searchService.searchPage).not.toHaveBeenCalled();
    });
  });

  describe('getSharePage blank guard', () => {
    it('blank pageId => throws "A pageId is required." WITHOUT calling getShareForPage', async () => {
      const { svc, shareService } = makeService({ getShareForPage: jest.fn() });
      const tools = svc.forShare('SHARE-A', 'ws-1');
      await expect(
        (tools.getSharePage as unknown as ToolExec).execute({ pageId: '   ' }),
      ).rejects.toThrow('A pageId is required.');
      expect(shareService.getShareForPage).not.toHaveBeenCalled();
    });
  });

  describe('getSharePage positive branch (security-relevant sanitization)', () => {
    it('page belongs to THIS share, live, not restricted => sanitizes content (updatePublicAttachments) before jsonToMarkdown, returns {title, markdown} derived from SANITIZED content', async () => {
      // The raw page content carries a comment mark + a raw attachment id that
      // MUST NOT reach the anonymous model. updatePublicAttachments is the
      // sanitizer that strips those; we assert the returned markdown is derived
      // from its OUTPUT, never from the raw page.content.
      const rawContent = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'SECRET_RAW_ATTACHMENT_ID_should_be_stripped',
                marks: [{ type: 'comment', attrs: { commentId: 'c-1' } }],
              },
            ],
          },
        ],
      };
      const sanitizedContent = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'sanitized public text' }],
          },
        ],
      };

      const page = {
        id: 'page-1',
        title: 'Live Page',
        deletedAt: null,
        content: rawContent,
      };

      const { svc, shareService, pageRepo, pagePermissionRepo } = makeService({
        // getShareForPage resolves to THIS share (id matches the forShare scope).
        getShareForPage: jest.fn().mockResolvedValue({ id: 'SHARE-A' }),
        findById: jest.fn().mockResolvedValue(page),
      });
      // Page has no restricted ancestor => passes the restriction gate.
      pagePermissionRepo.hasRestrictedAncestor.mockResolvedValue(false);
      // The sanitizer returns the SANITIZED content (raw secrets removed).
      shareService.updatePublicAttachments.mockResolvedValue(sanitizedContent);

      const tools = svc.forShare('SHARE-A', 'ws-1');
      const out = (await (tools.getSharePage as unknown as ToolExec).execute({
        pageId: ' page-1 ',
      })) as { title: string; markdown: string };

      // Membership + liveness + restriction checks were all consulted.
      expect(shareService.getShareForPage).toHaveBeenCalledWith(
        'page-1',
        'ws-1',
      );
      expect(pageRepo.findById).toHaveBeenCalledWith('page-1', {
        includeContent: true,
      });
      expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalledWith(
        'page-1',
      );

      // CRITICAL: the sanitizer MUST be called with the page before any content
      // is converted. If a future change drops/reorders this, raw comment marks
      // and attachment ids would leak to the anonymous model.
      expect(shareService.updatePublicAttachments).toHaveBeenCalledTimes(1);
      expect(shareService.updatePublicAttachments).toHaveBeenCalledWith(page);

      // The returned markdown derives from the SANITIZED content, not the raw
      // page.content: it contains the sanitized text and NONE of the secrets.
      expect(out.title).toBe('Live Page');
      expect(out.markdown).toContain('sanitized public text');
      expect(out.markdown).not.toContain('SECRET_RAW_ATTACHMENT_ID');
      expect(out.markdown).not.toContain('commentId');
    });
  });

  describe('getSharePage soft-deleted page', () => {
    it('findById returns a soft-deleted page (deletedAt set) => generic error, NO content fetch (updatePublicAttachments not called, nothing leaked)', async () => {
      const deletedPage = {
        id: 'page-1',
        title: 'Deleted Page',
        deletedAt: new Date(),
        content: { type: 'doc', content: [] },
      };
      const { svc, shareService, pagePermissionRepo } = makeService({
        getShareForPage: jest.fn().mockResolvedValue({ id: 'SHARE-A' }),
        findById: jest.fn().mockResolvedValue(deletedPage),
      });

      const tools = svc.forShare('SHARE-A', 'ws-1');
      // Same generic message as an out-of-share page (no info leak).
      await expect(
        (tools.getSharePage as unknown as ToolExec).execute({
          pageId: 'page-1',
        }),
      ).rejects.toThrow('That page is not part of this published share.');

      // Short-circuits before the restriction gate AND before the sanitizer:
      // no content is ever fetched/returned for a soft-deleted page.
      expect(pagePermissionRepo.hasRestrictedAncestor).not.toHaveBeenCalled();
      expect(shareService.updatePublicAttachments).not.toHaveBeenCalled();
    });
  });
});
