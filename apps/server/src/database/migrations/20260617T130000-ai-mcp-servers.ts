import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ai_mcp_servers')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    // display name, e.g. 'Tavily'.
    .addColumn('name', 'varchar', (col) => col.notNull())
    // 'http' | 'sse' — the @ai-sdk/mcp transport type.
    .addColumn('transport', 'varchar', (col) => col.notNull())
    // remote MCP endpoint URL.
    .addColumn('url', 'text', (col) => col.notNull())
    // SECURITY (§8.10): AES-256-GCM blob of the JSON auth headers. Write-only;
    // NEVER added to workspace baseFields and NEVER returned by any endpoint.
    .addColumn('headers_enc', 'text', (col) => col)
    // optional: restrict which remote tool names to expose to the agent.
    .addColumn('tool_allowlist', 'jsonb', (col) => col)
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Scoped lookups (listByWorkspace / listEnabled) hit workspace_id first.
  await db.schema
    .createIndex('ai_mcp_servers_workspace_id_idx')
    .ifNotExists()
    .on('ai_mcp_servers')
    .column('workspace_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ai_mcp_servers').execute();
}
