import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../constants';
import {
  IAddPageWatchersJob,
  ICommentMarkUpdateJob,
  IPageBacklinkJob,
} from '../constants/queue.interface';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { BacklinkRepo } from '@docmost/db/repos/backlink/backlink.repo';
import {
  WatcherRepo,
  WatcherType,
} from '@docmost/db/repos/watcher/watcher.repo';
import { InsertableWatcher, User } from '@docmost/db/types/entity.types';
import { processBacklinks } from '../tasks/backlinks.task';
import { ModuleRef } from '@nestjs/core';
import { CollaborationGateway } from '../../../collaboration/collaboration.gateway';
import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';

@Processor(QueueName.GENERAL_QUEUE)
export class GeneralQueueProcessor
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(GeneralQueueProcessor.name);
  // #399: CollaborationGateway lives in CollaborationModule. We resolve it lazily
  // via ModuleRef instead of importing that module into the @Global QueueModule —
  // CollaborationModule's own HistoryProcessor injects this module's global
  // GENERAL_QUEUE token, so a static import edge here would form a DI cycle. A
  // lazy strict:false lookup (cached) sidesteps it; the gateway is a singleton in
  // both the API-server and collab processes that run this worker.
  private collaborationGateway?: CollaborationGateway;
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly backlinkRepo: BacklinkRepo,
    private readonly watcherRepo: WatcherRepo,
    private readonly commentRepo: CommentRepo,
    private readonly moduleRef: ModuleRef,
  ) {
    super();
  }

  private getCollaborationGateway(): CollaborationGateway {
    if (!this.collaborationGateway) {
      this.collaborationGateway = this.moduleRef.get(CollaborationGateway, {
        strict: false,
      });
    }
    return this.collaborationGateway;
  }

  async process(job: Job): Promise<void> {
    try {
      switch (job.name) {
        case QueueJob.ADD_PAGE_WATCHERS: {
          const { userIds, pageId, spaceId, workspaceId } =
            job.data as IAddPageWatchersJob;
          const watchers: InsertableWatcher[] = userIds.map((userId) => ({
            userId,
            pageId,
            spaceId,
            workspaceId,
            type: WatcherType.PAGE,
            addedById: userId,
          }));
          await this.watcherRepo.insertMany(watchers);
          break;
        }

        case QueueJob.PAGE_BACKLINKS: {
          await processBacklinks(
            this.db,
            this.backlinkRepo,
            job.data as IPageBacklinkJob,
          );
          break;
        }

        case QueueJob.COMMENT_MARK_UPDATE: {
          await this.processCommentMarkUpdate(
            job.data as ICommentMarkUpdateJob,
          );
          break;
        }
      }
    } catch (err) {
      throw err;
    }
  }

  /**
   * #399: apply a comment's inline-mark mirror in the collab Y.Doc, off the HTTP
   * critical path. Runs the SAME gateway path the synchronous comment.service
   * code used (byte-identical mark op):
   *   - resolve / unresolve → resolveCommentMark (flip the `resolved` attribute),
   *     OR strip an orphan anchor when the comment row has vanished (#496);
   *   - delete → deleteCommentMark (strip the ephemeral-suggestion anchor #329).
   * The op is idempotent, so a BullMQ retry is safe. Throwing propagates to
   * WorkerHost → the job is retried and, on exhaustion, surfaces in failed-job
   * metrics (the divergence is now visible rather than a silently-swallowed warn).
   */
  private async processCommentMarkUpdate(
    data: ICommentMarkUpdateJob,
  ): Promise<void> {
    const { documentName, commentId, action, ts, userId } = data;
    // Minimal connection-context user: the store pipeline reads context.user.id
    // to attribute the change (persistence.extension). The mark mutation itself
    // does not depend on the user, so the op stays byte-identical. Deliberate
    // trade-off: the store pipeline's transient `page.updated` broadcast carries
    // only { id } here, so its live "who edited" badge loses name/avatarUrl for
    // this async mark replay. lastUpdatedById is still set correctly; the diff is
    // cosmetic and self-heals on the next real edit — worth it to stay off the
    // HTTP path and avoid re-loading the users row.
    const user = { id: userId } as User;

    if (action === 'delete') {
      await this.getCollaborationGateway().handleYjsEvent(
        'deleteCommentMark',
        documentName,
        { commentId, user },
      );
      return;
    }

    // resolve / unresolve. The comment row is written SYNCHRONOUSLY before this
    // job is enqueued, so it is the source of truth for the final resolved state
    // and its updatedAt records when that state last changed. Race-guard: if a
    // newer, OPPOSITE event has already superseded this one (its ts is older than
    // the row's last resolve-state mutation AND the row's current resolved state
    // disagrees with what this job intends — e.g. an unresolve that drained ahead
    // of this resolve), skip it rather than flip the mark to a stale state.
    const comment = await this.commentRepo.findById(commentId);
    if (!comment) {
      // #496 reconcile: the comment row is GONE (e.g. an ephemeral apply/dismiss
      // hard-deleted it while this resolve/unresolve mark job sat in the queue),
      // but its inline anchor may still live in the doc — a silent orphan mark
      // pointing at a comment that no longer exists. Self-heal by stripping it
      // instead of just returning: this closes the divergence the fire-and-forget
      // resolve/unresolve enqueue (comment.service resolveComment) could leave.
      // Idempotent — deleteCommentMark on an already-absent mark is a no-op.
      await this.getCollaborationGateway().handleYjsEvent(
        'deleteCommentMark',
        documentName,
        { commentId, user },
      );
      return;
    }
    const wantResolved = action === 'resolve';
    const rowResolved = comment.resolvedAt != null;
    const rowMutatedAt = new Date(comment.updatedAt).getTime();
    // `<=`, not `<`: on a sub-millisecond tie (two opposite toggles stamped in
    // the same ms) skip the disagreeing job rather than let queue order decide.
    // The consistent job (whose intent matches the row) short-circuits on the
    // first condition, so a real update is never dropped; only a mark that both
    // disagrees with the row AND is no newer than it is discarded.
    if (rowResolved !== wantResolved && ts <= rowMutatedAt) {
      this.logger.debug(
        `Skipping stale comment mark '${action}' for ${commentId} ` +
          `(job ts ${ts} < row ${rowMutatedAt}, row resolved=${rowResolved})`,
      );
      return;
    }

    await this.getCollaborationGateway().handleYjsEvent(
      'resolveCommentMark',
      documentName,
      { commentId, resolved: wantResolved, user },
    );
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`Processing ${job.name} job`);
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      `Error processing ${job.name} job. Reason: ${job.failedReason}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Completed ${job.name} job`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
