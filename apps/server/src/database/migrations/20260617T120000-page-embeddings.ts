import { type Kysely, sql } from 'kysely';

/**
 * Vector-RAG storage for the AI agent (§5.5 / §6.7 stage D / §14[M6,M7]).
 *
 * Creates the pgvector `vector` extension and the `page_embeddings` table that
 * backs semantic search. Columns mirror the hand-written `PageEmbeddings`
 * Kysely type (apps/server/src/database/types/embeddings.types.ts) one-to-one.
 *
 * The indexer + `semanticSearch` tool are a later unit; this migration only
 * provisions the extension, the table and its indexes.
 *
 * The `embedding` column is `vector(EMBEDDING_DIMENSIONS)`. The dimension is
 * FIXED at table-creation time and must match the embedding model in use.
 * 1536 is the default for OpenAI `text-embedding-3-small` / `-ada-002`.
 * Switching to a model with a DIFFERENT dimension (e.g. Gemini
 * `text-embedding-004` = 768, Ollama `nomic-embed-text` = 768) requires
 * re-creating the column and rebuilding the HNSW index. The actual model and
 * its dimension are recorded PER ROW in `model_name` / `model_dimensions` so a
 * future migration can detect and re-index mismatched rows.
 */
const EMBEDDING_DIMENSIONS = 1536;

export async function up(db: Kysely<any>): Promise<void> {
  // pgvector extension (provided by the pgvector/pgvector:pg18 image).
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);

  await db.schema
    .createTable('page_embeddings')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    // Embeddings may cover an attachment instead of page body; nullable, and the
    // attachment row going away should drop its embeddings.
    .addColumn('attachment_id', 'uuid', (col) =>
      col.references('attachments.id').onDelete('cascade'),
    )
    // One row per chunk of a page; chunk_index orders them within the page.
    .addColumn('chunk_index', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('chunk_start', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('chunk_length', 'integer', (col) => col.notNull().defaultTo(0))
    // The chunk text that produced the embedding (always set by the indexer).
    .addColumn('content', 'text', (col) => col.notNull())
    // Provenance of the vector: model id + its output dimension (see header).
    .addColumn('model_name', 'varchar', (col) => col.notNull())
    .addColumn('model_dimensions', 'integer', (col) => col.notNull())
    // Fixed-dimension vector column. Raw type since pgvector's `vector(N)` is not
    // a native Kysely column type.
    .addColumn(
      'embedding',
      sql`vector(${sql.raw(String(EMBEDDING_DIMENSIONS))})`,
    )
    .addColumn('metadata', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz', (col) => col)
    // One stored vector per (page, chunk).
    .addUniqueConstraint('uq_page_embeddings_page_chunk', [
      'page_id',
      'chunk_index',
    ])
    .execute();

  // ANN index for cosine-similarity search over the embedding vectors (HNSW).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_embeddings_embedding_hnsw
      ON page_embeddings
      USING hnsw (embedding vector_cosine_ops)
  `.execute(db);

  // Btree indexes for scoped lookups/deletes (re-index a page, purge a workspace).
  await db.schema
    .createIndex('idx_page_embeddings_page_id')
    .ifNotExists()
    .on('page_embeddings')
    .column('page_id')
    .execute();

  await db.schema
    .createIndex('idx_page_embeddings_workspace_id')
    .ifNotExists()
    .on('page_embeddings')
    .column('workspace_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Drop the table only; leave the `vector` extension in place (it may be used
  // by other objects and dropping it is destructive).
  await db.schema.dropTable('page_embeddings').ifExists().execute();
}
