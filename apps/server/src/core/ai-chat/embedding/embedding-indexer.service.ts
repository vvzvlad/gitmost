import { Injectable, Logger } from '@nestjs/common';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import {
  PageEmbeddingRepo,
  PageEmbeddingChunkRow,
} from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@docmost/db/utils';
import { AiService } from '../../../integrations/ai/ai.service';
import { AiEmbeddingNotConfiguredException } from '../../../integrations/ai/ai-embedding-not-configured.exception';
import { jsonToText } from '../../../collaboration/collaboration.util';

// NOTE: the `page_embeddings.embedding` column is now dimension-agnostic
// (bare pgvector `vector`, see migration 20260617T140000), so the indexer
// stores WHATEVER dimension the configured model returns and records it per row
// in `model_dimensions`. There is no fixed-dimension guard any more; search
// compares only same-dimension rows. Trade-off: a dimension-agnostic column has
// no ANN index, so retrieval is a seq scan with `<=>` (fine at wiki scale).

// RecursiveCharacterTextSplitter settings. ~1000 chars per chunk with 200 char
// overlap is a reasonable default for prose retrieval (§6.7 stage D).
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

/**
 * Vector-RAG indexer (§6.7 stage D / §14[M1]). Turns a page's plain text into
 * chunk embeddings and persists them so the `semanticSearch` agent tool can do
 * cosine ANN retrieval.
 *
 * Everything is workspace-scoped. Reindex HARD-replaces a page's rows (delete +
 * insert in one transaction) so search never serves stale vectors.
 */
@Injectable()
export class EmbeddingIndexerService {
  private readonly logger = new Logger(EmbeddingIndexerService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageEmbeddingRepo: PageEmbeddingRepo,
    private readonly aiService: AiService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * (Re)build the embeddings for a single page.
   *
   * No-ops quietly when embeddings are unconfigured (so the queue never dies on
   * an unconfigured workspace). Any embedding dimension is accepted; the only
   * defensive skip is a page whose chunks somehow yield mixed vector lengths.
   * Deleted/empty pages have their rows purged and return.
   */
  async reindexPage(pageId: string): Promise<void> {
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeTextContent: true,
    });

    if (!page) {
      // The page row is gone; nothing references its embeddings to delete by
      // workspace, and the FK cascade already removed them. Nothing to do.
      this.logger.debug(`reindexPage: page ${pageId} not found, skipping`);
      return;
    }

    const { workspaceId, spaceId } = page;

    // Deleted page -> drop its embeddings and stop.
    if (page.deletedAt) {
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
      return;
    }

    const text = this.extractText(page);
    if (!text || text.trim().length === 0) {
      // Empty page -> remove any prior embeddings so search returns nothing.
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
      return;
    }

    // Resolve embeddings config WITHOUT crashing the queue when unconfigured.
    let modelName = 'unknown';
    try {
      const model = await this.aiService.getEmbeddingModel(workspaceId);
      // Record the model id per row so a future migration can detect + re-index
      // rows produced by a different model (see the migration header). The SDK
      // type is `string | EmbeddingModel{V2,V3}`; model objects carry `modelId`.
      modelName =
        typeof model === 'string' ? model : (model.modelId ?? 'unknown');
    } catch (err) {
      if (err instanceof AiEmbeddingNotConfiguredException) {
        // No embeddings provider for this workspace: NO-OP (§6.7). The page can
        // be indexed later once a provider is configured.
        this.logger.debug(
          `reindexPage: embeddings not configured for workspace ${workspaceId}, skipping page ${pageId}`,
        );
        return;
      }
      throw err;
    }

    // Chunk the plain text.
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });
    const chunks = await splitter.splitText(text);
    if (chunks.length === 0) {
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
      return;
    }

    // Embed all chunks in one batch.
    const vectors = await this.aiService.embedTexts(workspaceId, chunks);

    // The column is dimension-agnostic, so ANY model dimension is stored as-is.
    // Defensive sanity check only: all chunks of ONE page come from the SAME
    // model and must share a dimension. A page that yields mixed lengths would
    // poison the per-dimension search filter, so skip it with a warning rather
    // than insert inconsistent rows.
    const expectedDim = vectors[0]?.length;
    if (expectedDim != null) {
      const mixed = vectors.find((v) => v.length !== expectedDim);
      if (mixed) {
        this.logger.warn(
          `reindexPage: mixed embedding dimensions (${expectedDim} vs ${mixed.length}) ` +
            `for workspace ${workspaceId}; skipping page ${pageId}.`,
        );
        return;
      }
    }

    const rows = this.buildChunkRows(
      chunks,
      vectors,
      text,
      { pageId, workspaceId, spaceId },
      modelName,
    );

    // HARD replace in one transaction: delete then insert so search never
    // returns stale vectors for this page.
    await executeTx(this.db, async (trx) => {
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId, trx);
      await this.pageEmbeddingRepo.insertChunks(rows, trx);
    });

    this.logger.debug(
      `reindexPage: indexed ${rows.length} chunk(s) for page ${pageId}`,
    );
  }

  /** Remove all embeddings for a deleted page (used by the delete path). */
  async removePage(pageId: string, workspaceId: string): Promise<void> {
    await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
  }

  /**
   * Get the page's plain text. Prefers the stored `textContent`; falls back to
   * extracting text from the ProseMirror JSON `content` when textContent is
   * absent (e.g. older rows).
   */
  private extractText(page: {
    textContent?: string | null;
    content?: unknown;
  }): string {
    if (typeof page.textContent === 'string' && page.textContent.length > 0) {
      return page.textContent;
    }
    if (page.content) {
      try {
        return jsonToText(page.content as never) ?? '';
      } catch {
        return '';
      }
    }
    return '';
  }

  /**
   * Map chunk strings + vectors to insertable rows, computing chunkStart /
   * chunkLength against the source text. A moving cursor handles repeated
   * substrings and overlap so offsets stay monotonic.
   */
  private buildChunkRows(
    chunks: string[],
    vectors: number[][],
    sourceText: string,
    ids: { pageId: string; workspaceId: string; spaceId: string },
    modelName: string,
  ): PageEmbeddingChunkRow[] {
    const rows: PageEmbeddingChunkRow[] = [];
    let cursor = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = vectors[i];
      if (!embedding) continue;
      const found = sourceText.indexOf(chunk, cursor);
      const chunkStart = found >= 0 ? found : cursor;
      // Advance the cursor past the start so later identical chunks resolve to
      // later occurrences (overlap keeps the next search valid).
      cursor = chunkStart + 1;
      rows.push({
        pageId: ids.pageId,
        workspaceId: ids.workspaceId,
        spaceId: ids.spaceId,
        // Page-body chunk: no attachment.
        attachmentId: null,
        chunkIndex: i,
        chunkStart,
        chunkLength: chunk.length,
        content: chunk,
        // Provenance for a future re-index sweep on model change.
        modelName,
        modelDimensions: embedding.length,
        embedding,
      });
    }
    return rows;
  }
}
