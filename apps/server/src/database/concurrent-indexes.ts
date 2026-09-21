import { Kysely, sql } from 'kysely';

/**
 * Indexes that MUST be built with `CREATE INDEX CONCURRENTLY` so an auto-deploy
 * migration never takes a `SHARE` lock that blocks writes on a hot table
 * (`pages`) for the — potentially minutes-long — GIN trigram build (#495 item 12).
 *
 * Kysely runs each migration INSIDE a transaction (Postgres has transactional
 * DDL), and `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so
 * these cannot live in an ordinary migration. Instead {@link ensureConcurrentIndexes}
 * builds them out-of-band (no transaction) BEFORE the migrator runs; the matching
 * migrations keep a plain `CREATE INDEX IF NOT EXISTS` as a backstop, which then
 * no-ops because the index already exists. So:
 *   - existing prod DB, incremental deploy: the pre-build FIRST redefines
 *     `f_unaccent` to its index-inlinable 1-arg form (see below), THEN builds each
 *     index CONCURRENTLY (no write lock); the migration's IF NOT EXISTS no-ops →
 *     the write-blocking build is gone;
 *   - fresh DB (or a DB whose `pages` / `unaccent` extension does not exist yet):
 *     the pre-build fails and is swallowed (best-effort), and the migration builds
 *     the index normally on an empty/small table where the lock is irrelevant.
 *
 * NOT a strict "worst case = previous behaviour":
 *   - The f_unaccent form matters. The trigram expressions use `LOWER(f_unaccent(col))`.
 *     The INDEX-INLINABLE 1-arg `f_unaccent(text)` (`SELECT public.unaccent($1)`)
 *     is created INSIDE migration 20260705, which runs AFTER this pre-build. On an
 *     existing tenant the live `f_unaccent` is still the OLD 2-arg form from
 *     20250729, which Postgres CANNOT inline into a CONCURRENTLY index expression
 *     (`function unaccent(unknown, text) does not exist ... during inlining`) — the
 *     build fails outright. So this pre-build redefines `f_unaccent` to the 1-arg
 *     form FIRST (idempotent, output-identical, in lockstep with 20260705). Without
 *     that redefine the whole feature is dead-on-arrival for the very case it
 *     targets.
 *   - An INTERRUPTED `CREATE INDEX CONCURRENTLY` (killed pod, cancelled query) with
 *     a working `f_unaccent` leaves an INVALID index behind. A subsequent name-based
 *     `IF NOT EXISTS` — in BOTH this pre-build and the migration backstop — sees the
 *     name and skips, so the invalid index is NEVER repaired automatically and the
 *     query keeps seq-scanning until an operator `DROP INDEX`es it. The old
 *     in-transaction build could not leave an invalid index (a failed tx rolled the
 *     whole index back), so this is a genuinely new failure mode, not "= previous".
 *     (A future hardening could `DROP` an `indisvalid = false` index before
 *     rebuilding; not done here.)
 *
 * The `create` text is the CANONICAL definition — it MUST match the migration's
 * `IF NOT EXISTS` create expression exactly (same functional expression + opclass)
 * or Postgres would treat them as two different indexes.
 */
export const CONCURRENT_INDEXES: ReadonlyArray<{
  name: string;
  create: string;
}> = [
  {
    // #348 perf-indexes — pages.title trigram (coalesce-free functional expr).
    name: 'idx_pages_title_trgm',
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_title_trgm ' +
      'ON pages USING gin ((LOWER(f_unaccent(title))) gin_trgm_ops)',
  },
  {
    // #348 perf-indexes — users.name trigram (member search-suggest).
    name: 'idx_users_name_trgm',
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_name_trgm ' +
      'ON users USING gin ((LOWER(f_unaccent(name))) gin_trgm_ops)',
  },
  {
    // #443 search-lookup-trgm — pages.text_content trigram (the slow, large one).
    name: 'idx_pages_text_content_trgm',
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_text_content_trgm ' +
      'ON pages USING gin ((LOWER(f_unaccent(text_content))) gin_trgm_ops)',
  },
];

/**
 * Idempotent, output-identical redefinition of `f_unaccent` to the INDEX-INLINABLE
 * 1-arg form. MUST stay byte-for-byte in lockstep with migration
 * `20260705T120000-perf-indexes.ts` (same signature + body): the trigram indexes
 * above only build CONCURRENTLY once `f_unaccent(text)` inlines, and on an existing
 * tenant it is still the old 2-arg form until that migration runs — which is AFTER
 * this pre-build.
 */
const F_UNACCENT_REDEF = `
    CREATE OR REPLACE FUNCTION f_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE PARALLEL SAFE STRICT
    AS $func$
      SELECT public.unaccent($1);
    $func$
`;

/**
 * Best-effort, non-transactional pre-build of {@link CONCURRENT_INDEXES}. Run
 * BEFORE the migrator so the blocking `CREATE INDEX` in the corresponding
 * migration becomes an `IF NOT EXISTS` no-op.
 *
 * `db` MUST be the top-level Kysely instance (NOT a transaction): each statement
 * then executes on its own connection with no surrounding `BEGIN`, which is
 * required for `CONCURRENTLY`. Every statement is independent and swallowed on
 * error: the migration backstop still builds the index, so a failure here is
 * never fatal. `onLog` reports progress/failures for the caller to route to its
 * logger.
 *
 * ORDER MATTERS: redefine `f_unaccent` to the inlinable form BEFORE the index
 * loop — otherwise an existing tenant's old 2-arg `f_unaccent` makes every
 * CONCURRENTLY build fail and the feature is a no-op (see the module docstring).
 */
export async function ensureConcurrentIndexes(
  db: Kysely<any>,
  onLog?: (message: string, error?: unknown) => void,
): Promise<void> {
  // Make f_unaccent inlinable FIRST. On a fresh DB (no `unaccent` extension yet)
  // this throws harmlessly and is swallowed — the migration builds everything.
  try {
    await sql.raw(F_UNACCENT_REDEF).execute(db);
    onLog?.('f_unaccent redefined to the index-inlinable 1-arg form');
  } catch (error) {
    onLog?.(
      'f_unaccent redefine skipped (fresh DB / no unaccent extension) — ' +
        'the migration will define it and build the indexes',
      error,
    );
  }

  for (const idx of CONCURRENT_INDEXES) {
    try {
      await sql.raw(idx.create).execute(db);
      onLog?.(`Concurrent index ensured: ${idx.name}`);
    } catch (error) {
      // Non-fatal by design — the migration's IF NOT EXISTS create is the
      // backstop. Benign on a fresh DB (the table/extension does not exist yet).
      // NOT benign, but still swallowed, on an existing tenant whose f_unaccent
      // could not be redefined above (then the migration builds the index NON-
      // concurrently under the SHARE lock this feature meant to avoid).
      onLog?.(
        `Concurrent index pre-build skipped for ${idx.name} ` +
          `(will fall back to the in-migration build)`,
        error,
      );
    }
  }
}
