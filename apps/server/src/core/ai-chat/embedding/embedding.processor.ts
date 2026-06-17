import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { IPageContentUpdatedJob } from '../../../integrations/queue/constants/queue.interface';
import { EmbeddingIndexerService } from './embedding-indexer.service';

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

  async process(job: Job<IPageContentUpdatedJob, void>): Promise<void> {
    const { pageIds, workspaceId } = job.data ?? {
      pageIds: [],
      workspaceId: '',
    };
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

      default:
        // Other AI_QUEUE job names are not handled here (e.g. future jobs).
        this.logger.debug(`Ignoring AI_QUEUE job: ${job.name}`);
    }
  }

  private errMessage(err: unknown): string {
    return err instanceof Error ? err.message : 'Unknown error';
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
