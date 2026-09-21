import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import {
  IPageBacklinkJob,
  IPageHistoryJob,
  IPageUpdateNotificationJob,
} from '../../integrations/queue/constants/queue.interface';
import {
  extractMentions,
  extractPageMentions,
  extractInternalLinkSlugIds,
} from '../../common/helpers/prosemirror/utils';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { isDeepStrictEqual } from 'node:util';
import { CollabHistoryService } from '../services/collab-history.service';
import { WatcherService } from '../../core/watcher/watcher.service';
import { isEmptyParagraphDoc } from '../collaboration.util';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';

@Processor(QueueName.HISTORY_QUEUE)
export class HistoryProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(HistoryProcessor.name);

  constructor(
    private readonly pageHistoryRepo: PageHistoryRepo,
    private readonly pageRepo: PageRepo,
    private readonly collabHistory: CollabHistoryService,
    private readonly watcherService: WatcherService,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) private notificationQueue: Queue,
    @InjectQueue(QueueName.GENERAL_QUEUE) private generalQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<IPageHistoryJob, void>): Promise<void> {
    if (job.name !== QueueJob.PAGE_HISTORY) return;

    try {
      const { pageId } = job.data;

      // Read the page WITHOUT a lock first, only to bail early on the two cheap
      // no-write cases (page gone / empty first snapshot) without opening a
      // transaction. The authoritative check-then-write happens locked below.
      const page = await this.pageRepo.findById(pageId, {
        includeContent: true,
      });

      if (!page) {
        this.logger.warn(`Page ${pageId} not found, skipping history`);
        await this.collabHistory.clearContributors(pageId);
        return;
      }

      // #370 F3 — the snapshot decision (findPageLastHistory → saveHistory) must
      // be serialized against manual-save/boundary writers, which run under a
      // page-row lock in onStoreDocument. Without it, this processor and a
      // concurrent manual-save each read the same lastHistory (MVCC), both see
      // content != lastHistory, and both insert — producing two page_history rows
      // with IDENTICAL content (one 'idle', one 'manual'), defeating
      // promote-not-dup and the version-vs-autosave split. Taking the same
      // page-row lock makes the second writer observe the first's committed row so
      // the isDeepStrictEqual gate collapses the duplicate. Only the read+write
      // is transacted; the post-snapshot queue work stays outside.
      let contributorIds: string[] = [];
      let snapshotWritten = false;
      let lastHistoryContent: unknown;
      // #370 F8 — the contributor set popped from Redis (destructive SPOP) must be
      // restored if the snapshot does not durably land. The inner try/catch only
      // covers a throw INSIDE the callback; a COMMIT failure (connection drop,
      // serialization/deadlock abort on commit — the transient class the epic
      // already retries) throws OUTSIDE it, rolling the snapshot back while the
      // pop is already gone. We track the popped set here and restore it in the
      // outer catch so a BullMQ retry re-attributes the version. addContributors
      // is an idempotent Redis SADD, so a double-restore is harmless.
      let poppedForRestore: string[] = [];

      try {
        await executeTx(this.db, async (trx) => {
          const lockedPage = await this.pageRepo.findById(pageId, {
            includeContent: true,
            withLock: true,
            trx,
          });
          if (!lockedPage) return;

          const lastHistory = await this.pageHistoryRepo.findPageLastHistory(
            pageId,
            { includeContent: true, trx },
          );
          lastHistoryContent = lastHistory?.content;

          if (!lastHistory && isEmptyParagraphDoc(lockedPage.content as any)) {
            this.logger.debug(
              `Skipping first history for page ${pageId}: empty content`,
            );
            return;
          }

          if (
            lastHistory &&
            isDeepStrictEqual(lastHistory.content, lockedPage.content)
          ) {
            return; // already snapshotted at this content — nothing to write
          }

          contributorIds = await this.collabHistory.popContributors(pageId);
          poppedForRestore = contributorIds;
          try {
            // Pass `trx` so the watcher insert's FK check (FOR KEY SHARE on
            // pages[pageId]) runs on the SAME connection that already holds the
            // FOR UPDATE lock from findById — otherwise it takes the FK lock on a
            // separate pool connection and self-deadlocks against our own tx.
            await this.watcherService.addPageWatchers(
              contributorIds,
              pageId,
              lockedPage.spaceId,
              lockedPage.workspaceId,
              trx,
            );

            // #370 — every job on this queue is a trailing idle-flush autosnapshot.
            await this.pageHistoryRepo.saveHistory(lockedPage, {
              contributorIds,
              kind: job.data.kind ?? 'idle',
              trx,
            });
            snapshotWritten = true;
            this.logger.debug(`History created for page: ${pageId}`);
          } catch (err) {
            await this.collabHistory.addContributors(pageId, contributorIds);
            poppedForRestore = [];
            throw err;
          }
        });
      } catch (err) {
        // A throw here means the tx did NOT commit (callback threw, or the commit
        // itself failed and rolled back). If we popped contributors and the inner
        // catch did not already restore them, restore now so the retry keeps
        // attribution. snapshotWritten is irrelevant: it is set before commit, so
        // it can be true even when the commit rolled the snapshot back.
        if (poppedForRestore.length) {
          await this.collabHistory.addContributors(pageId, poppedForRestore);
        }
        throw err;
      }

      // No snapshot written (page vanished / empty-first / unchanged content) →
      // clear the contributor set for the skip cases and stop.
      if (!snapshotWritten) {
        if (!lastHistoryContent && isEmptyParagraphDoc(page.content as any)) {
          await this.collabHistory.clearContributors(pageId);
        }
        return;
      }

      {
        const mentions = extractMentions(page.content);
        const pageMentions = extractPageMentions(mentions);
        const internalLinkSlugIds = extractInternalLinkSlugIds(page.content);

        await this.generalQueue
          .add(QueueJob.PAGE_BACKLINKS, {
            pageId,
            workspaceId: page.workspaceId,
            mentions: pageMentions,
            internalLinkSlugIds,
          } as IPageBacklinkJob)
          .catch((err) => {
            this.logger.error(
              `Failed to queue backlinks for ${pageId}: ${err.message}`,
            );
          });

        if (contributorIds.length > 0 && lastHistoryContent) {
          await this.notificationQueue
            .add(QueueJob.PAGE_UPDATED, {
              pageId,
              spaceId: page.spaceId,
              workspaceId: page.workspaceId,
              actorIds: contributorIds,
            } as IPageUpdateNotificationJob)
            .catch((err) => {
              this.logger.error(
                `Failed to queue page update notification for ${pageId}: ${err.message}`,
              );
            });
        }
      }
    } catch (err) {
      throw err;
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`Processing ${job.name} for page: ${job.data.pageId}`);
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      `Failed ${job.name} for page: ${job.data.pageId}. Reason: ${job.failedReason}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
