import { type Kysely, sql } from 'kysely';

/**
 * #610 — move article icons (`pages.icon`) and AI-agent role glyphs
 * (`ai_agent_roles.emoji`) from native emoji to Lucide icons.
 *
 * The new value in each (unchanged, still `varchar`) column is a serialized
 * IconRef JSON, e.g. `{"name":"rocket","color":"blue"}` for a page and
 * `{"name":"rocket"}` for a role. A legacy native-emoji value is NOT valid
 * IconRef JSON.
 *
 * This backfill NULLs every legacy value so the UI shows its default glyph (the
 * defensive client parser already renders a default for a null / unparseable
 * value). We do NOT attempt an emoji -> Lucide semantic mapping — the issue
 * wants the emoji gone, and NULL is the simplest safe result.
 *
 * A value is treated as "already migrated" iff it starts with `{` (a JSON
 * object); every other non-null value is a legacy native emoji and is cleared.
 * This makes the migration IDEMPOTENT (re-running clears nothing new) and, since
 * `left(value, 1)` is cheap, index-free.
 *
 * `down` is intentionally a NO-OP: the original emoji characters are discarded
 * and cannot be recovered, so there is nothing to restore.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE pages
    SET icon = NULL
    WHERE icon IS NOT NULL AND left(icon, 1) <> '{'
  `.execute(db);

  await sql`
    UPDATE ai_agent_roles
    SET emoji = NULL
    WHERE emoji IS NOT NULL AND left(emoji, 1) <> '{'
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function down(_db: Kysely<any>): Promise<void> {
  // No-op: legacy emoji characters were discarded by `up` and cannot be
  // reconstructed. Rolling back leaves the (already-NULLed) values as-is.
}
