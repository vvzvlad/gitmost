import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // The document a chat was created in (the user's open page at first message).
  // Informational provenance shown in the chat-history list. NULL => the chat
  // was started outside any document. ON DELETE SET NULL: a hard-deleted page
  // degrades the chat to "no document" instead of breaking it.
  await db.schema
    .alterTable('ai_chats')
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('set null'),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_chats').dropColumn('page_id').execute();
}
