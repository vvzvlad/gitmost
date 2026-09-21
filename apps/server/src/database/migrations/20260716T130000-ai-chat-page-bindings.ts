import { type Kysely, sql } from 'kysely';

/**
 * The MUTABLE page->chat binding (#665): "for THIS user, on THIS page, this is
 * the chat that opens." Distinct from `ai_chats.page_id`, which stays IMMUTABLE
 * provenance (where a chat was BORN — it also feeds the history-row "· PageTitle"
 * join). This table is the STATE the header button reads and that the history
 * select / "New chat" / first-message writers mutate. Absence of a row == "nothing
 * bound" == an empty chat opens. #191 named exactly this mechanism and deferred it.
 *
 * Surrogate `id` + UNIQUE(user_id, page_id) (not a composite PK): a surrogate key
 * is the 100% repo convention (~20 tables); the unique constraint holds the 1:1
 * invariant and ON CONFLICT (user_id, page_id) works with it identically.
 *
 * Explicit indexes on page_id and chat_id are REQUIRED: Postgres does not index
 * the referencing side of an FK, and UNIQUE(user_id, page_id) does not serve a
 * lone-page_id lookup (left-prefix rule). Without them each hard-delete of a page
 * would seq-scan this whole table, and the trash-cleanup loop swallows errors —
 * the degradation would be silent.
 *
 * ON DELETE CASCADE on all three FKs (deliberately stricter than ai_chats.page_id's
 * SET NULL): provenance is a historical fact worth keeping, but a binding without
 * its object is meaningless. `workspace_id` is deliberately NOT denormalized (it is
 * functionally determined by both page_id and chat_id; workspace deletion is covered
 * transitively — pages/ai_chats carry workspace_id with CASCADE and this cascades
 * from them). The users FK is inert (no hard-delete of users in code) but kept for
 * integrity.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ai_chat_page_bindings')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('cascade').notNull(),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('cascade').notNull(),
    )
    .addColumn('chat_id', 'uuid', (col) =>
      col.references('ai_chats.id').onDelete('cascade').notNull(),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('uq_ai_chat_page_bindings_user_page', [
      'user_id',
      'page_id',
    ])
    .execute();

  // Serves ON DELETE CASCADE from pages (a lone-page_id lookup the unique
  // constraint's left-prefix cannot answer).
  await db.schema
    .createIndex('ai_chat_page_bindings_page_id_idx')
    .ifNotExists()
    .on('ai_chat_page_bindings')
    .column('page_id')
    .execute();

  // Serves ON DELETE CASCADE from ai_chats.
  await db.schema
    .createIndex('ai_chat_page_bindings_chat_id_idx')
    .ifNotExists()
    .on('ai_chat_page_bindings')
    .column('chat_id')
    .execute();

  // Backfill: mirror the retired findLatestByPage heuristic (#191) so the release
  // day does not silently lose auto-open-on-page for existing data — for each
  // (creator, page) of non-deleted chats, seed the binding to the NEWEST such chat
  // (tiebreak by id, matching findLatestByPage's ORDER BY). `page_id IS NOT NULL`
  // drops chats whose page is already hard-deleted. ON CONFLICT DO NOTHING is a
  // free belt (the table was just created and is empty). Raw SQL (snake_case,
  // bypassing CamelCasePlugin) is the ~20-migration precedent.
  await sql`
    INSERT INTO ai_chat_page_bindings (id, user_id, page_id, chat_id)
    SELECT DISTINCT ON (creator_id, page_id)
      gen_uuid_v7(), creator_id, page_id, id
    FROM ai_chats
    WHERE page_id IS NOT NULL AND deleted_at IS NULL
    ORDER BY creator_id, page_id, created_at DESC, id DESC
    ON CONFLICT (user_id, page_id) DO NOTHING
  `.execute(db);
}

/**
 * ⚠️ NOT the production rollback path (#665, #361). In prod the rollback is
 * "revert everything EXCEPT this file — leave the file in the image and the table
 * in the DB": reverting the commit would remove the migration file while its row
 * stays in `kysely_migration`, which is exactly the missing-file condition that
 * makes Migrator throw `corrupted migrations` on every pod start -> process.exit(1)
 * -> crash-loop. This down() exists ONLY for local dev / integration tests; it
 * drops the table (destroying every user's explicit binding), and a later up()
 * would silently reset everyone to "newest wins", clobbering their manual choice.
 */
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ai_chat_page_bindings').ifExists().execute();
}
