import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Per-server, admin-authored instruction text injected into the agent system
  // prompt next to the server's tool descriptions (#180). NON-secret (unlike
  // headers_enc): it IS returned in admin views/forms. Nullable: a server may
  // have no guidance. Trusted text — it goes inside the prompt safety sandwich.
  await db.schema
    .alterTable('ai_mcp_servers')
    .addColumn('instructions', 'text', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('ai_mcp_servers')
    .dropColumn('instructions')
    .execute();
}
