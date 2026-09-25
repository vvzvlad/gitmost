import { WorkspaceService } from './workspace.service';

/**
 * Exercises the REAL WorkspaceService.update treeQuickActions-toggle persistence
 * at the service seam: an update carrying `treeQuickActions` must call
 * `workspaceRepo.updateSetting(workspaceId, 'treeQuickActions', value, trx)`, an
 * update WITHOUT it must not touch that setting, and the DTO key must be deleted
 * before `updateWorkspace` runs (there is no `tree_quick_actions` COLUMN — it
 * lives inside the `settings` jsonb, so a leaked key makes Kysely write a
 * non-existent column at runtime).
 *
 * The repo, db transaction, and audit service are mocked; `executeTx` runs the
 * callback against a fake trx.
 */
describe('WorkspaceService.update — treeQuickActions toggle persistence (real code)', () => {
  function buildService(opts: { settingsBefore?: Record<string, any> }) {
    const updateSetting = jest.fn().mockResolvedValue(undefined);
    // Snapshot the dto keys AT CALL TIME: update() mutates the same dto object
    // in place, so inspecting the captured reference afterwards cannot tell a
    // before-call delete from an after-call one.
    const updateWorkspaceKeys: string[][] = [];
    const updateWorkspace = jest.fn(async (dto: any) => {
      updateWorkspaceKeys.push(Object.keys(dto));
      return undefined;
    });
    const workspaceRepo = {
      // First call: read settingsBefore. Second call: return the updated
      // workspace (must include a licenseKey because update() destructures it).
      findById: jest
        .fn()
        .mockResolvedValueOnce({ id: 'w1', settings: opts.settingsBefore ?? {} })
        .mockResolvedValueOnce({ id: 'w1', name: 'WS', licenseKey: null }),
      updateSetting,
      updateWorkspace,
    };

    // Fake kysely db: only .transaction().execute(cb) is used on this path.
    const db = {
      transaction: jest.fn(() => ({
        execute: jest.fn(async (cb: any) => cb({ __trx: true })),
      })),
    };

    const auditService = { log: jest.fn() };

    const service = new WorkspaceService(
      workspaceRepo as any, // workspaceRepo
      {} as any, // spaceService
      {} as any, // spaceMemberService
      {} as any, // groupRepo
      {} as any, // groupUserRepo
      {} as any, // userRepo
      {} as any, // environmentService
      {} as any, // domainService
      {} as any, // licenseCheckService
      {} as any, // shareRepo
      {} as any, // watcherRepo
      {} as any, // favoriteRepo
      db as any, // db (InjectKysely)
      {} as any, // attachmentQueue
      {} as any, // billingQueue
      {} as any, // aiQueue
      auditService as any, // auditService
      {} as any, // userSessionRepo
      {} as any, // mcpClients (#686)
    );

    return {
      service,
      workspaceRepo,
      updateSetting,
      updateWorkspaceKeys,
      auditService,
    };
  }

  it('persists treeQuickActions:true via updateSetting with the treeQuickActions key', async () => {
    const { service, updateSetting } = buildService({});

    await service.update('w1', { treeQuickActions: true } as any);

    expect(updateSetting).toHaveBeenCalledTimes(1);
    expect(updateSetting).toHaveBeenCalledWith(
      'w1',
      'treeQuickActions',
      true,
      expect.anything(), // the transaction handle
    );
  });

  it('persists treeQuickActions:false (explicit disable is not dropped)', async () => {
    // This is the load-bearing case: the toggle defaults to ON, so `false` is
    // the only value that changes anything and must never be treated as absent.
    const { service, updateSetting } = buildService({});

    await service.update('w1', { treeQuickActions: false } as any);

    expect(updateSetting).toHaveBeenCalledWith(
      'w1',
      'treeQuickActions',
      false,
      expect.anything(),
    );
  });

  it('does NOT call updateSetting when treeQuickActions is undefined in the dto', async () => {
    const { service, updateSetting } = buildService({});

    await service.update('w1', { name: 'New name' } as any);

    expect(updateSetting).not.toHaveBeenCalled();
  });

  it('deletes treeQuickActions from the dto BEFORE updateWorkspace runs', async () => {
    const { service, updateWorkspaceKeys } = buildService({});

    await service.update('w1', { treeQuickActions: false } as any);

    expect(updateWorkspaceKeys).toHaveLength(1);
    expect(updateWorkspaceKeys[0]).not.toContain('treeQuickActions');
  });
});
