import { BadRequestException } from '@nestjs/common';
import { PageService } from './page.service';
import { MovePageDto } from '../dto/move-page.dto';
import { Page } from '@docmost/db/types/entity.types';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the @InjectKysely()/@InjectQueue() tokens at compile(), and this
// smoke test only needs the service to construct.
describe('PageService', () => {
  let service: PageService;

  beforeEach(() => {
    service = new PageService(
      {} as any, // pageRepo
      {} as any, // pagePermissionRepo
      {} as any, // attachmentRepo
      {} as any, // db
      {} as any, // storageService
      {} as any, // attachmentQueue
      {} as any, // aiQueue
      {} as any, // generalQueue
      {} as any, // eventEmitter
      {} as any, // collaborationGateway
      {} as any, // watcherService
      {} as any, // transclusionService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('movePage cycle guard (#67)', () => {
    // A valid fractional-indexing key — movePage validates `position` by feeding
    // it to generateJitteredKeyBetween(position, null) before anything else.
    const VALID_POSITION = 'a0';
    const SPACE_ID = 'space-1';

    // Build a PageService whose pageRepo (findById/updatePage) and own
    // getPageBreadCrumbs are mockable, while every other collaborator stays a
    // bare stub. We only need to drive the three cycle-guard branches, so we
    // mock minimally rather than standing up the whole DI graph.
    const makeService = (overrides?: {
      breadcrumbs?: Array<{ id: string }>;
    }) => {
      const pageRepo = {
        // Destination parent lookup: a valid, non-deleted, same-space page.
        findById: jest.fn().mockResolvedValue({
          id: 'dest-parent',
          deletedAt: null,
          spaceId: SPACE_ID,
        }),
        // numUpdatedRows must be 1n so the #64 phantom-broadcast gate passes and
        // movePage proceeds to emit PAGE_MOVED instead of early-returning.
        updatePage: jest.fn().mockResolvedValue({ numUpdatedRows: 1n }),
      };

      const eventEmitter = { emit: jest.fn() };

      const svc = new PageService(
        pageRepo as any, // pageRepo
        {} as any, // pagePermissionRepo
        {} as any, // attachmentRepo
        {} as any, // db
        {} as any, // storageService
        {} as any, // attachmentQueue
        {} as any, // aiQueue
        {} as any, // generalQueue
        eventEmitter as any, // eventEmitter
        {} as any, // collaborationGateway
        {} as any, // watcherService
        {} as any, // transclusionService
      );

      // getPageBreadCrumbs is a method on PageService itself (it runs a recursive
      // ancestor CTE against the db). Spy on the instance method so we can return
      // a synthetic ancestor chain without a real database.
      jest
        .spyOn(svc, 'getPageBreadCrumbs')
        .mockResolvedValue((overrides?.breadcrumbs ?? []) as any);

      return { svc, pageRepo, eventEmitter };
    };

    // movePage takes `movedPage` as a param. Keep its parentPageId distinct from
    // the dto's parentPageId so the re-parent branch (and thus the cycle guard)
    // actually runs instead of short-circuiting to a same-parent reorder.
    const makeMovedPage = (): Page =>
      ({
        id: 'page-1',
        parentPageId: 'old-parent',
        spaceId: SPACE_ID,
        workspaceId: 'ws-1',
        slugId: 'slug-1',
        title: 'Page 1',
        icon: null,
      }) as any;

    it('rejects a self-move (parentPageId === pageId) without updating', async () => {
      const { svc, pageRepo } = makeService();
      const dto: MovePageDto = {
        pageId: 'page-1',
        position: VALID_POSITION,
        parentPageId: 'page-1', // moving the page into itself
      };

      await expect(svc.movePage(dto, makeMovedPage())).rejects.toThrow(
        BadRequestException,
      );
      expect(pageRepo.updatePage).not.toHaveBeenCalled();
    });

    it('rejects moving a page into its own subtree (cycle) before updating', async () => {
      // Destination's ancestor chain includes the page being moved -> the
      // destination lives inside the moved page's subtree -> cycle.
      const { svc, pageRepo } = makeService({
        breadcrumbs: [
          { id: 'dest-parent' },
          { id: 'page-1' }, // the moved page appears among the destination's ancestors
          { id: 'root' },
        ],
      });
      const dto: MovePageDto = {
        pageId: 'page-1',
        position: VALID_POSITION,
        parentPageId: 'dest-parent',
      };

      await expect(svc.movePage(dto, makeMovedPage())).rejects.toThrow(
        BadRequestException,
      );
      expect(pageRepo.updatePage).not.toHaveBeenCalled();
    });

    it('allows a legitimate move when the destination is not in the subtree', async () => {
      // Destination's ancestor chain does NOT contain the moved page -> no cycle.
      const { svc, pageRepo } = makeService({
        breadcrumbs: [{ id: 'dest-parent' }, { id: 'root' }],
      });
      const dto: MovePageDto = {
        pageId: 'page-1',
        position: VALID_POSITION,
        parentPageId: 'dest-parent',
      };

      await expect(svc.movePage(dto, makeMovedPage())).resolves.not.toThrow();
      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
    });
  });
});
