import { type Kysely } from 'kysely';

/**
 * Agent identity flag on users (MCP comment/page AI attribution).
 *
 * Additive boolean marking a service account as an AI agent. When set, the JWT
 * strategy derives provenance ('agent') from this SIGNED server-side identity —
 * never from a client-supplied field — so every write by the account is
 * attributed to AI in a non-spoofable way. Defaults to false; ordinary users
 * are unaffected. Kept as a dedicated column (not `role`, which has
 * authorization semantics, and not buried in `settings`) for a cheap filter and
 * explicitness.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('is_agent', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('is_agent').execute();
}
