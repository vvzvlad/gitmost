import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // A catalog-imported role is uniquely identified within a workspace by its
  // `source.slug` + `source.language` (a multilingual catalog: the `ru` variant
  // of a slug installed as `en` is a SEPARATE install — hence both keys). The
  // import path skips a slug+language already installed using an in-memory
  // snapshot (installedKeys), but two CONCURRENT imports of the same bundle each
  // read a stale snapshot and would both insert the same slug+language,
  // duplicating the role. This partial unique index is the database-level
  // backstop: the second insert gets a 23505 the service treats as
  // "already installed" (skip), so the two imports converge on ONE role.
  //
  // Partial on `source IS NOT NULL` so MANUALLY-created roles (source NULL) are
  // unconstrained — there can be many of those. Also partial on
  // `deleted_at IS NULL` (like the existing name-unique index) so a soft-deleted
  // role does not block re-importing the same slug+language later, matching the
  // app's snapshot (listByWorkspace filters out soft-deleted rows).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_roles_workspace_source_unique
    ON ai_agent_roles (workspace_id, (source ->> 'slug'), (source ->> 'language'))
    WHERE source IS NOT NULL AND deleted_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('ai_agent_roles_workspace_source_unique')
    .ifExists()
    .execute();
}
