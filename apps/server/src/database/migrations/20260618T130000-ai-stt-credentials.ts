import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Encrypted, STT-specific provider key. Separate from `api_key_enc`
  // (the chat key) so the transcription model can use a different token.
  // When NULL, the STT model falls back to `api_key_enc`.
  await db.schema
    .alterTable('ai_provider_credentials')
    .addColumn('stt_api_key_enc', 'text', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('ai_provider_credentials')
    .dropColumn('stt_api_key_enc')
    .execute();
}
