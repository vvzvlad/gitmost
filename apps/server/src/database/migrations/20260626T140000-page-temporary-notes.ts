import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // "Death timer" column. NULL = permanent page; non-NULL = temporary note,
  // value is the exact moment the note auto-moves to trash. The deadline is
  // frozen at creation, so changing the workspace setting never reschedules
  // existing notes.
  await db.schema
    .alterTable('pages')
    .addColumn('temporary_expires_at', 'timestamptz', (col) => col)
    .execute();

  // Partial index backing the cleanup sweep: only armed, not-yet-trashed notes.
  await sql`
    CREATE INDEX pages_temporary_expires_at_idx
    ON pages (temporary_expires_at)
    WHERE temporary_expires_at IS NOT NULL AND deleted_at IS NULL
  `.execute(db);

  // Default lifetime for new temporary notes, in HOURS. Frozen per-note at
  // creation. NULL falls back to the in-code DEFAULT_TEMPORARY_NOTE_HOURS.
  await db.schema
    .alterTable('workspaces')
    .addColumn('temporary_note_hours', 'int8', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('workspaces')
    .dropColumn('temporary_note_hours')
    .execute();

  await db.schema.dropIndex('pages_temporary_expires_at_idx').execute();

  await db.schema
    .alterTable('pages')
    .dropColumn('temporary_expires_at')
    .execute();
}
