import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // `source` links an imported role back to its catalog origin
  // `{ slug, language, version }`. Nullable: null => a manually-created role
  // (no catalog provenance). The version lets the admin UI offer an UPDATE when
  // the catalog ships a newer revision of the same slug.
  await db.schema
    .alterTable('ai_agent_roles')
    .addColumn('source', 'jsonb', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('ai_agent_roles')
    .dropColumn('source')
    .execute();
}
