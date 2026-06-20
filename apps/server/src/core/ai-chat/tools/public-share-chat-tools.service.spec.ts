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
});
