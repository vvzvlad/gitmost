import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Reusable, workspace-scoped agent roles (admin-owned). A role REPLACES the
  // persona layer of the system prompt (instructions) and may optionally
  // override the chat model. The non-removable SAFETY_FRAMEWORK is always still
  // appended downstream — a role only shapes the persona, never the safety rules.
  await db.schema
    .createTable('ai_agent_roles')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    // Who created the role (audit). The role is shared and outlives its author,
    // so SET NULL on user deletion (unlike ai_chats.creator_id which is NOT NULL).
    .addColumn('creator_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    // Display name, e.g. 'Proofreader'.
    .addColumn('name', 'varchar', (col) => col.notNull())
    // Optional presentation emoji for the role badge.
    .addColumn('emoji', 'varchar', (col) => col)
    // Optional short description shown in the management UI.
    .addColumn('description', 'text', (col) => col)
    // The persona fragment injected into the system prompt (replaces the admin
    // persona / DEFAULT_PROMPT). Required.
    .addColumn('instructions', 'text', (col) => col.notNull())
    // Optional model override: { chatModel } or { driver, chatModel }. NULL =>
    // use the workspace default model. Driver creds come from the matching
    // provider in ai_provider_credentials (no per-role creds).
    .addColumn('model_config', 'jsonb', (col) => col)
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // Soft delete (consistent with ai_chats): the role disappears from the
    // picker but lookups can still resolve it for already-bound chats.
    .addColumn('deleted_at', 'timestamptz', (col) => col)
    .execute();

  // Scoped lookups (listByWorkspace) hit workspace_id first.
  await db.schema
    .createIndex('idx_ai_agent_roles_workspace_id')
    .ifNotExists()
    .on('ai_agent_roles')
    .column('workspace_id')
    .execute();

  // Bind a chat to a role. ON DELETE SET NULL: a hard-deleted role degrades the
  // chat to the universal assistant instead of breaking it. The role is read
  // from this column on every turn — the client only sends roleId on chat
  // creation (first message).
  await db.schema
    .alterTable('ai_chats')
    .addColumn('role_id', 'uuid', (col) =>
      col.references('ai_agent_roles.id').onDelete('set null'),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_chats').dropColumn('role_id').execute();
  await db.schema.dropTable('ai_agent_roles').execute();
}
