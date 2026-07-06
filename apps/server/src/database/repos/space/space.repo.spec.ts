import {
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  CompiledQuery,
} from 'kysely';
import { SpaceRepo } from './space.repo';
import type { KyselyDB } from '../../types/kysely.types';

/**
 * SQL-builder unit test for the jsonb-merge invariant of
 * SpaceRepo.updateGitSyncSettings (review comment #694 / test-strategy item #6).
 *
 * The merge is RAW SQL, so a behavioural test would need a live Postgres — which
 * is intentionally out of scope here (the reviewer's own §13.3 was deferred for
 * the same reason). Instead we follow the existing repo-spec convention
 * (ai-agent-roles.repo.spec.ts) of NOT executing: we compile the query with a
 * DummyDriver Postgres dialect and assert the generated SQL preserves sibling
 * keys. The structural invariant the SQL must encode:
 *
 *   settings  := COALESCE(settings, '{}') || jsonb_build_object('gitSync', ...)
 *   gitSync   := COALESCE(settings->'gitSync', '{}') || jsonb_build_object(key, value)
 *
 * The OUTER `||` merges into the existing top-level `settings`, so a sibling
 * top-level key (e.g. `sharing`) is preserved. The INNER COALESCE merges into
 * the existing `gitSync` object, so a sibling key inside gitSync (e.g. `other`)
 * is preserved. A naive `set settings = jsonb_build_object('gitSync', ...)`
 * would clobber both — this test guards exactly that regression.
 */
describe('SpaceRepo.updateGitSyncSettings — jsonb merge SQL', () => {
  // A real Kysely on the Postgres dialect, but with a DummyDriver: it compiles
  // queries to real Postgres SQL without ever opening a connection.
  function makeCompileOnlyDb() {
    return new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
  }

  // Build the repo over the compile-only db. The repo terminates the query with
  // `.executeTakeFirst()`, so we wrap every kysely builder in a Proxy: when the
  // repo finally calls `executeTakeFirst`, we `.compile()` that same builder
  // ourselves to capture the exact SQL it was about to run, then delegate.
  function makeRepoCapturingSql() {
    const db = makeCompileOnlyDb();
    let captured: CompiledQuery | undefined;

    // kysely builders are immutable — each .set()/.where()/.returningAll()
    // returns a NEW builder — so re-wrap any chainable result.
    const wrap = (b: any): any =>
      new Proxy(b, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          return (...callArgs: unknown[]) => {
            // Capture the SQL at the terminal execute call.
            if (
              (prop === 'executeTakeFirst' || prop === 'execute') &&
              typeof target.compile === 'function'
            ) {
              captured = target.compile();
            }
            const result = value.apply(target, callArgs);
            if (
              result &&
              typeof result === 'object' &&
              typeof (result as any).compile === 'function'
            ) {
              return wrap(result);
            }
            return result;
          };
        },
      });

    const originalUpdateTable = db.updateTable.bind(db);
    jest
      .spyOn(db, 'updateTable')
      .mockImplementation((...args: Parameters<typeof originalUpdateTable>) =>
        wrap(originalUpdateTable(...args)),
      );

    const repo = new SpaceRepo(db as unknown as KyselyDB, {} as any);
    return { repo, getCaptured: () => captured };
  }

  it("compiles a jsonb merge that preserves sibling top-level and gitSync keys", async () => {
    const { repo, getCaptured } = makeRepoCapturingSql();

    // DummyDriver yields no rows; executeTakeFirst resolves to undefined. The
    // SQL is fully compiled by then, which is all we assert.
    await repo.updateGitSyncSettings('space-1', 'ws-1', 'enabled', true);

    const compiled = getCaptured();
    expect(compiled).toBeDefined();
    // The raw SQL template carries newlines/indentation; collapse whitespace so
    // the structural assertions are not coupled to source formatting.
    const sql = compiled!.sql.replace(/\s+/g, ' ');

    // OUTER merge into the existing settings object -> sibling top-level keys
    // (e.g. `sharing`) survive (NOT a bare jsonb_build_object assignment).
    expect(sql).toContain(`set "settings" = COALESCE(settings, '{}'::jsonb) ||`);
    // INNER merge into the existing gitSync object -> sibling gitSync keys
    // (e.g. `other`) survive.
    expect(sql).toContain(
      `jsonb_build_object('gitSync', COALESCE(settings->'gitSync', '{}'::jsonb) ||`,
    );
    // The pref key is set via jsonb_build_object on the inner object, with the
    // key as a BOUND, ::text-cast PARAMETER (not sql.raw) — security fix #5.
    expect(sql).toMatch(/jsonb_build_object\(\$\d+::text,/);
    // Scoped to the row + workspace.
    expect(sql).toContain(`where "id" =`);
    expect(sql).toContain(`and "workspaceId" =`);

    // Sanity: this is NOT a clobbering assignment (no top-level
    // `set "settings" = jsonb_build_object(` without the COALESCE/merge).
    expect(sql).not.toContain(`set "settings" = jsonb_build_object(`);

    // The pref VALUE stays inlined via sql.lit, but the KEY is now a bound
    // parameter, so id + workspaceId + the key are all bound (updatedAt is a Date).
    expect(compiled!.parameters).toContain('space-1');
    expect(compiled!.parameters).toContain('ws-1');
    expect(compiled!.parameters).toContain('enabled');
  });

  it('binds the prefKey as a ::text parameter (no sql.raw splice) and inlines prefValue via sql.lit', async () => {
    const { repo, getCaptured } = makeRepoCapturingSql();

    await repo.updateGitSyncSettings('space-1', 'ws-1', 'enabled', false);

    const compiled = getCaptured()!;
    const sql = compiled.sql.replace(/\s+/g, ' ');
    // The key is a bound `$N::text` parameter; the value is the sql.lit literal.
    expect(sql).toMatch(/jsonb_build_object\(\$\d+::text, false\)/);
    // The literal key must NOT be spliced into the statement text (the footgun).
    expect(sql).not.toContain(`'enabled'`);
    // The key rides as a bound parameter instead.
    expect(compiled.parameters).toContain('enabled');
  });
});
