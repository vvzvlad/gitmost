import { AiChatRunRepo, SWEEP_RUN_STALE_MS } from './ai-chat-run.repo';
import type { KyselyDB } from '../../types/kysely.types';

/**
 * Unit coverage for AiChatRunRepo.sweepRunning over a chainable builder mock (no
 * live DB). The F1 invariant under test (DECISION C): the BOOT sweep is
 * UNCONDITIONAL — it adds NO `updatedAt <` predicate, so a fresh 'running' run
 * (updatedAt = now) IS settled rather than skipped by a staleness window. The
 * window is added ONLY when an explicit `staleMs` is supplied (the future phase-2
 * multi-instance timer sweep). We assert the EXACT predicates the spec mandates.
 */
describe('AiChatRunRepo.sweepRunning', () => {
  type Recorded = {
    table?: string;
    set?: Record<string, unknown>;
    wheres: Array<[string, string, unknown]>;
    returning?: string;
  };

  function makeDb(swept: Array<{ id: string }>): {
    db: KyselyDB;
    rec: Recorded;
  } {
    const rec: Recorded = { wheres: [] };
    const builder: Record<string, unknown> = {};
    builder.set = (v: Record<string, unknown>) => {
      rec.set = v;
      return builder;
    };
    builder.where = (col: string, op: string, val: unknown) => {
      rec.wheres.push([col, op, val]);
      return builder;
    };
    builder.returning = (col: string) => {
      rec.returning = col;
      return builder;
    };
    builder.execute = () => Promise.resolve(swept);
    const db = {
      updateTable: (table: string) => {
        rec.table = table;
        return builder;
      },
    } as unknown as KyselyDB;
    return { db, rec };
  }

  it('F1: the boot sweep (no staleMs) is UNCONDITIONAL — only a status filter, NO updatedAt window', async () => {
    const { db, rec } = makeDb([{ id: 'r1' }, { id: 'r2' }]);
    const repo = new AiChatRunRepo(db);

    const swept = await repo.sweepRunning();

    expect(swept).toBe(2);
    expect(rec.table).toBe('aiChatRuns');
    // The status filter is always present...
    expect(rec.wheres).toContainEqual([
      'status',
      'in',
      expect.arrayContaining(['pending', 'running']),
    ]);
    // ...but a fresh 'running' run (updatedAt = now) must NOT be skipped: no
    // updatedAt predicate at all on the boot path.
    expect(rec.wheres.some(([col]) => col === 'updatedAt')).toBe(false);
    // It flips to 'aborted' and stamps finishedAt + updatedAt. #491: the stamps
    // are now DB-clock `sql now()` expressions (raw builders), NOT app-clock
    // `new Date()`, so the run row shares the delta poll's single now() cursor axis
    // — assert they are present and are the sql raw-builder objects (not a Date,
    // not undefined).
    expect(rec.set?.status).toBe('aborted');
    for (const stamp of ['finishedAt', 'updatedAt'] as const) {
      expect(rec.set?.[stamp]).toBeDefined();
      expect(rec.set?.[stamp]).not.toBeInstanceOf(Date);
      expect(typeof rec.set?.[stamp]).toBe('object');
    }
  });

  it('phase-2 path: an explicit staleMs reintroduces the updatedAt window', async () => {
    const { db, rec } = makeDb([]);
    const repo = new AiChatRunRepo(db);

    await repo.sweepRunning({ staleMs: SWEEP_RUN_STALE_MS });

    const updatedAtWhere = rec.wheres.find(([col]) => col === 'updatedAt');
    expect(updatedAtWhere).toBeDefined();
    expect(updatedAtWhere![1]).toBe('<');
    expect(updatedAtWhere![2]).toBeInstanceOf(Date);
  });
});
