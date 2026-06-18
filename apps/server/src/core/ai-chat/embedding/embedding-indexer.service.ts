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
import { describeProviderError } from '../../../integrations/ai/ai-error.util';
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

// A single page taking longer than this during a bulk reindex is logged at
// WARN as an early "slow page" signal before the hard embedding timeout.
const SLOW_PAGE_MS = 30_000;

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

    // Prefer heading-breadcrumb chunks: each chunk is prefixed with its heading
    // path ("Page Title > H1 > H2") so the breadcrumb is embedded AND stored in
    // `content` (feeding the fts column and the agent's snippet). Walk the
    // ProseMirror JSON — NOT the markdown text — so a `#` inside a fenced code
    // block is never mistaken for a heading. Degrades to the plain-text path on
    // any error / unknown structure (returns null).
    const breadcrumbChunks = page.content
      ? await this.safeBuildBreadcrumbChunks(page.content, page.title)
      : null;

    // Fall back to plain text when breadcrumb chunking is unavailable.
    const fallbackText =
      breadcrumbChunks && breadcrumbChunks.length > 0
        ? null
        : this.extractText(page);

    // Empty page (neither path produced content) -> remove any prior embeddings
    // so search returns nothing.
    if (
      (!breadcrumbChunks || breadcrumbChunks.length === 0) &&
      (!fallbackText || fallbackText.trim().length === 0)
    ) {
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

    // Use breadcrumb chunks when available; otherwise chunk the plain text.
    let chunks: string[];
    if (breadcrumbChunks && breadcrumbChunks.length > 0) {
      chunks = breadcrumbChunks;
    } else {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: CHUNK_SIZE,
        chunkOverlap: CHUNK_OVERLAP,
      });
      chunks = await splitter.splitText(fallbackText as string);
    }
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

  /**
   * (Re)build embeddings for EVERY non-deleted page in a workspace. Used by the
   * bulk reindex (WORKSPACE_CREATE_EMBEDDINGS, fired when AI Search is enabled
   * and by the manual "Reindex now" action).
   *
   * Resolves the embeddings model once up front: if the workspace has no
   * embeddings provider configured, the whole batch is skipped (otherwise each
   * page would no-op individually after a wasted read). Pages are processed
   * sequentially and each is isolated in try/catch so one failure never aborts
   * the batch.
   */
  async reindexWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.aiService.getEmbeddingModel(workspaceId);
    } catch (err) {
      if (err instanceof AiEmbeddingNotConfiguredException) {
        this.logger.log(
          `reindexWorkspace: embeddings not configured for workspace ${workspaceId}, skipping`,
        );
        return;
      }
      throw err;
    }

    const pageIds = await this.pageRepo.getIdsByWorkspace(workspaceId);
    const total = pageIds.length;
    const startedAt = Date.now();
    this.logger.log(
      `reindexWorkspace: starting reindex of ${total} page(s) for workspace ${workspaceId}`,
    );

    let failed = 0;
    for (let i = 0; i < total; i++) {
      const pageId = pageIds[i];
      const position = i + 1;
      // Log BEFORE the await: if the embedding call hangs, this is the last line
      // in the log and it names the exact page that is stuck.
      this.logger.log(
        `reindexWorkspace: [${position}/${total}] indexing page ${pageId} (workspace ${workspaceId})`,
      );
      const pageStartedAt = Date.now();
      try {
        await this.reindexPage(pageId);
        const elapsed = Date.now() - pageStartedAt;
        if (elapsed >= SLOW_PAGE_MS) {
          this.logger.warn(
            `reindexWorkspace: [${position}/${total}] page ${pageId} took ${elapsed}ms`,
          );
        }
      } catch (err) {
        // Per-page isolation: one failure (incl. an embedding timeout) must not
        // abort the whole batch.
        failed++;
        this.logger.error(
          `reindexWorkspace: [${position}/${total}] failed to reindex page ${pageId} ` +
            `after ${Date.now() - pageStartedAt}ms: ${describeProviderError(err)}`,
        );
      }
    }

    this.logger.log(
      `reindexWorkspace: done for workspace ${workspaceId}: ` +
        `${total - failed}/${total} indexed, ${failed} failed in ${Date.now() - startedAt}ms`,
    );
  }

  /** Purge ALL embeddings for a workspace (WORKSPACE_DELETE_EMBEDDINGS). */
  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.pageEmbeddingRepo.deleteByWorkspace(workspaceId);
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
   * Map chunk strings + vectors to insertable rows. Breadcrumb-prefixed chunks
   * are NOT verbatim substrings of any source text, so chunkStart is a running
   * cumulative offset (sum of previous chunk lengths) rather than an indexOf
   * position. These offsets are informational provenance only — search returns
   * `content` and never slices by offset. chunkIndex stays a global monotonic
   * index.
   */
  private buildChunkRows(
    chunks: string[],
    vectors: number[][],
    ids: { pageId: string; workspaceId: string; spaceId: string },
    modelName: string,
  ): PageEmbeddingChunkRow[] {
    const rows: PageEmbeddingChunkRow[] = [];
    let cursor = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = vectors[i];
      if (!embedding) continue;
      const chunkStart = cursor;
      cursor += chunk.length;
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

  /**
   * Thin try/catch wrapper around buildBreadcrumbChunks. Any failure (malformed
   * structure, unknown node type, etc.) returns null so the caller degrades
   * gracefully to the plain-text chunking path.
   */
  private async safeBuildBreadcrumbChunks(
    contentJson: unknown,
    pageTitle: string | null,
  ): Promise<string[] | null> {
    try {
      return await this.buildBreadcrumbChunks(contentJson, pageTitle);
    } catch {
      return null;
    }
  }

  /**
   * Build heading-breadcrumb chunks by walking the ProseMirror JSON document.
   *
   * Each section (the body following a heading) is split with the same 1000/200
   * RecursiveCharacterTextSplitter, and every resulting piece is prefixed with
   * its heading path ("Page Title > H1 > H2"). Walking the JSON — not markdown
   * text — means a `#` inside a fenced code block is never treated as a heading
   * (ProseMirror heading nodes are explicit).
   *
   * Returns null when `contentJson` is not an object with an array `content`, so
   * the caller falls back to plain-text chunking.
   */
  private async buildBreadcrumbChunks(
    contentJson: unknown,
    pageTitle: string | null,
  ): Promise<string[] | null> {
    const doc = contentJson as { content?: unknown };
    if (
      typeof contentJson !== 'object' ||
      contentJson === null ||
      !Array.isArray(doc.content)
    ) {
      return null;
    }

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });

    const out: string[] = [];
    const stack: { level: number; text: string }[] = [];
    let buffer = '';

    // Flush the accumulated body as one or more chunks under the CURRENT crumb.
    const flush = async (): Promise<void> => {
      if (buffer.trim().length === 0) {
        buffer = '';
        return;
      }
      const crumb = [pageTitle, ...stack.map((s) => s.text)]
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .join(' > ');
      const pieces = await splitter.splitText(buffer);
      for (const piece of pieces) {
        out.push(crumb ? `${crumb}\n\n${piece}` : piece);
      }
      buffer = '';
    };

    for (const block of doc.content as Array<{
      type?: string;
      attrs?: { level?: number };
    }>) {
      if (block?.type === 'heading') {
        // Flush the preceding body under the crumb in effect BEFORE this
        // heading, then update the heading stack.
        await flush();
        const level =
          typeof block.attrs?.level === 'number' ? block.attrs.level : 1;
        // Pop deeper-or-equal headings: a new H2 replaces a prior H2/H3/...
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }
        const headingText = jsonToText({
          type: 'doc',
          content: [block],
        } as never).trim();
        if (headingText.length > 0) {
          stack.push({ level, text: headingText });
        }
      } else {
        const blockText = jsonToText({
          type: 'doc',
          content: [block],
        } as never);
        buffer = buffer.length > 0 ? `${buffer}\n${blockText}` : blockText;
      }
    }

    // Flush any trailing body after the last heading.
    await flush();

    return out;
  }
}
