import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Encrypted, embedding-specific provider key. Separate from `api_key_enc`
  // (the chat key) so the chat model and the embedding model can use different
  // tokens. When NULL, the embedding model falls back to `api_key_enc`.
  await db.schema
    .alterTable('ai_provider_credentials')
    .addColumn('embedding_api_key_enc', 'text', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('ai_provider_credentials')
    .dropColumn('embedding_api_key_enc')
    .execute();
}
