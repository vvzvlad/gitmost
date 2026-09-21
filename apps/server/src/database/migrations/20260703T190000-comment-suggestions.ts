import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Agent comment suggestions (#315): a comment may carry a proposed replacement
  // for its anchored `selection`, which a human applies via the comment UI.
  await db.schema
    .alterTable('comments')
    // The proposed replacement text (plain text). NULL for ordinary comments.
    .addColumn('suggested_text', 'text')
    // When the suggestion was applied (NULL until applied).
    .addColumn('suggestion_applied_at', 'timestamptz')
    // Who applied it (NULL until applied).
    .addColumn('suggestion_applied_by_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('comments')
    .dropColumn('suggested_text')
    .dropColumn('suggestion_applied_at')
    .dropColumn('suggestion_applied_by_id')
    .execute();
}
