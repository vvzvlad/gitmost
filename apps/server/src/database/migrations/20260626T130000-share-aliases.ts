import { type Kysely, sql } from 'kysely';

/**
 * Vanity share aliases: a retargetable, human-readable pointer (`/l/<alias>`)
 * that lives independently of any single `shares` row. The alias belongs to the
 * WORKSPACE (stable address), and `page_id` is nullable with ON DELETE SET NULL
 * so the address survives deletion of its current target (it 404s until
 * retargeted) rather than disappearing with the page.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('share_aliases')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    // Normalized ASCII, lowercase. Uniqueness is enforced per-workspace below.
    .addColumn('alias', 'varchar', (col) => col.notNull())
    // Nullable + SET NULL: the address outlives its target page.
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('set null'),
    )
    .addColumn('creator_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // The vanity name is unique within a workspace (mirrors shares.key scoping).
  await db.schema
    .createIndex('share_aliases_workspace_id_alias_unique')
    .on('share_aliases')
    .columns(['workspace_id', 'alias'])
    .unique()
    .execute();

  // "Which alias targets this page?" lookup for the share modal.
  await db.schema
    .createIndex('share_aliases_page_id_idx')
    .on('share_aliases')
    .column('page_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('share_aliases').execute();
}
