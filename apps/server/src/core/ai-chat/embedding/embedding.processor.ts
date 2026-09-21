import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import {
  IPageContentUpdatedJob,
  IWorkspaceEmbeddingsJob,
} from '../../../integrations/queue/constants/queue.interface';
import { EmbeddingIndexerService } from './embedding-indexer.service';
import { describeProviderError } from '../../../integrations/ai/ai-error.util';

/**
 * AI_QUEUE consumer for the vector-RAG indexer (§6.7 stage D / §14[M1]).
 *
 * All producers enqueue `{ pageIds, workspaceId }` (see
 * `persistence.extension.ts` onStoreDocument and `PageListener` for the page
 * lifecycle events). Job names map to two actions:
 *  - REINDEX  (PAGE_CONTENT_UPDATED, PAGE_CREATED, PAGE_RESTORED) -> rebuild
 *    each page's embeddings (the indexer no-ops on deleted/empty pages).
 *  - REMOVE   (PAGE_DELETED, PAGE_SOFT_DELETED) -> purge each page's embeddings
 *    so trashed/deleted content never surfaces in semantic search. (A hard
 *    delete also cascades via the FK, but the soft-delete/trash path leaves the
 *    page row, so we must purge explicitly here.)
 *
 * The worker is resilient: each page is processed independently and an
 * unconfigured-embeddings / provider error for one page never crashes the
 * worker (the indexer already no-ops on unconfigured; we still catch per page).
 */
@Processor(QueueName.AI_QUEUE)
export class EmbeddingProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingProcessor.name);

  constructor(private readonly indexer: EmbeddingIndexerService) {
    super();
  }

  async process(
    job: Job<IPageContentUpdatedJob | IWorkspaceEmbeddingsJob, void>,
  ): Promise<void> {
    // The workspace-wide jobs carry `{ workspaceId }` only (no `pageIds`), so
    // read `pageIds` defensively — it is absent on the workspace payload.
    const data: Partial<IPageContentUpdatedJob & IWorkspaceEmbeddingsJob> =
      job.data ?? {};
    const pageIds = data.pageIds ?? [];
    const workspaceId = data.workspaceId ?? '';
    const ids = Array.isArray(pageIds) ? pageIds : [];

    switch (job.name) {
      case QueueJob.PAGE_CONTENT_UPDATED:
      case QueueJob.PAGE_CREATED:
      case QueueJob.PAGE_RESTORED: {
        for (const pageId of ids) {
          try {
            await this.indexer.reindexPage(pageId);
          } catch (err) {
            // Per-page isolation: one failure must not drop the others, and an
            // embedding/provider error must not crash the worker.
            this.logger.error(
              `Failed to reindex page ${pageId}: ${this.errMessage(err)}`,
            );
          }
        }
        break;
      }

      case QueueJob.PAGE_DELETED:
      case QueueJob.PAGE_SOFT_DELETED:
      case QueueJob.DELETE_PAGE_EMBEDDINGS: {
        for (const pageId of ids) {
          try {
            await this.indexer.removePage(pageId, workspaceId);
          } catch (err) {
            this.logger.error(
              `Failed to remove embeddings for page ${pageId}: ${this.errMessage(err)}`,
            );
          }
        }
        break;
      }

      case QueueJob.WORKSPACE_CREATE_EMBEDDINGS: {
        // #599 (R2) — this one must NOT be swallowed. A bulk reindex that ends with
        // failed pages (a TEI timeout, a 429) does not flip the active generation,
        // so the workspace stays in the swap window: ~2x pgvector rows on an
        // un-indexed column, `semantic.state: 'stale'`, and lexical-only search after
        // a model change. Swallowing the error completed the job "successfully" and
        // nothing ever re-ran it — the degradation was PERMANENT from a single
        // transient hiccup. Rethrow so BullMQ fails the job and RETRIES it with
        // backoff (the reindex is enqueued with attempts: 3, see
        // AiSettingsService.reindex / WorkspaceService); the run is idempotent, so a
        // retry re-attempts exactly the pages that failed. When the attempts are
        // exhausted the job stays failed (logged by the `failed` worker event) and
        // the workspace remains in the safe old-generation-serving state — degraded
        // and VISIBLE (`stale`), never a silent success.
        //
        // #599 (review F1) — the SAME rethrow carries StaleReindexTargetError: a run
        // whose config changed mid-flight must not report success either. Its retry
        // is the ONLY thing that will ever build the new target, because the reindex
        // that config change tried to enqueue was de-duplicated against this very
        // job (a stable per-workspace jobId).
        //
        // Only the WORKSPACE-level run is retried this way: the per-page jobs above
        // keep their per-item isolation (one bad page must not re-run the others).
        try {
          await this.indexer.reindexWorkspace(workspaceId);
        } catch (err) {
          this.logger.error(
            `Failed to reindex workspace ${workspaceId}: ${this.errMessage(err)} ` +
              `(attempt ${job.attemptsMade + 1}/${job.opts?.attempts ?? 1}; the job is ` +
              `retried while attempts remain — the reindex run is idempotent)`,
          );
          throw err;
        }
        break;
      }

      case QueueJob.WORKSPACE_DELETE_EMBEDDINGS: {
        try {
          await this.indexer.removeWorkspace(workspaceId);
        } catch (err) {
          this.logger.error(
            `Failed to remove embeddings for workspace ${workspaceId}: ${this.errMessage(err)}`,
          );
        }
        break;
      }

      default:
        // Other AI_QUEUE job names are not handled here (e.g. future jobs).
        this.logger.debug(`Ignoring AI_QUEUE job: ${job.name}`);
    }
  }

  private errMessage(err: unknown): string {
    return describeProviderError(err);
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      `Error processing ${job.name} job. Reason: ${job.failedReason}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
