import {
  Kysely,
  CamelCasePlugin,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  CompiledQuery,
} from 'kysely';
import { PageRepo } from './page.repo';
import type { KyselyDB } from '../../types/kysely.types';

/**
 * SQL-builder unit test for the git-sync provenance stamp on PageRepo's
 * soft-delete / restore paths (PR #119 review). Both `removePage` and
 * `restorePage` take an optional `lastUpdatedSource` arg and conditionally fold
 * it into the recursive-subtree `UPDATE pages SET ...` via
 * `...(lastUpdatedSource ? { lastUpdatedSource } : {})`. The change-listener
 * loop-guard reads `last_updated_source = 'git-sync'` to recognize git-sync's own
 * writes and skip the echo cycle; this test guards that the stamp is present when
 * the arg is supplied and ABSENT when it is omitted (an ordinary user delete must
 * not clobber the column).
 *
 * Harness: the same compile-only Kysely/DummyDriver pattern as
 * space.repo.spec.ts, plus the production `CamelCasePlugin` (so the compiled SQL
 * carries the real snake_case column names, e.g. `last_updated_source`) and a
 * thin driver that returns ONE fixed row for every query. The fixed row is what
 * lets the repo's guard reads (root snapshot / recursive descendants / restore
 * target) resolve non-empty so execution reaches the subtree UPDATE we assert on
 * — a bare DummyDriver returns no rows and both methods short-circuit before the
 * update. We never hit a real database; we capture each compiled statement via
 * Kysely's `log` hook and inspect the `update "pages" set ...` SQL.
 */
describe('PageRepo — git-sync provenance on soft-delete / restore SQL', () => {
  // A single row shaped to satisfy every column the repo reads off its guard
  // queries. `parentPageId: null` keeps restorePage on the simple path (no
  // parent-detach UPDATE), so the only `update "pages"` statement is the one we
  // assert on.
  const FIXED_ROW = {
    id: 'p1',
    slugId: 's1',
    title: 'Doc',
    icon: null,
    position: 'a0',
    spaceId: 'space-1',
    parentPageId: null,
    deletedAt: null,
  };

  class FixedRowDriver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return {
        async executeQuery() {
          return { rows: [{ ...FIXED_ROW }] };
        },
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        async *streamQuery() {},
      };
    }
  }

  interface Captured {
    sql: string;
    parameters: readonly unknown[];
  }

  // Compile-only Kysely on the Postgres dialect (CamelCasePlugin for real column
  // names) whose `log` hook records every executed statement's compiled SQL.
  function makeRepoCapturingSql() {
    const captured: Captured[] = [];
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new FixedRowDriver(),
        createIntrospector: (d) => new PostgresIntrospector(d),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      plugins: [new CamelCasePlugin()],
      log: (event) => {
        if (event.level === 'query') {
          const q = event.query as CompiledQuery;
          captured.push({ sql: q.sql, parameters: q.parameters });
        }
      },
    });

    const repo = new PageRepo(
      db as unknown as KyselyDB,
      {} as any,
      { emit: jest.fn() } as any,
    );
    // Find the single subtree UPDATE on pages (collapse whitespace for matching).
    const getUpdatePagesSql = (): Captured | undefined =>
      captured
        .map((c) => ({ ...c, sql: c.sql.replace(/\s+/g, ' ') }))
        .find((c) => /update "pages" set/i.test(c.sql));
    return { repo, getUpdatePagesSql };
  }

  describe('removePage', () => {
    it("stamps last_updated_source = 'git-sync' on the subtree soft-delete when the provenance arg is supplied", async () => {
      const { repo, getUpdatePagesSql } = makeRepoCapturingSql();

      // 4th arg is the optional caller transaction (existingTrx); the git-sync
      // provenance marker is the 5th arg.
      await repo.removePage('p1', 'user-1', 'ws-1', undefined, 'git-sync');

      const update = getUpdatePagesSql();
      expect(update).toBeDefined();
      // The provenance column is in the UPDATE's SET clause...
      expect(update!.sql).toContain('"last_updated_source" =');
      // ...with the 'git-sync' marker as the bound value.
      expect(update!.parameters).toContain('git-sync');
      // Sanity: it is still the soft-delete UPDATE (sets deleted_at too).
      expect(update!.sql).toContain('"deleted_at" =');
    });

    it('OMITS last_updated_source from the soft-delete when the provenance arg is undefined', async () => {
      const { repo, getUpdatePagesSql } = makeRepoCapturingSql();

      await repo.removePage('p1', 'user-1', 'ws-1');

      const update = getUpdatePagesSql();
      expect(update).toBeDefined();
      // Ordinary user delete: the column must NOT be touched (keeps prior value).
      expect(update!.sql).not.toContain('last_updated_source');
      expect(update!.parameters).not.toContain('git-sync');
      // It is still the soft-delete UPDATE.
      expect(update!.sql).toContain('"deleted_at" =');
    });
  });

  describe('restorePage', () => {
    it("stamps last_updated_source = 'git-sync' on the subtree restore when the provenance arg is supplied", async () => {
      const { repo, getUpdatePagesSql } = makeRepoCapturingSql();

      await repo.restorePage('p1', 'ws-1', 'git-sync');

      const update = getUpdatePagesSql();
      expect(update).toBeDefined();
      expect(update!.sql).toContain('"last_updated_source" =');
      expect(update!.parameters).toContain('git-sync');
      // Sanity: it is the restore UPDATE (clears deleted_at).
      expect(update!.sql).toContain('"deleted_at" =');
    });

    it('OMITS last_updated_source from the restore when the provenance arg is undefined', async () => {
      const { repo, getUpdatePagesSql } = makeRepoCapturingSql();

      await repo.restorePage('p1', 'ws-1');

      const update = getUpdatePagesSql();
      expect(update).toBeDefined();
      expect(update!.sql).not.toContain('last_updated_source');
      expect(update!.parameters).not.toContain('git-sync');
      expect(update!.sql).toContain('"deleted_at" =');
    });
  });
});
