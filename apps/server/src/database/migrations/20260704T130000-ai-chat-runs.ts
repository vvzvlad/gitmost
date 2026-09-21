import { type Kysely, sql } from 'kysely';

/**
 * `ai_chat_runs` — the agent RUN as a first-class, server-side lifecycle object
 * (#184 phase 1: autonomous agent runs detached from the browser window).
 *
 * Until now an agent turn lived ONLY as long as the HTTP request was open
 * (`res.hijack()` in ai-chat.controller.ts); a browser disconnect aborted it.
 * This table makes a turn a persistent object the server owns: it is created
 * when a run starts (inserted directly as 'running' in phase 1 — 'pending' is
 * only this column's default + a reserved value, never written by code yet) and
 * advances to succeeded|failed|aborted, surviving the subscriber (browser) going
 * away when it settles. The DB is the source of
 * truth — a later client reconnects/sees the result by reading this row plus the
 * assistant message it projects (`assistant_message_id`).
 *
 * The assistant message row (#183 step-granular durability) is the PROJECTION of
 * a run's output; this row is the run's LIFECYCLE. They are linked by
 * `assistant_message_id` (SET NULL if the message is later pruned).
 *
 * `status`  : 'pending' | 'running' | 'succeeded' | 'failed' | 'aborted'.
 * `trigger` : 'user' | 'autostart' | 'schedule' | 'api' | 'continue' — only
 *             'user' is produced in phase 1; the others are reserved for the
 *             autonomy triggers deferred to phase 2 so they need no later
 *             migration.
 *
 * ONE ACTIVE RUN PER CHAT is enforced by a partial unique index on `chat_id`
 * WHERE status IN ('pending','running'): an autonomous run and a user run can
 * never trample each other on the same chat. Settled runs (succeeded/failed/
 * aborted) are excluded from the index so a chat can accumulate any number of
 * historical runs.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ai_chat_runs')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('chat_id', 'uuid', (col) =>
      col.references('ai_chats.id').onDelete('cascade').notNull(),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    // The human who triggered the run (audit). SET NULL on user deletion so the
    // run history outlives its author; NULL is also the natural value for a
    // future system/cron/api trigger with no human actor.
    .addColumn('created_by', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    // The assistant message this run materializes (the #183 projection). SET NULL
    // if that message row is later deleted; nullable because the run row is
    // created a moment BEFORE the assistant row is seeded.
    .addColumn('assistant_message_id', 'uuid', (col) =>
      col.references('ai_chat_messages.id').onDelete('set null'),
    )
    .addColumn('trigger', 'varchar(20)', (col) =>
      col.notNull().defaultTo('user'),
    )
    .addColumn('status', 'varchar(20)', (col) =>
      col.notNull().defaultTo('pending'),
    )
    // Terminal error message for a failed run (provider/transport cause),
    // mirroring the assistant message's metadata.error.
    .addColumn('error', 'text', (col) => col)
    // Number of agent steps finished so far (kept monotonic with the projection).
    .addColumn('step_count', 'integer', (col) => col.notNull().defaultTo(0))
    // Set when an EXPLICIT user stop is requested (distinct from a mere browser
    // disconnect, which never stops a run). The runner aborts the turn and the
    // run settles as 'aborted'.
    .addColumn('stop_requested_at', 'timestamptz', (col) => col)
    .addColumn('started_at', 'timestamptz', (col) => col)
    .addColumn('finished_at', 'timestamptz', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Reconnect / "latest run for this chat" reads hit chat_id first.
  await db.schema
    .createIndex('ai_chat_runs_chat_id_idx')
    .ifNotExists()
    .on('ai_chat_runs')
    .column('chat_id')
    .execute();

  // One ACTIVE run per chat (advisory at the DB level): a second pending/running
  // run on the same chat is rejected, so a user turn and an autonomous turn can
  // never race on the same chat. Partial so settled runs do not collide.
  await db.schema
    .createIndex('ai_chat_runs_one_active_per_chat')
    .ifNotExists()
    .on('ai_chat_runs')
    .column('chat_id')
    .unique()
    .where(sql.ref('status'), 'in', sql`('pending','running')`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ai_chat_runs').execute();
}
