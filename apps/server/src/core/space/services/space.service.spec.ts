import { BadRequestException } from '@nestjs/common';
import { SpaceService } from './space.service';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the @InjectKysely()/@InjectQueue()/AUDIT_SERVICE tokens at compile();
// this smoke test only needs the service to construct.
describe('SpaceService', () => {
  let service: SpaceService;

  beforeEach(() => {
    service = new SpaceService(
      {} as any, // spaceRepo
      {} as any, // spaceMemberService
      {} as any, // shareRepo
      {} as any, // workspaceRepo
      {} as any, // licenseCheckService
      {} as any, // db
      {} as any, // attachmentQueue
      {} as any, // auditService
      {} as any, // environmentService
      {} as any, // gitSyncRestrictions
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('updateSpace gitSyncEnabled', () => {
    const workspaceId = 'ws-1';
    const spaceId = 'space-1';

    // executeTx runs the callback immediately with a passthrough trx so the
    // repo calls happen inline; mirrors how the sibling sharing/comments flags
    // are persisted.
    const buildService = (
      settingsBefore: Record<string, any>,
      gitSyncFlag = true,
      hasRestrictedPages = false,
    ) => {
      const spaceRepo = {
        findById: jest.fn().mockResolvedValue({
          id: spaceId,
          name: 'Space',
          slug: 'space',
          description: '',
          settings: settingsBefore,
        }),
        updateGitSyncSettings: jest.fn().mockResolvedValue({}),
        updateSharingSettings: jest.fn().mockResolvedValue({}),
        updateCommentSettings: jest.fn().mockResolvedValue({}),
        updateSpace: jest
          .fn()
          .mockResolvedValue({ id: spaceId, name: 'Space', slug: 'space' }),
        slugExists: jest.fn().mockResolvedValue(false),
      };
      const auditService = { log: jest.fn() };
      const gitSyncRestrictions = {
        spaceHasRestrictedPages: jest.fn(async () => hasRestrictedPages),
      };

      const svc = new SpaceService(
        spaceRepo as any,
        {} as any, // spaceMemberService
        {} as any, // shareRepo
        {} as any, // workspaceRepo
        {} as any, // licenseCheckService
        {} as any, // db
        {} as any, // attachmentQueue
        auditService as any,
        { isGitSyncEnabled: () => gitSyncFlag } as any, // environmentService
        gitSyncRestrictions as any,
      );

      // executeTx is invoked via the imported helper; patch it on the module.
      jest
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        .spyOn(require('@docmost/db/utils'), 'executeTx')
        .mockImplementation(async (_db: any, cb: any) => cb({} as any));

      return { svc, spaceRepo, auditService, gitSyncRestrictions };
    };

    // git-sync cannot enforce page-level restrictions, so a space holding a
    // restricted page cannot have sync switched on.
    it('rejects enabling git sync on a space with restricted pages with a 400 naming the reason, and writes nothing', async () => {
      const { svc, spaceRepo, auditService, gitSyncRestrictions } =
        buildService({}, true, true);

      const attempt = svc.updateSpace(
        { spaceId, gitSyncEnabled: true } as any,
        workspaceId,
      );
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(/page-level access restrictions/);

      expect(gitSyncRestrictions.spaceHasRestrictedPages).toHaveBeenCalledWith(
        spaceId,
        workspaceId,
      );
      expect(spaceRepo.updateGitSyncSettings).not.toHaveBeenCalled();
      expect(spaceRepo.updateSpace).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('still lets git sync be switched OFF on a space with restricted pages', async () => {
      const { svc, spaceRepo, gitSyncRestrictions } = buildService(
        { gitSync: { enabled: true } },
        true,
        true,
      );

      await svc.updateSpace(
        { spaceId, gitSyncEnabled: false } as any,
        workspaceId,
      );

      expect(
        gitSyncRestrictions.spaceHasRestrictedPages,
      ).not.toHaveBeenCalled();
      expect(spaceRepo.updateGitSyncSettings).toHaveBeenCalledWith(
        spaceId,
        workspaceId,
        'enabled',
        false,
        expect.anything(),
      );
    });

    // GIT_SYNC_ENABLED off: a request carrying the git-sync field is rejected
    // loudly before ANY write (no settings persist, no space update, no audit).
    it('rejects gitSyncEnabled with BadRequest and writes nothing when git-sync is disabled', async () => {
      const { svc, spaceRepo, auditService } = buildService({}, false);

      await expect(
        svc.updateSpace({ spaceId, gitSyncEnabled: true } as any, workspaceId),
      ).rejects.toThrow(
        new BadRequestException('Git sync is disabled on this server'),
      );

      expect(spaceRepo.updateGitSyncSettings).not.toHaveBeenCalled();
      expect(spaceRepo.updateSpace).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('persists gitSyncEnabled via updateGitSyncSettings(enabled)', async () => {
      const { svc, spaceRepo } = buildService({});

      await svc.updateSpace(
        { spaceId, gitSyncEnabled: true } as any,
        workspaceId,
      );

      expect(spaceRepo.updateGitSyncSettings).toHaveBeenCalledWith(
        spaceId,
        workspaceId,
        'enabled',
        true,
        expect.anything(),
      );
    });

    it('does not call updateGitSyncSettings when flag is undefined', async () => {
      const { svc, spaceRepo } = buildService({});

      await svc.updateSpace({ spaceId } as any, workspaceId);

      expect(spaceRepo.updateGitSyncSettings).not.toHaveBeenCalled();
    });

    it('records icon changes and persists a partial appearance without overwriting other settings', async () => {
      const { svc, spaceRepo, auditService } = buildService({
        appearance: { icon: 'book', color: '#166c9d' },
        homePageId: 'home',
      });
      const updateAppearanceSettings = jest.fn().mockResolvedValue({});
      Object.assign(spaceRepo, { updateAppearanceSettings });
      await svc.updateSpace({ spaceId, icon: 'rocket' } as any, workspaceId);
      expect(updateAppearanceSettings).toHaveBeenCalledWith(
        spaceId, workspaceId, { icon: 'rocket' }, expect.anything(),
      );
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
        changes: { before: { icon: 'book' }, after: { icon: 'rocket' } },
      }));
    });

    // --- audit delta on the git-sync toggle (test-strategy Module 4 / item #5)
    // updateSpace builds a before/after delta only when a flag's value actually
    // changes, and only logs an audit event when that delta is non-empty. These
    // assert that contract specifically for gitSyncEnabled.
    it('writes a SPACE_UPDATED audit delta on a REAL gitSyncEnabled change (false -> true)', async () => {
      // Prior persisted state: gitSync.enabled = false; the request flips it on.
      const { svc, auditService } = buildService({ gitSync: { enabled: false } });

      await svc.updateSpace(
        { spaceId, gitSyncEnabled: true } as any,
        workspaceId,
      );

      expect(auditService.log).toHaveBeenCalledTimes(1);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: spaceId,
          spaceId,
          changes: {
            before: expect.objectContaining({ gitSyncEnabled: false }),
            after: expect.objectContaining({ gitSyncEnabled: true }),
          },
        }),
      );
    });

    it('also records the delta when no prior gitSync settings exist (undefined -> true defaults prev to false)', async () => {
      // No gitSync key at all: prev resolves to the `?? false` default, so
      // enabling it is still a real change and is audited.
      const { svc, auditService } = buildService({});

      await svc.updateSpace(
        { spaceId, gitSyncEnabled: true } as any,
        workspaceId,
      );

      expect(auditService.log).toHaveBeenCalledTimes(1);
      const call = auditService.log.mock.calls[0][0];
      expect(call.changes.before.gitSyncEnabled).toBe(false);
      expect(call.changes.after.gitSyncEnabled).toBe(true);
    });

    it('does NOT write an audit delta on a no-op gitSyncEnabled (same value true -> true)', async () => {
      // Prior persisted state already true; the request sets the same value.
      // updateGitSyncSettings still runs (idempotent persist), but nothing is
      // added to the before/after delta, so no audit event is emitted.
      const { svc, spaceRepo, auditService } = buildService({
        gitSync: { enabled: true },
      });

      await svc.updateSpace(
        { spaceId, gitSyncEnabled: true } as any,
        workspaceId,
      );

      expect(spaceRepo.updateGitSyncSettings).toHaveBeenCalledTimes(1);
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });
});
