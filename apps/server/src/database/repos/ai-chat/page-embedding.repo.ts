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
 * The `embedding` column is `vector(1536)`, which is NOT a native Kysely column
 * type, so every read/write of a vector is serialized with the `pgvector` npm
 * helper (`pgvector.toSql(number[])` → a `'[1,2,3]'` text literal) and cast back
 * to `vector` via a raw `::vector` SQL cast. Reindex is a HARD delete + insert
 * (see `deleteByPage`) so the HNSW ANN index never returns stale vectors.
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
   * Bulk-insert chunk rows for a page. The `embedding` value is serialized with
   * `pgvector.toSql` and cast to `vector` so Postgres stores it in the fixed
   * `vector(1536)` column. No-op on an empty array.
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
   * Cosine ANN search over the embeddings, scoped to a workspace AND a set of
   * spaces the caller may read (see semanticSearch access-scoping). Orders by
   * `embedding <=> $query` (cosine distance) and joins the page title cheaply.
   * Returns [] when `spaceIds` is empty (no accessible spaces => no results).
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
}
