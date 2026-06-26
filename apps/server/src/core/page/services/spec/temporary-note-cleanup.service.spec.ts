import { TemporaryNoteCleanupService } from '../temporary-note-cleanup.service';

/**
 * Chainable Kysely stub that records every `.where(...)` call so the test can
 * assert the sweep only selects armed, expired, not-yet-trashed notes. The
 * terminal `.execute()` resolves the configured expired rows (the batch SELECT);
 * `.executeTakeFirst()` resolves the per-row deadline re-read done just before
 * each `removePage`. By default the re-read reports the note as still armed and
 * still expired (epoch deadline < now), so the sweep proceeds to delete it;
 * tests override `reReadFirst` to simulate a concurrent "Make permanent".
 */
function makeDbStub(expiredRows: any[]) {
  const whereCalls: any[][] = [];
  const reReadFirst = jest
    .fn()
    .mockResolvedValue({ temporaryExpiresAt: new Date(0), deletedAt: null });
  const builder: any = {
    selectFrom: jest.fn(() => builder),
    select: jest.fn(() => builder),
    where: jest.fn((...args: any[]) => {
      whereCalls.push(args);
      return builder;
    }),
    limit: jest.fn(() => builder),
    execute: jest.fn().mockResolvedValue(expiredRows),
    executeTakeFirst: reReadFirst,
  };
  return { builder, whereCalls, reReadFirst };
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

  it('soft-deletes each expired note via removePage, attributed to its creator', async () => {
    const expired = [
      { id: 'p1', creatorId: 'u1', workspaceId: 'w1' },
      { id: 'p2', creatorId: 'u2', workspaceId: 'w1' },
    ];
    const { builder } = makeDbStub(expired);
    const pageRepo = { removePage: jest.fn().mockResolvedValue(undefined) } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();

    expect(pageRepo.removePage).toHaveBeenCalledTimes(2);
    expect(pageRepo.removePage).toHaveBeenNthCalledWith(1, 'p1', 'u1', 'w1');
    expect(pageRepo.removePage).toHaveBeenNthCalledWith(2, 'p2', 'u2', 'w1');
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
    expect(pageRepo.removePage).toHaveBeenNthCalledWith(2, 'good', 'u2', 'w1');
  });

  it('does NOT trash a note made permanent in the race window', async () => {
    // The batch SELECT saw the note as expired, but before its turn in the loop
    // the user clicked "Make permanent" (temporary_expires_at -> null). The
    // deadline re-read must catch this and skip the delete so the keep wins.
    const expired = [{ id: 'p1', creatorId: 'u1', workspaceId: 'w1' }];
    const { builder, reReadFirst } = makeDbStub(expired);
    reReadFirst.mockResolvedValueOnce({
      temporaryExpiresAt: null,
      deletedAt: null,
    });
    const pageRepo = { removePage: jest.fn() } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();

    expect(reReadFirst).toHaveBeenCalledTimes(1);
    expect(pageRepo.removePage).not.toHaveBeenCalled();
  });

  it('skips a note already trashed since the batch SELECT', async () => {
    const expired = [{ id: 'p1', creatorId: 'u1', workspaceId: 'w1' }];
    const { builder, reReadFirst } = makeDbStub(expired);
    reReadFirst.mockResolvedValueOnce({
      temporaryExpiresAt: new Date(0),
      deletedAt: new Date(),
    });
    const pageRepo = { removePage: jest.fn() } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();

    expect(pageRepo.removePage).not.toHaveBeenCalled();
  });

  it('does NOT trash a note re-armed to a future deadline in the race window', async () => {
    // The batch SELECT saw the note as expired, but before its turn in the loop
    // the user disarmed it and re-armed it to a fresh, still-future deadline
    // (temporary_expires_at -> now + 1h). The deadline re-read must catch that
    // the note is no longer expired and skip the delete so the keep wins.
    const expired = [{ id: 'p1', creatorId: 'u1', workspaceId: 'w1' }];
    const { builder, reReadFirst } = makeDbStub(expired);
    reReadFirst.mockResolvedValueOnce({
      temporaryExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      deletedAt: null,
    });
    const pageRepo = { removePage: jest.fn() } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();

    expect(reReadFirst).toHaveBeenCalledTimes(1);
    expect(pageRepo.removePage).not.toHaveBeenCalled();
  });

  it('does nothing when no notes are expired', async () => {
    const { builder } = makeDbStub([]);
    const pageRepo = { removePage: jest.fn() } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();
    expect(pageRepo.removePage).not.toHaveBeenCalled();
  });
});
