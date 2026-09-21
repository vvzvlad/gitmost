import { type Kysely } from 'kysely';

/**
 * External-MCP provenance backbone (#559, Phase 3C of #556).
 *
 * An edit/comment made by an EXTERNAL MCP agent authenticates via an `api_key`,
 * so it must be attributed to a separate "External MCP" persona named after the
 * key (a person names each key per agent, e.g. `agent-node-2`) instead of being
 * shown as if the human made it. This migration adds the nullable id columns the
 * write sites stamp with the acting key, mirroring the `last_updated_ai_chat_id`
 * columns that carry the internal-agent chat id (20260616 agent-provenance).
 *
 * FK onDelete semantics — CRITICAL: each column references `api_keys.id` with
 * `onDelete('set null')`, NOT cascade. The attributed page/comment/history row
 * must SURVIVE the key going away; on a hard-delete of the key (its owner or
 * workspace is removed → `api_keys` cascades) the column is simply nulled and the
 * persona resolver falls back to the "External MCP" display name. A cascade here
 * would destroy attributed content when a user is deleted — never acceptable.
 *
 * The columns are nullable with NO default and NO backfill, so this is a metadata
 * -only add (no table rewrite, no hot-table lock) — legacy rows and every non-
 * api-key write keep `null`.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // comments: the api_key that CREATED an external-MCP comment.
  await db.schema
    .alterTable('comments')
    .addColumn('created_api_key_id', 'uuid', (col) =>
      col.references('api_keys.id').onDelete('set null'),
    )
    .execute();

  // pages: the api_key behind the page's CURRENT state (mirrors
  // last_updated_ai_chat_id, which annotates the internal-agent chat).
  await db.schema
    .alterTable('pages')
    .addColumn('last_updated_api_key_id', 'uuid', (col) =>
      col.references('api_keys.id').onDelete('set null'),
    )
    .execute();

  // page_history: provenance snapshot, copied from the page at save time.
  await db.schema
    .alterTable('page_history')
    .addColumn('last_updated_api_key_id', 'uuid', (col) =>
      col.references('api_keys.id').onDelete('set null'),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('page_history')
    .dropColumn('last_updated_api_key_id')
    .execute();

  await db.schema
    .alterTable('pages')
    .dropColumn('last_updated_api_key_id')
    .execute();

  await db.schema
    .alterTable('comments')
    .dropColumn('created_api_key_id')
    .execute();
}
