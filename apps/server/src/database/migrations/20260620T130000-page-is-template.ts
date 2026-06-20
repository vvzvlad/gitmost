import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('pages')
    .addColumn('is_template', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();

  // Partial index backing the template picker: only template rows are indexed.
  await sql`CREATE INDEX pages_is_template_idx ON pages (workspace_id) WHERE is_template`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('pages_is_template_idx').execute();
  await db.schema.alterTable('pages').dropColumn('is_template').execute();
}
