import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ShareAliasController } from './share-alias.controller';

/**
 * Authz-gate tests for the authenticated alias management controller. The access
 * decisions for creating/retargeting/removing an alias live in THIS controller
 * (the service spec delegates authorization to the caller), so each gate is
 * pinned here against mocked PageRepo / ShareService / ShareAliasService /
 * PageAccessService. A regression that drops any gate must fail here.
 */
describe('ShareAliasController authz gates', () => {
  function makeController() {
    const shareAliasService = {
      setAlias: jest.fn(async () => ({ id: 'alias-1' })),
      removeAlias: jest.fn(async () => undefined),
      getAliasById: jest.fn(),
      getAliasForPage: jest.fn(),
      checkAvailability: jest.fn(),
    };
    const shareService = {
      resolveReadableSharePage: jest.fn(),
      isSharingAllowed: jest.fn(),
    };
    const pageRepo = { findById: jest.fn() };
    const pageAccessService = {
      validateCanEdit: jest.fn(async () => undefined),
      validateCanView: jest.fn(async () => undefined),
    };
    const controller = new ShareAliasController(
      shareAliasService as any,
      shareService as any,
      pageRepo as any,
      pageAccessService as any,
    );
    return {
      controller,
      shareAliasService,
      shareService,
      pageRepo,
      pageAccessService,
    };
  }

  const user: any = { id: 'u-1' };
  const workspace: any = { id: 'ws-1' };

  describe('set', () => {
    it('throws NotFoundException for a nonexistent page', async () => {
      const { controller, pageRepo, pageAccessService } = makeController();
      pageRepo.findById.mockResolvedValue(null);

      await expect(
        controller.set({ pageId: 'p-x', alias: 'promo' } as any, user, workspace),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a page in another workspace', async () => {
      const { controller, pageRepo } = makeController();
      pageRepo.findById.mockResolvedValue({
        id: 'p-1',
        workspaceId: 'ws-OTHER',
      });

      await expect(
        controller.set({ pageId: 'p-1', alias: 'promo' } as any, user, workspace),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('enforces validateCanEdit before setting the alias', async () => {
      const { controller, pageRepo, pageAccessService, shareService } =
        makeController();
      pageRepo.findById.mockResolvedValue({ id: 'p-1', workspaceId: 'ws-1' });
      pageAccessService.validateCanEdit.mockRejectedValue(
        new ForbiddenException('no edit'),
      );

      await expect(
        controller.set({ pageId: 'p-1', alias: 'promo' } as any, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Gate short-circuits before any share resolution.
      expect(shareService.resolveReadableSharePage).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the page is not publicly shared', async () => {
      const { controller, pageRepo, shareService } = makeController();
      pageRepo.findById.mockResolvedValue({ id: 'p-1', workspaceId: 'ws-1' });
      shareService.resolveReadableSharePage.mockResolvedValue(null);

      await expect(
        controller.set({ pageId: 'p-1', alias: 'promo' } as any, user, workspace),
      ).rejects.toThrow('Page is not publicly shared');
      await expect(
        controller.set({ pageId: 'p-1', alias: 'promo' } as any, user, workspace),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws ForbiddenException when public sharing is disabled', async () => {
      const { controller, pageRepo, shareService } = makeController();
      pageRepo.findById.mockResolvedValue({ id: 'p-1', workspaceId: 'ws-1' });
      shareService.resolveReadableSharePage.mockResolvedValue({
        share: { spaceId: 'sp-1' },
      });
      shareService.isSharingAllowed.mockResolvedValue(false);

      await expect(
        controller.set({ pageId: 'p-1', alias: 'promo' } as any, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('delegates to setAlias on the happy path with all gates passed', async () => {
      const { controller, pageRepo, shareService, shareAliasService } =
        makeController();
      pageRepo.findById.mockResolvedValue({ id: 'p-1', workspaceId: 'ws-1' });
      shareService.resolveReadableSharePage.mockResolvedValue({
        share: { spaceId: 'sp-1' },
      });
      shareService.isSharingAllowed.mockResolvedValue(true);

      const result = await controller.set(
        { pageId: 'p-1', alias: 'promo', confirmReassign: true } as any,
        user,
        workspace,
      );

      expect(shareAliasService.setAlias).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        pageId: 'p-1',
        creatorId: 'u-1',
        alias: 'promo',
        confirmReassign: true,
      });
      expect(result).toEqual({ id: 'alias-1' });
    });
  });

  describe('remove', () => {
    it('throws NotFoundException for an unknown alias', async () => {
      const { controller, shareAliasService } = makeController();
      shareAliasService.getAliasById.mockResolvedValue(null);

      await expect(
        controller.remove({ aliasId: 'a-x' } as any, user, workspace),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(shareAliasService.removeAlias).not.toHaveBeenCalled();
    });

    it('requires validateCanEdit on the current target before removing', async () => {
      const { controller, shareAliasService, pageRepo, pageAccessService } =
        makeController();
      shareAliasService.getAliasById.mockResolvedValue({
        id: 'a-1',
        pageId: 'p-1',
      });
      pageRepo.findById.mockResolvedValue({ id: 'p-1', workspaceId: 'ws-1' });
      pageAccessService.validateCanEdit.mockRejectedValue(
        new ForbiddenException('no edit'),
      );

      await expect(
        controller.remove({ aliasId: 'a-1' } as any, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(shareAliasService.removeAlias).not.toHaveBeenCalled();
    });

    it('removes a dangling alias (pageId null) WITHOUT an edit check', async () => {
      const { controller, shareAliasService, pageRepo, pageAccessService } =
        makeController();
      shareAliasService.getAliasById.mockResolvedValue({
        id: 'a-1',
        pageId: null,
      });

      await controller.remove({ aliasId: 'a-1' } as any, user, workspace);

      expect(pageRepo.findById).not.toHaveBeenCalled();
      expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
      expect(shareAliasService.removeAlias).toHaveBeenCalledWith('a-1', 'ws-1');
    });

    it('removes when the editor can edit the current target', async () => {
      const { controller, shareAliasService, pageRepo, pageAccessService } =
        makeController();
      shareAliasService.getAliasById.mockResolvedValue({
        id: 'a-1',
        pageId: 'p-1',
      });
      pageRepo.findById.mockResolvedValue({ id: 'p-1', workspaceId: 'ws-1' });

      await controller.remove({ aliasId: 'a-1' } as any, user, workspace);

      expect(pageAccessService.validateCanEdit).toHaveBeenCalled();
      expect(shareAliasService.removeAlias).toHaveBeenCalledWith('a-1', 'ws-1');
    });

    it('removes even if the recorded target page no longer exists', async () => {
      const { controller, shareAliasService, pageRepo, pageAccessService } =
        makeController();
      shareAliasService.getAliasById.mockResolvedValue({
        id: 'a-1',
        pageId: 'p-gone',
      });
      pageRepo.findById.mockResolvedValue(null);

      await controller.remove({ aliasId: 'a-1' } as any, user, workspace);

      expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
      expect(shareAliasService.removeAlias).toHaveBeenCalledWith('a-1', 'ws-1');
    });
  });

  describe('forPage', () => {
    it('throws NotFoundException for a cross-workspace/nonexistent page', async () => {
      const { controller, pageRepo, pageAccessService } = makeController();
      pageRepo.findById.mockResolvedValue({
        id: 'p-1',
        workspaceId: 'ws-OTHER',
      });

      await expect(
        controller.forPage({ pageId: 'p-1' } as any, user, workspace),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(pageAccessService.validateCanView).not.toHaveBeenCalled();
    });

    it('requires validateCanView and returns the alias (or null)', async () => {
      const { controller, pageRepo, pageAccessService, shareAliasService } =
        makeController();
      pageRepo.findById.mockResolvedValue({ id: 'p-1', workspaceId: 'ws-1' });
      shareAliasService.getAliasForPage.mockResolvedValue({ id: 'a-1' });

      const result = await controller.forPage(
        { pageId: 'p-1' } as any,
        user,
        workspace,
      );

      expect(pageAccessService.validateCanView).toHaveBeenCalled();
      expect(result).toEqual({ id: 'a-1' });
    });

    it('returns null when the page has no alias', async () => {
      const { controller, pageRepo, shareAliasService } = makeController();
      pageRepo.findById.mockResolvedValue({ id: 'p-1', workspaceId: 'ws-1' });
      shareAliasService.getAliasForPage.mockResolvedValue(undefined);

      const result = await controller.forPage(
        { pageId: 'p-1' } as any,
        user,
        workspace,
      );

      expect(result).toBeNull();
    });
  });
});
