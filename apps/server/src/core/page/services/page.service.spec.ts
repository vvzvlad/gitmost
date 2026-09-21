import { BadRequestException } from '@nestjs/common';
import { PageService } from './page.service';
import { MovePageDto } from '../dto/move-page.dto';
import { Page } from '@docmost/db/types/entity.types';
import { DEFAULT_TEMPORARY_NOTE_HOURS } from '../constants/temporary-note.constants';

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

      // movePage now runs the cycle-check + UPDATE inside executeTx(this.db),
      // i.e. this.db.transaction().execute(fn => fn(trx)). A permissive chainable
      // Proxy stands in for the Kysely trx so the per-space advisory-lock
      // `sql``.execute(trx)` resolves; a thrown BadRequestException still
      // propagates out of the transaction unchanged.
      const trxStub: any = new Proxy(function () {}, {
        get: (_t, p) =>
          p === 'then'
            ? undefined
            : p === 'execute' || p === 'executeTakeFirst'
              ? () => Promise.resolve([])
              : () => trxStub,
      });
      const db = {
        transaction: () => ({ execute: (fn: any) => fn(trxStub) }),
      };

      const svc = new PageService(
        pageRepo as any, // pageRepo
        {} as any, // pagePermissionRepo
        {} as any, // attachmentRepo
        db as any, // db
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

  describe('agent provenance stamping (#143)', () => {
    // Provenance handed to the four write sites. The agent case must surface the
    // signed source marker + chat id on the persisted payload; the user case must
    // leave both keys absent so the column keeps its INSERT default / existing
    // UPDATE value (agentSourceFields returns {} for a non-agent).
    const AGENT = { actor: 'agent', aiChatId: 'chat-7' } as any;
    const USER = { actor: 'user', aiChatId: null } as any;

    // A general-queue stub whose `.add(...)` returns a `{ catch }` thenable —
    // the service does `generalQueue.add(...).catch(...)` and never awaits it.
    const makeGeneralQueue = () =>
      ({ add: jest.fn().mockReturnValue({ catch: jest.fn() }) }) as any;

    // Build a PageService where only the deps a given site touches are real
    // stubs; everything else stays a bare object. db is supplied per-test.
    const makeSvc = (overrides: {
      pageRepo?: any;
      generalQueue?: any;
      db?: any;
    }) =>
      new PageService(
        (overrides.pageRepo ?? {}) as any, // pageRepo
        {} as any, // pagePermissionRepo
        {} as any, // attachmentRepo
        (overrides.db ?? {}) as any, // db
        {} as any, // storageService
        {} as any, // attachmentQueue
        {} as any, // aiQueue
        (overrides.generalQueue ?? makeGeneralQueue()) as any, // generalQueue
        {} as any, // eventEmitter
        {} as any, // collaborationGateway
        {} as any, // watcherService
        {} as any, // transclusionService
      );

    describe('create() → insertPage', () => {
      const run = async (provenance: any) => {
        const pageRepo = {
          insertPage: jest.fn().mockResolvedValue({ id: 'p1' }),
        };
        const svc = makeSvc({ pageRepo, generalQueue: makeGeneralQueue() });
        // nextPagePosition runs a real db query; stub it out.
        jest.spyOn(svc, 'nextPagePosition').mockResolvedValue('a0' as any);
        // No content/format → the prosemirror parse branch is skipped. No
        // parentPageId → no parent lookup.
        await svc.create(
          'u1',
          'w1',
          { title: 't', spaceId: 's1' } as any,
          provenance,
        );
        return pageRepo.insertPage.mock.calls[0][0];
      };

      it('stamps lastUpdatedSource/lastUpdatedAiChatId for an agent', async () => {
        const payload = await run(AGENT);
        expect(payload).toEqual(
          expect.objectContaining({
            lastUpdatedSource: 'agent',
            lastUpdatedAiChatId: 'chat-7',
          }),
        );
      });

      it('omits the source columns for a normal user', async () => {
        const payload = await run(USER);
        expect(payload).not.toHaveProperty('lastUpdatedSource');
        expect(payload).not.toHaveProperty('lastUpdatedAiChatId');
      });
    });

    describe('update() → updatePage', () => {
      const run = async (provenance: any) => {
        const pageRepo = {
          updatePage: jest.fn().mockResolvedValue(undefined),
          findById: jest.fn().mockResolvedValue({ id: 'p1' }),
        };
        const svc = makeSvc({ pageRepo, generalQueue: makeGeneralQueue() });
        const page = {
          id: 'p1',
          contributorIds: [],
          spaceId: 's1',
          workspaceId: 'w1',
          slugId: 'sl1',
          title: 't',
          parentPageId: null,
        } as any;
        // dto carries no content/operation/format → updatePageContent skipped.
        await svc.update(page, {} as any, { id: 'u1' } as any, provenance);
        return pageRepo.updatePage.mock.calls[0][0];
      };

      it('stamps lastUpdatedSource/lastUpdatedAiChatId for an agent', async () => {
        const payload = await run(AGENT);
        expect(payload).toEqual(
          expect.objectContaining({
            lastUpdatedSource: 'agent',
            lastUpdatedAiChatId: 'chat-7',
          }),
        );
      });

      it('omits the source columns for a normal user', async () => {
        const payload = await run(USER);
        expect(payload).not.toHaveProperty('lastUpdatedSource');
        expect(payload).not.toHaveProperty('lastUpdatedAiChatId');
      });
    });

    describe('movePage() → updatePage', () => {
      const VALID_POSITION = 'a0';
      const run = async (provenance: any) => {
        const pageRepo = {
          findById: jest.fn().mockResolvedValue({
            id: 'dest-parent',
            deletedAt: null,
            spaceId: 'space-1',
          }),
          updatePage: jest.fn().mockResolvedValue({ numUpdatedRows: 1n }),
        };
        // movePage now runs the cycle-check + UPDATE inside executeTx(this.db),
        // which calls this.db.transaction().execute(fn => fn(trx)). A permissive
        // chainable Proxy stands in for the Kysely trx so the per-space
        // advisory-lock `sql``.execute(trx)` resolves and updatePage receives it.
        const trxStub: any = new Proxy(function () {}, {
          get: (_t, p) =>
            p === 'then'
              ? undefined
              : p === 'execute' || p === 'executeTakeFirst'
                ? () => Promise.resolve([])
                : () => trxStub,
        });
        const svc = makeSvc({
          pageRepo,
          db: {
            transaction: () => ({ execute: (fn: any) => fn(trxStub) }),
          } as any,
        });
        // Legitimate move: destination ancestors do NOT include the moved page.
        jest
          .spyOn(svc, 'getPageBreadCrumbs')
          .mockResolvedValue([{ id: 'dest-parent' }, { id: 'root' }] as any);
        // eventEmitter is a bare {} stub; movePage emits PAGE_MOVED, so give it
        // an emit. Re-wire via the private field to avoid threading it through.
        (svc as any).eventEmitter = { emit: jest.fn() };
        const movedPage = {
          id: 'page-1',
          parentPageId: 'old-parent',
          spaceId: 'space-1',
          workspaceId: 'ws-1',
          slugId: 'slug-1',
          title: 'Page 1',
          icon: null,
        } as any;
        const dto = {
          pageId: 'page-1',
          position: VALID_POSITION,
          parentPageId: 'dest-parent',
        } as any;
        await svc.movePage(dto, movedPage, provenance);
        return pageRepo.updatePage.mock.calls[0][0];
      };

      it('stamps lastUpdatedSource/lastUpdatedAiChatId for an agent', async () => {
        const payload = await run(AGENT);
        expect(payload).toEqual(
          expect.objectContaining({
            lastUpdatedSource: 'agent',
            lastUpdatedAiChatId: 'chat-7',
          }),
        );
      });

      it('omits the source columns for a normal user', async () => {
        const payload = await run(USER);
        expect(payload).not.toHaveProperty('lastUpdatedSource');
        expect(payload).not.toHaveProperty('lastUpdatedAiChatId');
      });
    });

    describe('movePageToSpace() → root-page updatePage', () => {
      // movePageToSpace runs its writes inside executeTx(this.db, cb), which
      // calls this.db.transaction().execute(fn => fn(trx)). A permissive
      // chainable Proxy stands in for the Kysely trx so arbitrary chains resolve.
      const makeChain = () => {
        const c: any = new Proxy(function () {}, {
          get: (_t, p) =>
            p === 'then'
              ? undefined
              : p === 'execute' || p === 'executeTakeFirst'
                ? () => Promise.resolve([])
                : () => c,
        });
        return c;
      };

      const run = async (provenance: any) => {
        const trxStub = makeChain();
        const db = {
          transaction: () => ({ execute: (fn: any) => fn(trxStub) }),
        } as any;
        const rootPage = {
          id: 'root',
          spaceId: 'src-space',
          parentPageId: null,
          workspaceId: 'ws-1',
        } as any;
        const pageRepo = {
          getPageAndDescendants: jest.fn().mockResolvedValue([rootPage]),
          updatePage: jest.fn().mockResolvedValue(undefined),
          updatePages: jest.fn().mockResolvedValue(undefined),
        };
        const svc = makeSvc({ pageRepo, db });
        // The single-accessible-page path still runs the bulk side-effect writes
        // (attachments/watchers/ai-queue) AFTER the root updatePage we assert on;
        // stub them so the transaction completes without throwing.
        (svc as any).attachmentRepo = {
          updateAttachmentsByPageId: jest.fn().mockResolvedValue(undefined),
        };
        (svc as any).watcherService = {
          movePageWatchersToSpace: jest.fn().mockResolvedValue(undefined),
        };
        (svc as any).aiQueue = { add: jest.fn().mockResolvedValue(undefined) };
        // Single accessible page (the root) → pagesToOrphan is empty, so the
        // root updatePage is the first/only provenance-carrying updatePage call.
        // filterAccessibleTreePages is private; spy via an `any` cast.
        jest
          .spyOn(svc as any, 'filterAccessibleTreePages')
          .mockResolvedValue([rootPage] as any);
        jest.spyOn(svc, 'nextPagePosition').mockResolvedValue('a0' as any);
        await svc.movePageToSpace(rootPage, 'dst-space', 'u1', provenance);
        return pageRepo.updatePage.mock.calls[0][0];
      };

      it('stamps the moved root with the agent source + chat id', async () => {
        const payload = await run(AGENT);
        expect(payload).toEqual(
          expect.objectContaining({
            spaceId: 'dst-space',
            lastUpdatedSource: 'agent',
            lastUpdatedAiChatId: 'chat-7',
          }),
        );
      });

      it('omits the source columns on the moved root for a normal user', async () => {
        const payload = await run(USER);
        expect(payload).toEqual(
          expect.objectContaining({ spaceId: 'dst-space' }),
        );
        expect(payload).not.toHaveProperty('lastUpdatedSource');
        expect(payload).not.toHaveProperty('lastUpdatedAiChatId');
      });
    });
  });

  describe('create() temporary deadline (#201)', () => {
    // db stub for the workspaces.temporaryNoteHours lookup:
    // selectFrom('workspaces').select(['temporaryNoteHours']).where(...).executeTakeFirst()
    const makeDb = (workspaceRow: any) => {
      const builder: any = {
        selectFrom: jest.fn(() => builder),
        select: jest.fn(() => builder),
        where: jest.fn(() => builder),
        executeTakeFirst: jest.fn().mockResolvedValue(workspaceRow),
      };
      return builder;
    };

    const makeGeneralQueue = () =>
      ({ add: jest.fn().mockReturnValue({ catch: jest.fn() }) }) as any;

    const run = async (dto: any, workspaceRow: any) => {
      const pageRepo = {
        insertPage: jest.fn().mockResolvedValue({ id: 'p1' }),
      };
      const db = makeDb(workspaceRow);
      const svc = new PageService(
        pageRepo as any, // pageRepo
        {} as any, // pagePermissionRepo
        {} as any, // attachmentRepo
        db as any, // db
        {} as any, // storageService
        {} as any, // attachmentQueue
        {} as any, // aiQueue
        makeGeneralQueue(), // generalQueue
        {} as any, // eventEmitter
        {} as any, // collaborationGateway
        {} as any, // watcherService
        {} as any, // transclusionService
      );
      // nextPagePosition runs a real db query; stub it out.
      jest.spyOn(svc, 'nextPagePosition').mockResolvedValue('a0' as any);
      await svc.create('u1', 'w1', dto, undefined);
      return { payload: pageRepo.insertPage.mock.calls[0][0], db };
    };

    afterEach(() => jest.useRealTimers());

    it('freezes temporaryExpiresAt at now + workspace hours when temporary', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-26T00:00:00.000Z'));
      const { payload } = await run(
        { title: 't', spaceId: 's1', temporary: true },
        { temporaryNoteHours: 5 },
      );
      expect(payload.temporaryExpiresAt).toEqual(
        new Date(Date.now() + 5 * 60 * 60 * 1000),
      );
    });

    it('falls back to DEFAULT_TEMPORARY_NOTE_HOURS when the workspace hours are null', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-26T00:00:00.000Z'));
      const { payload } = await run(
        { title: 't', spaceId: 's1', temporary: true },
        { temporaryNoteHours: null },
      );
      expect(payload.temporaryExpiresAt).toEqual(
        new Date(Date.now() + DEFAULT_TEMPORARY_NOTE_HOURS * 60 * 60 * 1000),
      );
    });

    it('leaves temporaryExpiresAt undefined and skips the workspace lookup for a non-temporary page', async () => {
      const { payload, db } = await run(
        { title: 't', spaceId: 's1' },
        { temporaryNoteHours: 5 },
      );
      expect(payload.temporaryExpiresAt).toBeUndefined();
      expect(db.selectFrom).not.toHaveBeenCalled();
    });
  });
});
