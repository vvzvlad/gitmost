import { TemporaryNoteCleanupService } from '../temporary-note-cleanup.service';

/**
 * Chainable Kysely stub for the temporary-note sweep.
 *
 * `this.db` serves the non-locking candidate SELECT (selectFrom/select/where/
 * limit/execute -> the configured expired rows) AND `.transaction().execute(cb)`,
 * which runs `cb` with a separate `trx` builder. The `trx` builder serves the
 * per-row LOCKED re-check (selectFrom/select/where/forUpdate/skipLocked/
 * executeTakeFirst). `lockedRows` drives what that locked re-check returns per
 * candidate — an id/creator/workspace row means "still expired, delete it";
 * `undefined` means the predicate no longer matched (made permanent / re-armed /
 * already trashed) or the row was SKIP-LOCKED by another worker, so it is skipped.
 */
function makeDbStub(expiredRows: any[], lockedRows?: any[]) {
  const whereCalls: any[][] = [];
  const locked = [
    ...(lockedRows ??
      expiredRows.map((r) => ({
        id: r.id,
        creatorId: r.creatorId,
        workspaceId: r.workspaceId,
      }))),
  ];
  const lockedTakeFirst = jest.fn(() => Promise.resolve(locked.shift()));
  const forUpdate = jest.fn(() => trxBuilder);
  const skipLocked = jest.fn(() => trxBuilder);
  const trxBuilder: any = {
    selectFrom: jest.fn(() => trxBuilder),
    select: jest.fn(() => trxBuilder),
    where: jest.fn(() => trxBuilder),
    forUpdate,
    skipLocked,
    executeTakeFirst: lockedTakeFirst,
  };
  const builder: any = {
    selectFrom: jest.fn(() => builder),
    select: jest.fn(() => builder),
    where: jest.fn((...args: any[]) => {
      whereCalls.push(args);
      return builder;
    }),
    limit: jest.fn(() => builder),
    execute: jest.fn().mockResolvedValue(expiredRows),
    transaction: jest.fn(() => ({
      execute: (cb: (trx: any) => Promise<any>) => Promise.resolve(cb(trxBuilder)),
    })),
  };
  return { builder, whereCalls, lockedTakeFirst, forUpdate, skipLocked };
}

describe('TemporaryNoteCleanupService.sweepExpiredTemporaryNotes', () => {
  it('selects only armed, expired, not-yet-trashed notes', async () => {
    const { builder, whereCalls } = makeDbStub([]);
    const pageRepo = { removePage: jest.fn() } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();

    // temporaryExpiresAt IS NOT NULL, temporaryExpiresAt < now, deletedAt IS NULL
    const cols = whereCalls.map((c) => c[0]);
    const ops = whereCalls.map((c) => c[1]);
    expect(cols).toEqual([
      'temporaryExpiresAt',
      'temporaryExpiresAt',
      'deletedAt',
    ]);
    expect(ops).toEqual(['is not', '<', 'is']);
    // last operand is the trash filter -> null
    expect(whereCalls[2][2]).toBeNull();
    // The batch SELECT is capped so a large backlog is not pulled at once.
    expect(builder.limit).toHaveBeenCalledTimes(1);
    expect(builder.limit.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it('soft-deletes each expired note via removePage under a row lock, attributed to its creator', async () => {
    const expired = [
      { id: 'p1', creatorId: 'u1', workspaceId: 'w1' },
      { id: 'p2', creatorId: 'u2', workspaceId: 'w1' },
    ];
    const { builder, forUpdate, skipLocked } = makeDbStub(expired);
    const pageRepo = { removePage: jest.fn().mockResolvedValue(undefined) } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();

    expect(pageRepo.removePage).toHaveBeenCalledTimes(2);
    // The 4th arg is the locking transaction — the delete runs inside it.
    expect(pageRepo.removePage).toHaveBeenNthCalledWith(
      1,
      'p1',
      'u1',
      'w1',
      expect.anything(),
    );
    expect(pageRepo.removePage).toHaveBeenNthCalledWith(
      2,
      'p2',
      'u2',
      'w1',
      expect.anything(),
    );
    // The re-check acquired a FOR UPDATE SKIP LOCKED lock (once per candidate).
    expect(forUpdate).toHaveBeenCalledTimes(2);
    expect(skipLocked).toHaveBeenCalledTimes(2);
  });

  it('continues past a failing note (one bad removePage does not abort the sweep)', async () => {
    const expired = [
      { id: 'bad', creatorId: 'u1', workspaceId: 'w1' },
      { id: 'good', creatorId: 'u2', workspaceId: 'w1' },
    ];
    const { builder } = makeDbStub(expired);
    const pageRepo = {
      removePage: jest
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined),
    } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await expect(
      service.sweepExpiredTemporaryNotes(),
    ).resolves.toBeUndefined();
    expect(pageRepo.removePage).toHaveBeenCalledTimes(2);
    expect(pageRepo.removePage).toHaveBeenNthCalledWith(
      2,
      'good',
      'u2',
      'w1',
      expect.anything(),
    );
  });

  it('does NOT trash a note made permanent / re-armed / already trashed (locked re-check returns nothing)', async () => {
    // The batch SELECT saw the note as expired, but by the time the LOCKED
    // re-check runs the row no longer matches the still-armed+expired+not-trashed
    // predicate (make-permanent, re-arm to a future deadline, or already trashed),
    // OR another worker holds the row (SKIP LOCKED). In every case the locked
    // SELECT returns nothing and the delete is skipped so the keep/other worker wins.
    const expired = [{ id: 'p1', creatorId: 'u1', workspaceId: 'w1' }];
    const { builder, lockedTakeFirst } = makeDbStub(expired, [undefined]);
    const pageRepo = { removePage: jest.fn() } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();

    expect(lockedTakeFirst).toHaveBeenCalledTimes(1);
    expect(pageRepo.removePage).not.toHaveBeenCalled();
  });

  it('does nothing when no notes are expired', async () => {
    const { builder } = makeDbStub([]);
    const pageRepo = { removePage: jest.fn() } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();
    expect(pageRepo.removePage).not.toHaveBeenCalled();
  });

  it('sweeps once on application bootstrap (catches notes expired during downtime)', async () => {
    const expired = [{ id: 'p1', creatorId: 'u1', workspaceId: 'w1' }];
    const { builder } = makeDbStub(expired);
    const pageRepo = { removePage: jest.fn().mockResolvedValue(undefined) } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.onApplicationBootstrap();

    expect(pageRepo.removePage).toHaveBeenCalledTimes(1);
    expect(pageRepo.removePage).toHaveBeenCalledWith(
      'p1',
      'u1',
      'w1',
      expect.anything(),
    );
  });

  it('a startup-sweep failure never blocks application boot', async () => {
    const { builder } = makeDbStub([]);
    // Make the candidate SELECT throw to simulate a boot-time DB hiccup.
    builder.execute.mockRejectedValueOnce(new Error('db not ready'));
    const pageRepo = { removePage: jest.fn() } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
