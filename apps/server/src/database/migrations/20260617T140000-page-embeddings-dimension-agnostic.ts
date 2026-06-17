import { type Kysely, sql } from 'kysely';

/**
 * Make `page_embeddings.embedding` dimension-agnostic.
 *
 * The original column was `vector(1536)` — a FIXED dimension. On deployments
 * whose embedding model emits a different dimension (e.g. OpenAI
 * `text-embedding-3-large` = 3072, Gemini `text-embedding-004` = 768) every
 * vector failed the indexer's dimension guard and every page was SKIPPED, so
 * RAG / semanticSearch was never populated.
 *
 * pgvector's bare `vector` type (no `(N)`) accepts vectors of ANY dimension,
 * so this migration drops the fixed dimension. The dimension is still recorded
 * PER ROW in `model_dimensions`, and search filters on it so the `<=>` cosine
 * operator only ever compares same-dimension vectors (pgvector errors on a
 * dimension mismatch — possible when rows from a previous model linger).
 *
 * TRADE-OFF: an HNSW / ivfflat ANN index REQUIRES a fixed dimension, so a
 * dimension-agnostic column cannot carry one. We therefore DROP the HNSW index
 * and rely on a sequential scan with `<=>`. That is fine at wiki scale; if a
 * single embedding dimension is ever pinned per deployment, an HNSW index can
 * be re-added in a follow-up migration.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // The HNSW ANN index requires a fixed dimension; drop it before relaxing the
  // column type. Index name mirrors 20260617T120000-page-embeddings.ts.
  await sql`DROP INDEX IF EXISTS idx_page_embeddings_embedding_hnsw`.execute(db);

  // Drop the (1536) dimension constraint so the column accepts any dimension.
  // The identity cast `embedding::vector` is safe for existing 1536-dim rows;
  // on the affected live stand the table is empty (everything was skipped), so
  // there is no data risk.
  await sql`
    ALTER TABLE page_embeddings
      ALTER COLUMN embedding TYPE vector USING embedding::vector
  `.execute(db);

  // Btree index supporting the scoped + dimension-filtered seq-scan search
  // (workspace_id + space_id IN (...) + model_dimensions = queryDim).
  await db.schema
    .createIndex('idx_page_embeddings_ws_space_dim')
    .ifNotExists()
    .on('page_embeddings')
    .columns(['workspace_id', 'space_id', 'model_dimensions'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Best-effort rollback. The `::vector(1536)` cast only succeeds if EVERY row
  // is already 1536-dim — acceptable for a dev rollback (the up migration is
  // the intended steady state). On non-1536 data this will (correctly) error.
  await db.schema
    .dropIndex('idx_page_embeddings_ws_space_dim')
    .ifExists()
    .execute();

  await sql`
    ALTER TABLE page_embeddings
      ALTER COLUMN embedding TYPE vector(1536) USING embedding::vector(1536)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_embeddings_embedding_hnsw
      ON page_embeddings
      USING hnsw (embedding vector_cosine_ops)
  `.execute(db);
}
