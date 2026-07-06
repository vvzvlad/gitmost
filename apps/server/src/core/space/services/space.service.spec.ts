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
    const buildService = (settingsBefore: Record<string, any>) => {
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

      const svc = new SpaceService(
        spaceRepo as any,
        {} as any, // spaceMemberService
        {} as any, // shareRepo
        {} as any, // workspaceRepo
        {} as any, // licenseCheckService
        {} as any, // db
        {} as any, // attachmentQueue
        auditService as any,
      );

      // executeTx is invoked via the imported helper; patch it on the module.
      jest
        .spyOn(require('@docmost/db/utils'), 'executeTx')
        .mockImplementation(async (_db: any, cb: any) => cb({} as any));

      return { svc, spaceRepo, auditService };
    };

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

    // --- autoMergeConflicts: a SECOND key in the SAME `gitSync` jsonb object,
    // persisted the same way as `enabled` (the repo's jsonb-merge keeps siblings).
    it('persists autoMergeConflicts via updateGitSyncSettings(autoMergeConflicts)', async () => {
      const { svc, spaceRepo } = buildService({});

      await svc.updateSpace(
        { spaceId, autoMergeConflicts: true } as any,
        workspaceId,
      );

      expect(spaceRepo.updateGitSyncSettings).toHaveBeenCalledWith(
        spaceId,
        workspaceId,
        'autoMergeConflicts',
        true,
        expect.anything(),
      );
    });

    it('does not call updateGitSyncSettings when autoMergeConflicts is undefined', async () => {
      const { svc, spaceRepo } = buildService({});

      await svc.updateSpace({ spaceId } as any, workspaceId);

      expect(spaceRepo.updateGitSyncSettings).not.toHaveBeenCalled();
    });

    it('writes a SPACE_UPDATED audit delta on a REAL autoMergeConflicts change (false -> true)', async () => {
      // Prior persisted state: gitSync.autoMergeConflicts = false; flip it on.
      const { svc, auditService } = buildService({
        gitSync: { autoMergeConflicts: false },
      });

      await svc.updateSpace(
        { spaceId, autoMergeConflicts: true } as any,
        workspaceId,
      );

      expect(auditService.log).toHaveBeenCalledTimes(1);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: spaceId,
          spaceId,
          changes: {
            before: expect.objectContaining({ autoMergeConflicts: false }),
            after: expect.objectContaining({ autoMergeConflicts: true }),
          },
        }),
      );
    });

    it('does NOT write an audit delta on a no-op autoMergeConflicts (same value true -> true)', async () => {
      const { svc, spaceRepo, auditService } = buildService({
        gitSync: { autoMergeConflicts: true },
      });

      await svc.updateSpace(
        { spaceId, autoMergeConflicts: true } as any,
        workspaceId,
      );

      expect(spaceRepo.updateGitSyncSettings).toHaveBeenCalledTimes(1);
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });
});
