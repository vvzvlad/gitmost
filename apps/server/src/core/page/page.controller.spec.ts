import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PageController } from './page.controller';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve PageService's injected tokens at compile(), and this smoke test only
// needs the controller to construct.
describe('PageController', () => {
  let controller: PageController;

  beforeEach(() => {
    controller = new PageController(
      {} as any, // pageService
      {} as any, // pageRepo
      {} as any, // pageHistoryService
      {} as any, // spaceAbility
      {} as any, // pageAccessService
      {} as any, // backlinkService
      {} as any, // labelService
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // #395 — the work-time endpoint must be gated exactly like /history.
  describe('getPageWorkTime', () => {
    const user = { id: 'u1' } as any;

    function build(overrides: {
      page?: any;
      validate?: jest.Mock;
      compute?: jest.Mock;
    }) {
      const pageRepo = { findById: jest.fn().mockResolvedValue(overrides.page) };
      const pageAccessService = {
        validateCanView: overrides.validate ?? jest.fn().mockResolvedValue(undefined),
      };
      const pageHistoryService = {
        computeWorkTime:
          overrides.compute ?? jest.fn().mockResolvedValue({ workMs: 0 }),
      };
      const c = new PageController(
        {} as any,
        pageRepo as any,
        pageHistoryService as any,
        {} as any,
        pageAccessService as any,
        {} as any,
        {} as any,
        {} as any,
      );
      return { c, pageRepo, pageAccessService, pageHistoryService };
    }

    it('404s when the page does not exist', async () => {
      const { c } = build({ page: null });
      await expect(
        c.getPageWorkTime({ pageId: 'p1' } as any, user),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('enforces validateCanView before computing, then delegates with tz', async () => {
      const validate = jest.fn().mockResolvedValue(undefined);
      const compute = jest.fn().mockResolvedValue({ workMs: 42 });
      const { c } = build({ page: { id: 'pg' }, validate, compute });
      const out = await c.getPageWorkTime(
        { pageId: 'pg', tz: 'Europe/Moscow' } as any,
        user,
      );
      expect(validate).toHaveBeenCalledWith({ id: 'pg' }, user);
      expect(compute).toHaveBeenCalledWith('pg', 'Europe/Moscow');
      expect(out).toEqual({ workMs: 42 });
    });

    it('propagates a denied view gate and does NOT reach compute (security)', async () => {
      // If validateCanView is moved AFTER computeWorkTime, the timeline of a page
      // the caller may not see would be read/estimated before the gate — this
      // locks the order: a rejecting gate must short-circuit before any compute.
      const validate = jest.fn().mockRejectedValue(new ForbiddenException());
      const compute = jest.fn().mockResolvedValue({ workMs: 1 });
      const { c, pageHistoryService } = build({
        page: { id: 'pg' },
        validate,
        compute,
      });
      await expect(
        c.getPageWorkTime({ pageId: 'pg' } as any, user),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageHistoryService.computeWorkTime).not.toHaveBeenCalled();
    });

    it('maps an unknown-timezone RangeError to a 400', async () => {
      const compute = jest.fn().mockRejectedValue(new RangeError('bad tz'));
      const { c } = build({ page: { id: 'pg' }, compute });
      await expect(
        c.getPageWorkTime({ pageId: 'pg', tz: 'X/Y' } as any, user),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not swallow a non-RangeError from the service', async () => {
      const compute = jest.fn().mockRejectedValue(new Error('db down'));
      const { c } = build({ page: { id: 'pg' }, compute });
      await expect(
        c.getPageWorkTime({ pageId: 'pg' } as any, user),
      ).rejects.toThrow('db down');
    });
  });

  // #568 — the revisions-per-day heatmap endpoint must be gated exactly like
  // /history and /history/time (view-gated, bad tz → 400).
  describe('getPageHistoryDayCounts', () => {
    const user = { id: 'u1' } as any;

    function build(overrides: {
      page?: any;
      validate?: jest.Mock;
      compute?: jest.Mock;
    }) {
      const pageRepo = { findById: jest.fn().mockResolvedValue(overrides.page) };
      const pageAccessService = {
        validateCanView:
          overrides.validate ?? jest.fn().mockResolvedValue(undefined),
      };
      const pageHistoryService = {
        computeDayCounts:
          overrides.compute ?? jest.fn().mockResolvedValue([]),
      };
      const c = new PageController(
        {} as any,
        pageRepo as any,
        pageHistoryService as any,
        {} as any,
        pageAccessService as any,
        {} as any,
        {} as any,
        {} as any,
      );
      return { c, pageRepo, pageAccessService, pageHistoryService };
    }

    it('404s when the page does not exist', async () => {
      const { c } = build({ page: null });
      await expect(
        c.getPageHistoryDayCounts({ pageId: 'p1' } as any, user),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('enforces validateCanView before computing, then delegates with tz', async () => {
      const validate = jest.fn().mockResolvedValue(undefined);
      const compute = jest
        .fn()
        .mockResolvedValue([{ dayISO: '2026-07-04', count: 3 }]);
      const { c } = build({ page: { id: 'pg' }, validate, compute });
      const out = await c.getPageHistoryDayCounts(
        { pageId: 'pg', tz: 'Europe/Moscow' } as any,
        user,
      );
      expect(validate).toHaveBeenCalledWith({ id: 'pg' }, user);
      expect(compute).toHaveBeenCalledWith('pg', 'Europe/Moscow');
      expect(out).toEqual([{ dayISO: '2026-07-04', count: 3 }]);
    });

    it('propagates a denied view gate and does NOT reach compute (security)', async () => {
      const validate = jest.fn().mockRejectedValue(new ForbiddenException());
      const compute = jest.fn().mockResolvedValue([]);
      const { c, pageHistoryService } = build({
        page: { id: 'pg' },
        validate,
        compute,
      });
      await expect(
        c.getPageHistoryDayCounts({ pageId: 'pg' } as any, user),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageHistoryService.computeDayCounts).not.toHaveBeenCalled();
    });

    it('maps an unknown-timezone RangeError to a 400', async () => {
      const compute = jest.fn().mockRejectedValue(new RangeError('bad tz'));
      const { c } = build({ page: { id: 'pg' }, compute });
      await expect(
        c.getPageHistoryDayCounts({ pageId: 'pg', tz: 'X/Y' } as any, user),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not swallow a non-RangeError from the service', async () => {
      const compute = jest.fn().mockRejectedValue(new Error('db down'));
      const { c } = build({ page: { id: 'pg' }, compute });
      await expect(
        c.getPageHistoryDayCounts({ pageId: 'pg' } as any, user),
      ).rejects.toThrow('db down');
    });
  });
});
