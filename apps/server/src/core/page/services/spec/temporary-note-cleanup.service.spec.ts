import { TemporaryNoteCleanupService } from '../temporary-note-cleanup.service';

/**
 * Chainable Kysely stub that records every `.where(...)` call so the test can
 * assert the sweep only selects armed, expired, not-yet-trashed notes. The
 * terminal `.execute()` resolves the configured expired rows.
 */
function makeDbStub(expiredRows: any[]) {
  const whereCalls: any[][] = [];
  const builder: any = {
    selectFrom: jest.fn(() => builder),
    select: jest.fn(() => builder),
    where: jest.fn((...args: any[]) => {
      whereCalls.push(args);
      return builder;
    }),
    execute: jest.fn().mockResolvedValue(expiredRows),
  };
  return { builder, whereCalls };
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

  it('does nothing when no notes are expired', async () => {
    const { builder } = makeDbStub([]);
    const pageRepo = { removePage: jest.fn() } as any;
    const service = new TemporaryNoteCleanupService(builder, pageRepo);

    await service.sweepExpiredTemporaryNotes();
    expect(pageRepo.removePage).not.toHaveBeenCalled();
  });
});
