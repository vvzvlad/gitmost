import { executeTx, registerAfterCommit } from './utils';
import { KyselyDB, KyselyTransaction } from './types/kysely.types';

// Post-commit hook contract (#495 item 13): a side effect registered via
// registerAfterCommit must run ONLY AFTER the owning transaction commits, and a
// hook registered against a passed-through existingTrx must fire at the OUTER
// commit boundary — never inside the inner call. We fake the Kysely transaction
// runner so the ordering is observable without a real DB.

/**
 * A minimal db whose `.transaction().execute(cb)` records the commit ORDER: it
 * runs `cb(trx)`, pushes 'commit' onto `log` (simulating the real commit that
 * happens after the callback resolves), then returns the callback's result.
 */
function fakeDb(log: string[]): { db: KyselyDB; trx: KyselyTransaction } {
  const trx = { __fakeTrx: true } as unknown as KyselyTransaction;
  const db = {
    transaction: () => ({
      execute: async (cb: (t: KyselyTransaction) => Promise<unknown>) => {
        const result = await cb(trx);
        log.push('commit');
        return result;
      },
    }),
  } as unknown as KyselyDB;
  return { db, trx };
}

describe('executeTx post-commit hooks', () => {
  it('runs an afterCommit hook only AFTER the transaction commits', async () => {
    const log: string[] = [];
    const { db } = fakeDb(log);

    await executeTx(db, async (trx) => {
      log.push('body');
      registerAfterCommit(trx, () => {
        log.push('hook');
      });
      // The hook must NOT have run yet — the tx is still open.
      expect(log).toEqual(['body']);
    });

    // Order proves post-commit: body → commit → hook (never body → hook → commit).
    expect(log).toEqual(['body', 'commit', 'hook']);
  });

  it('drains hooks registered against a passed-through existingTrx at the OUTER commit', async () => {
    const log: string[] = [];
    const { db, trx: outerTrx } = fakeDb(log);

    await executeTx(db, async (outer) => {
      // Nested executeTx reuses the outer trx: it must NOT commit or drain now.
      await executeTx(
        db,
        async (inner) => {
          registerAfterCommit(inner, () => {
            log.push('inner-hook');
          });
        },
        outer,
      );
      // Still inside the outer tx — the inner hook has not fired.
      expect(log).toEqual([]);
    });

    // The single (outer) commit drains the hook registered on the shared trx.
    expect(log).toEqual(['commit', 'inner-hook']);
    // Sanity: the trx the hooks were registered against is the outer one.
    expect(outerTrx).toBeDefined();
  });

  it('a hook failure does not reject the already-committed executeTx', async () => {
    const log: string[] = [];
    const { db } = fakeDb(log);

    await expect(
      executeTx(db, async (trx) => {
        registerAfterCommit(trx, () => {
          throw new Error('cache del blew up');
        });
        registerAfterCommit(trx, () => {
          log.push('second-hook-still-runs');
        });
        return 'ok';
      }),
    ).resolves.toBe('ok');

    // The throwing hook is swallowed; a later hook still runs.
    expect(log).toEqual(['commit', 'second-hook-still-runs']);
  });

  it('does NOT run afterCommit hooks when the transaction body throws (rollback)', async () => {
    // The body rejects -> the fake transaction never pushes 'commit' and
    // db.transaction().execute() rejects, mirroring a real rolled-back tx. The
    // drain runs only AFTER the awaited (committed) transaction, so a rollback
    // must leave every registered hook UN-run — otherwise a cache-bust / event
    // would fire for a write that never landed.
    const log: string[] = [];
    const { db } = fakeDb(log);
    const hook = jest.fn();

    await expect(
      executeTx(db, async (trx) => {
        registerAfterCommit(trx, hook);
        throw new Error('write failed -> rollback');
      }),
    ).rejects.toThrow('write failed -> rollback');

    // No commit happened, and the post-commit hook never ran.
    expect(log).toEqual([]); // no 'commit'
    expect(hook).not.toHaveBeenCalled();
  });
});
