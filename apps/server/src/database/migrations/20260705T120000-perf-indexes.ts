import { type Kysely, sql } from 'kysely';

/**
 * #348 — targeted hot-path indexes.
 *
 * 1. GIN trigram indexes for `/search/suggest`. That endpoint runs a
 *    leading-wildcard `LOWER(f_unaccent(col)) LIKE '%q%'` per keystroke, which
 *    is a sequential scan without a trigram index. The index EXPRESSIONS below
 *    are `LOWER(f_unaccent(title|name))`, matching the predicates in
 *    search.service.ts exactly so the planner uses them (verified with EXPLAIN:
 *    the suggest predicate resolves to a Bitmap Index Scan on these indexes).
 *
 *    IMMUTABLE-wrapper fix (required for the index to build): `f_unaccent` was
 *    defined as `SELECT unaccent('unaccent', $1)` (the two-arg, dictionary-named
 *    unaccent). That body CANNOT be used in an index expression: when Postgres
 *    inlines the IMMUTABLE SQL wrapper while building the index it fails to
 *    resolve the two-arg call (`function unaccent(unknown, text) does not exist`,
 *    the `'unaccent'` literal loses its regdictionary coercion). The single-arg
 *    `unaccent($1)` is the same operation (the default text-search dictionary IS
 *    `unaccent`; verified byte-equal on accented samples), and — crucially —
 *    SCHEMA-QUALIFIED as `public.unaccent($1)` it inlines cleanly, so the index
 *    builds. We therefore `CREATE OR REPLACE` `f_unaccent` to the qualified
 *    single-arg body. This is output-identical for every existing caller (the
 *    tsvector trigger, the main `tsv @@` search, and the suggest LIKE), so no
 *    reindex/backfill is needed; `down()` restores the original two-arg body.
 *    (The `unaccent` extension is installed in `public` in this codebase, which
 *    is why `public.unaccent` is the correct qualification.)
 *
 * 2. Composite indexes for two ORDER-BY-only-on-id queries that currently sort
 *    on top of a created_at index:
 *    - page_history: `findPageHistoryByPageId` does WHERE page_id ORDER BY id
 *      DESC, but only `(page_id, created_at DESC)` exists → extra sort.
 *    - comments: `findPageComments` does WHERE page_id ORDER BY id ASC, but only
 *      `(page_id)` exists → extra sort.
 *
 * DEPLOY-TIME LOCK: these are plain (non-CONCURRENT) CREATE INDEX statements —
 * CONCURRENTLY is impossible HERE because Kysely runs each migration in a
 * transaction. The two GIN trigram builds on pages.title / users.name are the
 * slow ones and would take a SHARE lock that BLOCKS writes on pages/users for
 * minutes on a large tenant. To avoid that, `ensureConcurrentIndexes`
 * (database/concurrent-indexes.ts) now pre-builds BOTH trigram indexes with
 * CREATE INDEX CONCURRENTLY (no transaction) BEFORE the migrator runs, so on an
 * existing DB the two `IF NOT EXISTS` trigram creates below no-op and no write
 * lock is taken. On a fresh DB the pre-build is skipped and they build on an
 * empty table. Keep the two trigram creates in lockstep with their CANONICAL
 * definitions in CONCURRENT_INDEXES. (The plain b-tree indexes further down are
 * fast metadata-only builds; they are not pre-built.)
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Index-compatible, output-identical redefinition of f_unaccent (see header).
  await sql`
    CREATE OR REPLACE FUNCTION f_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE PARALLEL SAFE STRICT
    AS $func$
      SELECT public.unaccent($1);
    $func$
  `.execute(db);

  // Search-suggest trigram indexes. Expressions match search.service.ts.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pages_title_trgm
      ON pages USING gin ((LOWER(f_unaccent(title))) gin_trgm_ops)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_name_trgm
      ON users USING gin ((LOWER(f_unaccent(name))) gin_trgm_ops)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_groups_name_trgm
      ON groups USING gin ((LOWER(f_unaccent(name))) gin_trgm_ops)
  `.execute(db);

  // page_history: WHERE page_id ORDER BY id DESC (findPageHistoryByPageId).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_history_page_id
      ON page_history (page_id, id DESC)
  `.execute(db);

  // comments: WHERE page_id ORDER BY id ASC (findPageComments).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_comments_page_id_id
      ON comments (page_id, id)
  `.execute(db);

  // page_access(workspace_id): #348 made hasRestrictedPagesInWorkspace uncached
  // (F1 fix), so `EXISTS(SELECT 1 FROM page_access WHERE workspace_id=?)` now runs
  // per-request on every whole-workspace list endpoint (global search + suggest,
  // favorites, notifications, recent, created-by). page_access only had a
  // space_id index → that EXISTS was a seq scan in the common zero-restriction
  // case. This index makes it an index-only existence probe.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_access_workspace_id
      ON page_access (workspace_id)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Drop the expression indexes before restoring the function body.
  await sql`DROP INDEX IF EXISTS idx_pages_title_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_users_name_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_groups_name_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_page_history_page_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_comments_page_id_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_page_access_workspace_id`.execute(db);

  // Restore the original two-arg (dictionary-named) f_unaccent body.
  await sql`
    CREATE OR REPLACE FUNCTION f_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE PARALLEL SAFE STRICT
    AS $func$
      SELECT unaccent('unaccent', $1);
    $func$
  `.execute(db);
}
