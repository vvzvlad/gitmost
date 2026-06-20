import { WorkspaceService } from './workspace.service';

/**
 * Exercises the REAL WorkspaceService.update htmlEmbed-toggle persistence at the
 * service seam: an update carrying `htmlEmbed` must call
 * `workspaceRepo.updateSetting(workspaceId, 'htmlEmbed', value, trx)`, and an
 * update WITHOUT it must not touch that setting. The repo, db transaction, and
 * audit service are mocked; `executeTx` runs the callback against a fake trx.
 *
 * DEFERRED (DB-only): the "does not clobber sibling settings" guarantee is a
 * jsonb merge property of `updateSetting`'s SQL and needs a real Postgres to
 * assert. This spec only asserts the service-level CALL SHAPE.
 */
describe('WorkspaceService.update — htmlEmbed toggle persistence (real code)', () => {
  function buildService(opts: { settingsBefore?: Record<string, any> }) {
    const updateSetting = jest.fn().mockResolvedValue(undefined);
    const updateWorkspace = jest.fn().mockResolvedValue(undefined);
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
    );

    return { service, workspaceRepo, updateSetting, auditService };
  }

  it('persists htmlEmbed:true via updateSetting with the htmlEmbed key', async () => {
    const { service, updateSetting } = buildService({});

    await service.update('w1', { htmlEmbed: true } as any);

    expect(updateSetting).toHaveBeenCalledTimes(1);
    expect(updateSetting).toHaveBeenCalledWith(
      'w1',
      'htmlEmbed',
      true,
      expect.anything(), // the transaction handle
    );
  });

  it('persists htmlEmbed:false (explicit disable is not dropped)', async () => {
    const { service, updateSetting } = buildService({
      settingsBefore: { htmlEmbed: true },
    });

    await service.update('w1', { htmlEmbed: false } as any);

    expect(updateSetting).toHaveBeenCalledWith(
      'w1',
      'htmlEmbed',
      false,
      expect.anything(),
    );
  });

  it('does NOT call updateSetting when htmlEmbed is undefined in the dto', async () => {
    const { service, updateSetting } = buildService({});

    await service.update('w1', { name: 'New name' } as any);

    expect(updateSetting).not.toHaveBeenCalled();
  });

  it('audits the htmlEmbed change (before/after) when the value actually changes', async () => {
    const { service, auditService } = buildService({
      settingsBefore: { htmlEmbed: false },
    });

    await service.update('w1', { htmlEmbed: true } as any);

    expect(auditService.log).toHaveBeenCalledTimes(1);
    const logged = auditService.log.mock.calls[0][0];
    expect(logged.changes.before.htmlEmbed).toBe(false);
    expect(logged.changes.after.htmlEmbed).toBe(true);
  });
});
