import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import * as pgvector from 'pgvector';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';

/**
 * Repository for `page_embeddings` — the pgvector store backing the AI agent's
 * semantic search (§5.5 / §6.7 stage D).
 *
 * The `embedding` column is a dimension-agnostic pgvector `vector` (no fixed
 * `(N)`, see migration 20260617T140000), which is NOT a native Kysely column
 * type, so every read/write of a vector is serialized with the `pgvector` npm
 * helper (`pgvector.toSql(number[])` → a `'[1,2,3]'` text literal) and cast back
 * to `vector` via a raw `::vector` SQL cast. Reindex is a HARD delete + insert
 * (see `deleteByPage`) so search never returns stale vectors.
 *
 * TRADE-OFF: a dimension-agnostic column cannot carry an HNSW/ivfflat ANN index
 * (those require a fixed dimension), so `searchByEmbedding` is a sequential scan
 * with the `<=>` cosine operator. Fine at wiki scale; re-add an HNSW index if a
 * single embedding dimension is ever pinned per deployment.
 */

/** A single chunk row to persist for a page (page-body embeddings). */
export interface PageEmbeddingChunkRow {
  pageId: string;
  workspaceId: string;
  spaceId: string;
  // null for page-body chunks; set only for attachment chunks (future).
  attachmentId: string | null;
  chunkIndex: number;
  chunkStart: number;
  chunkLength: number;
  content: string;
  modelName: string;
  modelDimensions: number;
  embedding: number[];
}

/** A single ANN search hit. */
export interface PageEmbeddingSearchHit {
  pageId: string;
  spaceId: string;
  title: string | null;
  content: string;
  // Cosine distance (0 = identical direction). Lower is more similar.
  distance: number;
}

@Injectable()
export class PageEmbeddingRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * HARD-delete every embedding row for a page (within its workspace). Used
   * before a reindex and on page deletion — a hard delete (not soft) guarantees
   * the HNSW index never returns vectors for content that no longer exists.
   */
  async deleteByPage(
    pageId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('pageEmbeddings')
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  /**
   * HARD-delete every embedding row for an entire workspace. Used when AI Search
   * is disabled for the workspace (WORKSPACE_DELETE_EMBEDDINGS).
   */
  async deleteByWorkspace(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('pageEmbeddings')
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  /**
   * Bulk-insert chunk rows for a page. The `embedding` value is serialized with
   * `pgvector.toSql` and cast to `vector` so Postgres stores it in the
   * dimension-agnostic `vector` column (any dimension). No-op on an empty array.
   */
  async insertChunks(
    rows: PageEmbeddingChunkRow[],
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (rows.length === 0) return;
    const db = dbOrTx(this.db, trx);
    await db
      .insertInto('pageEmbeddings')
      .values(
        rows.map((row) => ({
          pageId: row.pageId,
          workspaceId: row.workspaceId,
          spaceId: row.spaceId,
          attachmentId: row.attachmentId,
          chunkIndex: row.chunkIndex,
          chunkStart: row.chunkStart,
          chunkLength: row.chunkLength,
          content: row.content,
          modelName: row.modelName,
          modelDimensions: row.modelDimensions,
          // pgvector.toSql -> '[1,2,3]'; cast the bound literal to vector.
          embedding: sql`${pgvector.toSql(row.embedding)}::vector`,
        })),
      )
      .execute();
  }

  /**
   * Cosine search over the embeddings, scoped to a workspace AND a set of
   * spaces the caller may read (see semanticSearch access-scoping). Orders by
   * `embedding <=> $query` (cosine distance) and joins the page title cheaply.
   * Returns [] when `spaceIds` is empty (no accessible spaces => no results).
   *
   * Because the column is dimension-agnostic (no ANN index), this is a seq scan
   * with `<=>`. The query MUST only be compared against same-dimension rows —
   * pgvector raises on a dimension mismatch, which can happen when rows from a
   * previously configured embedding model still linger. We therefore filter by
   * `model_dimensions = queryEmbedding.length` so the `<=>` operands always
   * agree on dimension.
   */
  async searchByEmbedding(
    workspaceId: string,
    queryEmbedding: number[],
    spaceIds: string[],
    limit: number,
  ): Promise<PageEmbeddingSearchHit[]> {
    if (spaceIds.length === 0) return [];

    // Serialized + cast query vector reused for the distance expression.
    const queryVector = sql`${pgvector.toSql(queryEmbedding)}::vector`;
    // Compare only against rows produced by a model of the SAME dimension.
    const queryDim = queryEmbedding.length;

    const rows = await this.db
      .selectFrom('pageEmbeddings as pe')
      .innerJoin('pages as p', 'p.id', 'pe.pageId')
      .select([
        'pe.pageId as pageId',
        'pe.spaceId as spaceId',
        'pe.content as content',
        'p.title as title',
        sql<number>`pe.embedding <=> ${queryVector}`.as('distance'),
      ])
      .where('pe.workspaceId', '=', workspaceId)
      .where('pe.spaceId', 'in', spaceIds)
      // Same-dimension only: avoids a pgvector dimension-mismatch error against
      // rows from a previously configured embedding model.
      .where('pe.modelDimensions', '=', queryDim)
      // Exclude chunks whose page is in the trash (defence in depth).
      .where('p.deletedAt', 'is', null)
      .orderBy('distance', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      pageId: row.pageId,
      spaceId: row.spaceId,
      title: row.title,
      content: row.content,
      distance: Number(row.distance),
    }));
  }

  /**
   * Count DISTINCT non-deleted pages that have at least one embedding row in this
   * workspace — i.e. how many pages currently have stored embeddings.
   *
   * NOTE: this counts pages embedded by ANY model dimension, whereas
   * `searchByEmbedding` only serves rows matching the active model's dimension.
   * After switching the embedding model, this number can therefore exceed the
   * set of pages actually reachable by search until those pages are re-indexed.
   * It is an indexing-coverage indicator, not an exact searchable-page count.
   */
  async countIndexedPages(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom('pageEmbeddings as pe')
      .innerJoin('pages as p', 'p.id', 'pe.pageId')
      .where('pe.workspaceId', '=', workspaceId)
      // Exclude trashed pages and any soft-deleted embedding rows (defence in
      // depth: embeddings are hard-deleted, so pe.deletedAt is normally null).
      .where('p.deletedAt', 'is', null)
      .where('pe.deletedAt', 'is', null)
      .select((eb) => eb.fn.count('pe.pageId').distinct().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}
