import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Chat-level metadata bag (#490). First use: the deferred-tool ACTIVATION set
  // (`activatedTools`) is persisted here so it survives across turns — previously
  // the set was reset every turn, forcing the model to re-run loadTools and pay a
  // fresh round-trip to re-activate the same tools each turn. On load the stored
  // set is intersected with the current valid deferred names, so an allowlist /
  // role change can never inject a now-nonexistent tool.
  //
  // jsonb, defaulted to '{}' so every row (incl. pre-migration ones, backfilled
  // by the default) is a readable object — the app never has to null-guard the
  // bag itself, only individual keys.
  await db.schema
    .alterTable('ai_chats')
    .addColumn('metadata', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_chats').dropColumn('metadata').execute();
}
