import { type Kysely } from 'kysely';

/**
 * Personal external MCP servers (#686), Phase 1 — data model.
 *
 * Adds a nullable `user_id` owner column to `ai_mcp_servers`. Semantics:
 *   - user_id IS NULL  => an ADMIN/workspace-managed server (today's rows).
 *   - user_id = <uuid> => a PERSONAL server owned by that member; only the
 *     agent turn run BY that user sees it, and only that user can manage it.
 *
 * The column is nullable with NO default and NO backfill, so this is an
 * additive metadata-only add — every legacy row keeps `null` (= admin) and no
 * table rewrite / hot-table lock is taken (mirrors 20260713 external-mcp
 * -provenance).
 *
 * FK onDelete CASCADE — INTENTIONAL and DIFFERENT from the provenance columns:
 * a personal server has no meaning once its owner is gone, and it holds an
 * encrypted per-user auth blob (`headersEnc`) that must not outlive the user.
 * So when the user is deleted the row is destroyed (not nulled — nulling would
 * silently PROMOTE a personal server to an admin server, exposing it to the
 * whole workspace). Admin rows (`user_id IS NULL`) are untouched by any user
 * delete.
 *
 * Index `(workspace_id, user_id, enabled)` serves both read shapes: the admin
 * scan (`workspace_id = ? AND user_id IS NULL AND enabled`) and the agent union
 * (`workspace_id = ? AND (user_id IS NULL OR user_id = ?) AND enabled`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('ai_mcp_servers')
    .addColumn('user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('cascade'),
    )
    .execute();

  await db.schema
    .createIndex('ai_mcp_servers_workspace_user_enabled_idx')
    .ifNotExists()
    .on('ai_mcp_servers')
    .columns(['workspace_id', 'user_id', 'enabled'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // ORDER MATTERS: purge personal rows BEFORE dropping the column. If the
  // column were dropped first, every personal row would lose its owner marker
  // and become indistinguishable from an admin row (user_id gone), silently
  // exposing per-user servers (and their encrypted auth blobs) to the whole
  // workspace's agent. Deleting them first keeps the rollback safe.
  await db
    .deleteFrom('ai_mcp_servers')
    .where('user_id', 'is not', null)
    .execute();

  await db.schema
    .dropIndex('ai_mcp_servers_workspace_user_enabled_idx')
    .ifExists()
    .execute();

  await db.schema
    .alterTable('ai_mcp_servers')
    .dropColumn('user_id')
    .execute();
}
