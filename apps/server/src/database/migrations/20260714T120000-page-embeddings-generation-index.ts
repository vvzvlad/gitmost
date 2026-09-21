import { type Kysely } from 'kysely';

/**
 * #599 Search Phase B (PR-2): the embedding-fingerprint LIFECYCLE index.
 *
 * PR-1 (#530) added the `fingerprint` column plus
 * `idx_page_embeddings_ws_space_fp_dim` (workspace_id, space_id, fingerprint,
 * model_dimensions) — shaped for the per-SPACE vector-candidate scan. PR-2 adds
 * two workspace-wide, space-agnostic access paths that index cannot serve well
 * (space_id is its second column, so a workspace+fingerprint predicate can only
 * reach it by skipping over every space):
 *
 *  1. COVERAGE   — `COUNT(DISTINCT page_id) WHERE workspace_id = $1 AND
 *                  fingerprint = $2` (PageEmbeddingRepo.countPagesByFingerprint),
 *                  which rides on every search response's `semantic.indexed`.
 *  2. GENERATIONAL GC — `DELETE WHERE workspace_id = $1 AND (fingerprint IS NULL
 *                  OR fingerprint NOT IN (...))` (deleteOtherGenerations), run at
 *                  the start of every reindex and after every pointer flip.
 *
 * (workspace_id, fingerprint, page_id) serves both: the leading pair matches the
 * predicate exactly, and trailing page_id lets the coverage count be answered
 * from the index alone. page_id is deliberately LAST — leading with it would not
 * match either predicate.
 *
 * NO workspace-settings migration is needed for the active-fingerprint pointer:
 * it lives in the existing `workspaces.settings` jsonb, under
 * `settings.ai.embedding` (`activeFingerprint`, `activeModel`, `coverageTotal`,
 * `coverageEmbeddable`), written atomically in one jsonb merge — the same
 * convention as `settings.ai.provider`.
 *
 * Independent migration (per the #363 crash-loop net): it creates ONLY its own
 * object and never touches another migration's tables/indexes, so a partial
 * failure cannot leave a shared object half-built. The PR-1 index is left exactly
 * as it is — the two serve different predicates and both are used.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex('idx_page_embeddings_ws_fp_page')
    .ifNotExists()
    .on('page_embeddings')
    .columns(['workspace_id', 'fingerprint', 'page_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('idx_page_embeddings_ws_fp_page')
    .ifExists()
    .execute();
}
