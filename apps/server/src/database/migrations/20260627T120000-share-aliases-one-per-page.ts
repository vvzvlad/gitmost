import { type Kysely, sql } from 'kysely';

/**
 * Enforce "a page has EXACTLY ONE custom address" at the DB level. The original
 * `share_aliases` table only had a unique index on `(workspace_id, alias)`, so a
 * page could accumulate several alias rows (every slug edit used to INSERT a new
 * one), leaving orphan `/l/<old>` links live forever and making the share
 * modal's `findByPageId` lookup nondeterministic.
 *
 * We first dedup any pre-existing rows (keeping the NEWEST per page — the same
 * "current" choice the read path now makes), then add a PARTIAL unique index on
 * `(workspace_id, page_id)`. It is partial (`WHERE page_id IS NOT NULL`) so that
 * multiple DANGLING aliases (target page deleted -> `page_id` SET NULL) can
 * still coexist without colliding.
 *
 * ⚠️ IRREVERSIBLE DATA LOSS (intended): the dedup DELETE below permanently drops
 * every alias row but the newest per page. Those duplicates were live `/l/<old>`
 * pointers (resolved by name via `findByAliasAndWorkspace`, not by page), so
 * after this upgrade any such OLD vanity link starts returning the SPA 404. This
 * is the point — it kills the orphan rows the pre-invariant bug accumulated —
 * but `down()` only drops the unique index; it CANNOT restore the deleted rows.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Reap legacy duplicates: for each (workspace_id, page_id) keep only the row
  // with the greatest (created_at, id) — matches ShareAliasRepo.findByPageId.
  await sql`
    DELETE FROM share_aliases sa
    USING share_aliases keep
    WHERE sa.page_id IS NOT NULL
      AND sa.workspace_id = keep.workspace_id
      AND sa.page_id = keep.page_id
      AND (keep.created_at, keep.id) > (sa.created_at, sa.id)
  `.execute(db);

  await db.schema
    .createIndex('share_aliases_workspace_id_page_id_unique')
    .on('share_aliases')
    .columns(['workspace_id', 'page_id'])
    .unique()
    .where('page_id', 'is not', null)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('share_aliases_workspace_id_page_id_unique')
    .execute();
}
