import { type Kysely, sql } from 'kysely';

/**
 * Agent-edit provenance backbone (§5.2 / §6.6 / §15 C2,H2).
 *
 * Additive provenance markers so an edit "by the agent" is recorded on the page
 * and its history snapshot, plus analogous comment columns for a later unit.
 * `last_updated_by_id` still names the responsible human author; these columns
 * only annotate the source. `'user' | 'agent'` is stored as a short varchar to
 * stay forward-compatible without an enum migration.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // pages: provenance of the current state (mirrors last_updated_by_id semantics)
  await db.schema
    .alterTable('pages')
    .addColumn('last_updated_source', 'varchar(20)', (col) =>
      col.notNull().defaultTo('user'),
    )
    .addColumn('last_updated_ai_chat_id', 'uuid', (col) =>
      col.references('ai_chats.id').onDelete('set null'),
    )
    .execute();

  // page_history: provenance snapshot, copied from the page at save time.
  // Nullable (no default) — historical rows predate the marker.
  await db.schema
    .alterTable('page_history')
    .addColumn('last_updated_source', 'varchar(20)', (col) => col)
    .addColumn('last_updated_ai_chat_id', 'uuid', (col) =>
      col.references('ai_chats.id').onDelete('set null'),
    )
    .execute();

  // comments: analogous markers for a later unit (create + resolve provenance).
  await db.schema
    .alterTable('comments')
    .addColumn('created_source', 'varchar(20)', (col) =>
      col.notNull().defaultTo('user'),
    )
    .addColumn('ai_chat_id', 'uuid', (col) =>
      col.references('ai_chats.id').onDelete('set null'),
    )
    .addColumn('resolved_source', 'varchar(20)', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('comments')
    .dropColumn('created_source')
    .dropColumn('ai_chat_id')
    .dropColumn('resolved_source')
    .execute();

  await db.schema
    .alterTable('page_history')
    .dropColumn('last_updated_source')
    .dropColumn('last_updated_ai_chat_id')
    .execute();

  await db.schema
    .alterTable('pages')
    .dropColumn('last_updated_source')
    .dropColumn('last_updated_ai_chat_id')
    .execute();
}
