import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Per-(chat,page) snapshot of the open page's Markdown at the END of the
  // agent's previous turn (#274). The next turn diffs the CURRENT Markdown
  // against this snapshot to detect edits the USER (or anyone else) made between
  // turns, and surfaces that unified diff as an ephemeral note in the system
  // prompt so the agent does not silently overwrite those edits. The agent's own
  // edits are baked into the snapshot (it is rewritten at each turn end), so the
  // diff is exactly "what someone else changed since I last spoke".
  //
  // ON DELETE CASCADE on both FKs: the snapshot is derived, per-chat state with
  // no independent value, so a hard-deleted chat or page takes its snapshots with
  // it. UNIQUE(chat_id, page_id): at most one live snapshot per chat/page pair
  // (the turn-end write is an upsert on this key).
  await db.schema
    .createTable('ai_chat_page_snapshots')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('chat_id', 'uuid', (col) =>
      col.references('ai_chats.id').onDelete('cascade').notNull(),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('cascade').notNull(),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    // The rendered Markdown of the page at the snapshot instant (exportPageMarkdown).
    .addColumn('content_md', 'text', (col) => col.notNull())
    // The page's updated_at at the snapshot instant. The next turn compares this
    // against the live page.updated_at as a cheap fast path: equal => nothing
    // changed, skip the render + diff entirely.
    .addColumn('page_updated_at', 'timestamptz', (col) => col.notNull())
    // Optional content fingerprint (informational; the updated_at fast path is the
    // primary change signal). Nullable so a snapshot can be written without one.
    .addColumn('content_hash', 'varchar', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('uq_ai_chat_page_snapshots_chat_page', [
      'chat_id',
      'page_id',
    ])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ai_chat_page_snapshots').execute();
}
