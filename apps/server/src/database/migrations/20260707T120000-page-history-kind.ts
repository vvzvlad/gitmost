import { type Kysely } from 'kysely';

/**
 * #370 — page-versioning intentionality tier on a history snapshot.
 *
 * Adds `page_history.kind`, the three-tier "how intentional was this snapshot"
 * marker that lets versions (intentional points) be told apart from autosaves:
 *   - 'manual'   — a human explicitly saved a version (Cmd+S / Save button)
 *   - 'agent'    — the AI agent explicitly saved a version
 *   - 'idle'     — trailing idle-flush autosnapshot (safety net)
 *   - 'boundary' — autosnapshot pinned on a source transition (user↔agent↔git)
 *
 * Nullable with NO default (mirrors last_updated_source in the agent-provenance
 * migration): legacy rows predate the marker and read back as `null`, which the
 * client renders as a plain autosave. Stored as a short varchar to stay
 * forward-compatible without an enum migration.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('page_history')
    .addColumn('kind', 'varchar(20)', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('page_history').dropColumn('kind').execute();
}
