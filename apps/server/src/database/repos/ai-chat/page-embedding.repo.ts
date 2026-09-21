import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { RawBuilder, sql } from 'kysely';
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
  // #530 PR-1: the active embedding fingerprint (see computeEmbeddingFingerprint).
  // null only when no provider resolves (the indexer no-ops in that case).
  fingerprint: string | null;
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

/** A single hybrid (RRF-fused) search hit. Higher `score` is more relevant. */
export interface PageEmbeddingHybridHit {
  pageId: string;
  spaceId: string;
  title: string | null;
  content: string;
  // Fused Reciprocal Rank Fusion score (sum of 1/(k+rank) across CTEs).
  score: number;
}

@Injectable()
export class PageEmbeddingRepo {
  private readonly logger = new Logger(PageEmbeddingRepo.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * HARD-delete embedding rows for a page (within its workspace). Used before a
   * reindex and on page deletion — a hard delete (not soft) guarantees search
   * never returns vectors for content that no longer exists.
   *
   * #599 `fingerprints` — FINGERPRINT-SCOPED delete. When omitted (the default)
   * EVERY row of the page is deleted, which is what the PURGE paths want (page
   * deleted / emptied / trashed: the page must vanish from every generation).
   *
   * The REPLACE path (indexer delete+insert of the same page) passes the single
   * generation it is rewriting — the TARGET fingerprint — whenever a swap is in
   * flight (active != target). Without that scope, editing a page mid-reindex
   * would delete its ACTIVE-generation rows too and, because the new rows carry
   * the TARGET fingerprint (which search does not serve until the flip), the page
   * would silently drop out of semantic search for the whole reindex window
   * (#599 acceptance 3). Scoping the delete to the target keeps the page's
   * active-generation rows intact and served until the pointer flips.
   *
   * NOTE the SQL `IN` semantics: rows with a NULL fingerprint (legacy) never match
   * a scoped delete — they are a separate generation and are reclaimed by the
   * generational GC (`deleteOtherGenerations`), not here.
   */
  async deleteByPage(
    pageId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
    fingerprints?: string[],
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    let query = db
      .deleteFrom('pageEmbeddings')
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId);
    if (fingerprints && fingerprints.length > 0) {
      query = query.where('fingerprint', 'in', fingerprints);
    }
    await query.execute();
  }

  /**
   * #599 GENERATIONAL GC: hard-delete every embedding row of this workspace whose
   * fingerprint is NOT one of `keep` — including legacy NULL-fingerprint rows,
   * which are simply a very old generation (nothing serves them: both the search
   * vector arm and the RAG hybrid CTE filter `fingerprint = $active`, and NULL
   * never equals anything).
   *
   * Both call sites go through EmbeddingGenerationService.gcGenerations (which
   * adds the logging + coverage-cache invalidation): the indexer calls it at the
   * START of a reindex run with keep = [active, target] (so at most 2 generations
   * survive: the one still being served and the one being built), and
   * EmbeddingGenerationService.completeRun calls it again right AFTER a successful
   * pointer flip with keep = [target] (which reclaims the superseded generation).
   *
   * IDEMPOTENT — it is a set-difference delete, so re-running it (an aborted run
   * that is retried) is a no-op once the extra generations are gone. Running it at
   * the START is what makes a retried run clean: a PARTIAL target generation from
   * an aborted run whose config has since moved on is no longer active nor target,
   * so it is reclaimed here instead of lingering forever.
   *
   * STORAGE / LATENCY TRADE-OFF (deliberate): between the start of a reindex and
   * the post-flip GC, the workspace holds ~2x the pgvector rows (active + target
   * generations). That is the price of a NON-DESTRUCTIVE swap — the old generation
   * must stay readable while the new one is built, or search would lose all
   * semantic recall for the whole reindex window. It costs both disk and LATENCY:
   * the vector column carries no ANN index, so `<=>` is a brute-force seq scan and
   * the scan must skip the other generation's (and any not-yet-vacuumed dead) rows.
   * The GC caps this at 2 generations rather than letting every model change pile
   * up another one; the post-flip GC brings it back down to 1.
   *
   * FAIL-CLOSED on an empty `keep` (#599 review F3). Both call sites derive `keep`
   * from a RESOLVED provider fingerprint (a sha256 hex string), so an empty set is
   * unreachable today — but this method is a bulk DELETE, and the cost of the two
   * possible defensive branches is wildly asymmetric:
   *
   *   - fail-OPEN (drop the fingerprint predicate): the statement degenerates to
   *     `DELETE FROM page_embeddings WHERE workspace_id = $1` — it WIPES the
   *     workspace's entire vector index, including the generation that is being
   *     served. Semantic search goes to zero recall until someone notices and runs
   *     a full reindex. That is the exact "keep nothing" reading of an EMPTY array,
   *     but an empty array here can only ever mean "the caller lost its fingerprints",
   *     never "the admin asked to purge everything" (that is deleteByWorkspace).
   *   - fail-CLOSED (this): delete nothing, log, return 0. The worst case is some
   *     superseded rows linger until the next run's GC reclaims them — wasted disk,
   *     no data loss.
   *
   * So an empty `keep` is treated as a caller bug, not as a purge order.
   *
   * Returns the number of rows deleted (0 when nothing to reclaim).
   */
  async deleteOtherGenerations(
    workspaceId: string,
    keep: string[],
    trx?: KyselyTransaction,
  ): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const kept = keep.filter((fp) => typeof fp === 'string' && fp.length > 0);

    // Nothing to keep => refuse. Without this the query below would carry no
    // predicate but the workspace id and delete EVERY embedding row of the
    // workspace (see the fail-closed rationale above).
    if (kept.length === 0) {
      this.logger.error(
        `deleteOtherGenerations: refusing to GC workspace ${workspaceId} with an ` +
          `EMPTY keep set — that would delete every embedding row of the workspace, ` +
          `including the generation currently serving search. This is a caller bug ` +
          `(a run always keeps at least its target fingerprint); nothing was deleted.`,
      );
      return 0;
    }

    const result = await db
      .deleteFrom('pageEmbeddings')
      .where('workspaceId', '=', workspaceId)
      .where((eb) =>
        eb.or([
          // `fingerprint NOT IN (...)` evaluates to NULL (not true) for a NULL
          // fingerprint, so legacy rows need this explicit arm to be GC'd.
          eb('fingerprint', 'is', null),
          eb('fingerprint', 'not in', kept),
        ]),
      )
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /**
   * #599 — count DISTINCT non-deleted pages holding at least one row of ONE
   * generation. This is the coverage NUMERATOR: how many pages the ACTIVE
   * fingerprint actually serves (`indexed`). Mirrors the vector arm's filters
   * (workspace + fingerprint, trashed pages excluded) so the number reflects what
   * search can really retrieve.
   *
   * `changedSince` (#599 review F2) narrows the count to pages TOUCHED since a
   * given instant — i.e. how many of the pages the completed run's coverage
   * measurement no longer describes are nonetheless already covered by the active
   * generation (the event-driven indexer embedded them). computeCoverage subtracts
   * this from the numerator to split the corpus into the run's OLD bucket and the
   * CHANGED bucket; see the rule there.
   */
  async countPagesByFingerprint(
    workspaceId: string,
    fingerprint: string,
    changedSince?: Date,
  ): Promise<number> {
    let query = this.db
      .selectFrom('pageEmbeddings as pe')
      .innerJoin('pages as p', 'p.id', 'pe.pageId')
      .where('pe.workspaceId', '=', workspaceId)
      .where('pe.fingerprint', '=', fingerprint)
      .where('p.deletedAt', 'is', null)
      .where('pe.deletedAt', 'is', null);
    if (changedSince) {
      query = query.where('p.updatedAt', '>', changedSince);
    }
    const row = await query
      .select((eb) => eb.fn.count('pe.pageId').distinct().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
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
          fingerprint: row.fingerprint,
          // pgvector.toSql -> '[1,2,3]'; cast the bound literal to vector.
          embedding: sql`${pgvector.toSql(row.embedding)}::vector`,
        })),
      )
      .execute();
  }

  /**
   * #530: build the VECTOR candidate arm for SearchService's fused RRF union — a
   * page-level nearest-neighbour sub-select. Returns a `sql` fragment (not an
   * executed query) so the caller can UNION ALL it with the lexical arm inside a
   * single ranked-ids query.
   *
   * SCALING BOUNDARY: the column is dimension-agnostic, so it carries NO ANN
   * index — this is a brute-force O(N) KNN seq scan with `<=>`. Accepted for the
   * small-tenant / homelab fork target (ANN + a pinned-dimension column are
   * deferred). It is NOT unbounded, though: the caller (SearchService) runs this
   * fused query under a per-statement timeout (SEARCH_VECTOR_STATEMENT_TIMEOUT_MS)
   * and DEGRADES to lexical-only on a 57014 cancellation, so a pathological scan
   * can never hang the interactive search request.
   *
   * The arm collapses a page's chunks to its best (MIN) cosine distance:
   *   SELECT pages.id, NULL fts_score, NULL sub_tier,
   *          MIN(pe.embedding <=> $qvec) AS vec_distance
   *   FROM page_embeddings pe JOIN pages ON pages.id = pe.page_id
   *   WHERE <scope> AND pe.model_dimensions = $dim AND pe.fingerprint = $fp
   *   GROUP BY pages.id ORDER BY vec_distance LIMIT $limit
   *
   * `scope` is SearchService's shared scope predicate (workspace + space/id set +
   * creator + descendants + deleted_at), referencing the `pages` table — it must
   * be spliced verbatim so the vector candidate set mirrors the lexical scope
   * EXACTLY, minus the lexical text predicate (vector candidates need not match
   * text). The vector is bound via pgvector's `toSql(...)::vector`, and both the
   * dimension and the ACTIVE fingerprint are filtered so `<=>` only ever compares
   * compatible, same-generation vectors (pgvector errors on a dimension
   * mismatch; a fingerprint mismatch would fuse incomparable vectors).
   *
   * `workspaceId` is ALSO filtered directly on `page_embeddings` — not only via
   * the pages join. It is IMMUTABLE (there are no cross-workspace page moves), so
   * an embedding row's workspace_id always matches its page's, and this drops NO
   * legitimate hit; it lets the composite index idx_page_embeddings_ws_space_fp_dim
   * (workspace_id, space_id, fingerprint, model_dimensions) bite from its LEADING
   * column, and workspace-scopes candidates at the embedding level (defense in
   * depth).
   *
   * SPACE is deliberately NOT filtered on page_embeddings: `page_embeddings.space_id`
   * is stamped at index time and is NOT updated when a page is MOVED between spaces
   * (movePageToSpace does not reindex, and PAGE_MOVED_TO_SPACE has no reindex
   * consumer), so a moved page's rows carry the OLD space until the next reindex. A
   * `page_embeddings.space_id = ANY(scope)` predicate would then wrongly drop a
   * legitimate vector hit for a page moved INTO the searched space. Space scoping
   * is therefore enforced ONLY by the join to `pages` (pages.space_id ∈ scope,
   * always current) — the same way the lexical arm scopes, so no space leak.
   *
   * The NULL fts_score / sub_tier columns keep the arm UNION-compatible with the
   * lexical arm's column list.
   */
  vectorCandidateArm(params: {
    queryEmbedding: number[];
    dimensions: number;
    fingerprint: string;
    scope: RawBuilder<unknown>;
    limit: number;
    workspaceId: string;
  }): RawBuilder<unknown> {
    const qvec = sql`${pgvector.toSql(params.queryEmbedding)}::vector`;
    return sql`
      SELECT pages.id AS id,
             NULL::float AS fts_score,
             NULL::int AS sub_tier,
             MIN(page_embeddings.embedding <=> ${qvec}) AS vec_distance
      FROM page_embeddings
      JOIN pages ON pages.id = page_embeddings.page_id
      WHERE ${params.scope}
        AND page_embeddings.workspace_id = ${params.workspaceId}
        AND page_embeddings.model_dimensions = ${params.dimensions}
        AND page_embeddings.fingerprint = ${params.fingerprint}
      GROUP BY pages.id
      ORDER BY vec_distance ASC
      LIMIT ${params.limit}
    `;
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
   * HYBRID retrieval: fuse semantic (cosine) and lexical (full-text) chunk
   * rankings with Reciprocal Rank Fusion (RRF). Scoped to a workspace AND the
   * set of spaces the caller may read. Returns [] when `spaceIds` is empty.
   *
   * Two CTEs each rank chunks independently, then a FULL OUTER JOIN on the chunk
   * `id` fuses them. RRF combines RANKS (not raw scores), so the cosine-distance
   * and ts_rank scales never need normalizing — that is the whole point of RRF.
   *
   *   score = 1/(k + rank_semantic) + 1/(k + rank_lexical)
   *
   * with k = 60 (Cormack et al. 2009; the default in Elasticsearch, OpenSearch
   * and Weaviate) and equal 1.0/1.0 weights as a starting point. `candidates`
   * is both the per-CTE over-fetch limit and the final fused LIMIT.
   *
   * The `model_dimensions = $dim` AND `fingerprint = $fp` filters apply ONLY on
   * the semantic side, mirroring `vectorCandidateArm` (the search subsystem's
   * vector arm) EXACTLY so RAG reads the SAME same-generation invariant: `<=>`
   * only ever fuses the query against current-generation, same-dimension vectors.
   * Without the fingerprint filter, a cross-provider embedding transition (same
   * 384-dim, different provider, no reindex) would silently fuse the query against
   * STALE rows of a different generation and degrade cosine quality (#571). Both
   * `model_dimensions` (pgvector errors on a dimension mismatch) and `fingerprint`
   * (a mismatch fuses incomparable vectors) must therefore be filtered. The active
   * `$fp`/`$dim` come from the SAME `AiService.embedQuery` the search path uses, so
   * the read filters against exactly the generation the query vector was produced
   * for. The lexical side (`fts`) is generation-independent and is left unchanged.
   * Its query config is `ru_en`,
   * matched IN LOCKSTEP with the `page_embeddings.fts` generated column's config
   * (#529 acceptance #13): a mismatch silently breaks Cyrillic RAG retrieval. If
   * `websearch_to_tsquery` yields an EMPTY query (e.g. the text is all stopwords)
   * the `@@` matches
   * nothing and the lexical CTE is empty, so results degrade to pure-semantic —
   * which is correct behaviour, not an error.
   *
   * `fts` is a generated column accessed only here via raw SQL (deliberately not
   * in the Kysely `PageEmbeddings` type — see migration 20260618T150000).
   */
  async hybridSearch(
    workspaceId: string,
    queryEmbedding: number[],
    queryText: string,
    spaceIds: string[],
    // Per-CTE over-fetch AND the final fused LIMIT.
    candidates: number,
    // #571: the ACTIVE embedding fingerprint (from AiService.embedQuery, the same
    // helper the search path threads into vectorCandidateArm). The semantic CTE
    // filters `page_embeddings.fingerprint = $fp` so the query is only fused
    // against current-generation rows — never stale cross-provider vectors.
    fingerprint: string,
  ): Promise<PageEmbeddingHybridHit[]> {
    if (spaceIds.length === 0) return [];

    const queryVector = sql`${pgvector.toSql(queryEmbedding)}::vector`;
    const queryDim = queryEmbedding.length;
    const spaceList = sql.join(
      spaceIds.map((s) => sql`${s}`),
      sql`, `,
    );

    const result = await sql<{
      pageId: string;
      spaceId: string;
      title: string | null;
      content: string;
      score: number;
    }>`
      WITH semantic AS (
        SELECT pe.id, pe.page_id, pe.space_id, pe.content, p.title,
               row_number() OVER (ORDER BY pe.embedding <=> ${queryVector}) AS rank_ix
        FROM page_embeddings pe
        JOIN pages p ON p.id = pe.page_id
        WHERE pe.workspace_id = ${workspaceId}
          AND pe.space_id IN (${spaceList})
          AND pe.model_dimensions = ${queryDim}
          AND pe.fingerprint = ${fingerprint}
          AND p.deleted_at IS NULL
        ORDER BY pe.embedding <=> ${queryVector}
        LIMIT ${candidates}
      ),
      full_text AS (
        SELECT pe.id, pe.page_id, pe.space_id, pe.content, p.title,
               row_number() OVER (ORDER BY ts_rank(pe.fts, q.query) DESC) AS rank_ix
        FROM page_embeddings pe
        JOIN pages p ON p.id = pe.page_id,
             websearch_to_tsquery('ru_en', f_unaccent(${queryText})) AS q(query)
        WHERE pe.workspace_id = ${workspaceId}
          AND pe.space_id IN (${spaceList})
          AND p.deleted_at IS NULL
          AND pe.fts @@ q.query
        ORDER BY ts_rank(pe.fts, q.query) DESC
        LIMIT ${candidates}
      )
      SELECT
        coalesce(semantic.page_id, full_text.page_id)   AS "pageId",
        coalesce(semantic.space_id, full_text.space_id) AS "spaceId",
        coalesce(semantic.title, full_text.title)       AS title,
        coalesce(semantic.content, full_text.content)   AS content,
        coalesce(1.0/(60 + semantic.rank_ix), 0.0) * 1.0
          + coalesce(1.0/(60 + full_text.rank_ix), 0.0) * 1.0 AS score
      FROM semantic
      FULL OUTER JOIN full_text ON semantic.id = full_text.id
      ORDER BY score DESC
      LIMIT ${candidates}
    `.execute(this.db);

    return result.rows.map((row) => ({
      pageId: row.pageId,
      spaceId: row.spaceId,
      title: row.title,
      content: row.content,
      score: Number(row.score),
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
