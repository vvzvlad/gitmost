import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Step-granular durability for the assistant turn (#183). The assistant row is
  // now created UPFRONT (status 'streaming') and UPDATEd as each step completes,
  // so a process death mid-turn no longer loses the whole answer. The column is
  // NULLABLE on purpose: rows written before this migration carry NULL, which the
  // app treats as 'completed' (a settled, pre-status message). Values written by
  // the app: 'streaming' | 'completed' | 'error' | 'aborted'.
  await db.schema
    .alterTable('ai_chat_messages')
    .addColumn('status', 'text', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_chat_messages').dropColumn('status').execute();
}
