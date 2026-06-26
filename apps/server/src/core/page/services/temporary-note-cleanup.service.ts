import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';

/**
 * Background sweeper for temporary notes ("structure or die"). A note whose
 * frozen deadline (`pages.temporary_expires_at`) has passed is auto-moved to
 * trash via the exact same soft-delete path as a manual delete. Modelled on
 * TrashCleanupService; `@nestjs/schedule` is already enabled globally.
 */
@Injectable()
export class TemporaryNoteCleanupService {
  private readonly logger = new Logger(TemporaryNoteCleanupService.name);

  // Cap a single sweep so a large backlog (e.g. many notes created during
  // downtime under a short lifetime) is not loaded into memory at once. The
  // remainder is drained on the next hourly run; sub-hour overshoot is fine.
  private static readonly SWEEP_BATCH_LIMIT = 500;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
  ) {}

  // Hourly granularity: lifetimes are configured in hours, so a sub-hour
  // overshoot past the deadline is acceptable.
  @Interval('temporary-note-cleanup', 60 * 60 * 1000)
  async sweepExpiredTemporaryNotes() {
    try {
      const now = new Date();

      const expired = await this.db
        .selectFrom('pages')
        .select(['id', 'creatorId', 'workspaceId'])
        .where('temporaryExpiresAt', 'is not', null)
        .where('temporaryExpiresAt', '<', now)
        .where('deletedAt', 'is', null) // not already in trash
        .limit(TemporaryNoteCleanupService.SWEEP_BATCH_LIMIT)
        .execute();

      let trashed = 0;
      for (const page of expired) {
        try {
          // Re-check the deadline at deletion time. The SELECT above is not
          // transactional, so a user may click "Make permanent"
          // (toggleTemporary sets temporary_expires_at = null) in the window
          // between the SELECT and this per-row removePage. removePage deletes
          // by id with only a `deletedAt IS NULL` filter and never re-reads the
          // deadline, so without this guard a concurrently-kept note would
          // still be trashed. Re-read the row and skip it unless it is still
          // armed AND still expired, so a concurrent make-permanent wins.
          const current = await this.db
            .selectFrom('pages')
            .select(['temporaryExpiresAt', 'deletedAt'])
            .where('id', '=', page.id)
            .executeTakeFirst();

          if (
            !current ||
            current.deletedAt !== null ||
            current.temporaryExpiresAt === null ||
            new Date(current.temporaryExpiresAt) >= now
          ) {
            // Made permanent, already trashed, or no longer expired since the
            // SELECT — leave it alone.
            continue;
          }

          // Reuse the exact soft-delete path: recursive over children, removes
          // shares in a transaction, and emits PAGE_SOFT_DELETED (tree
          // invalidation + watcher notifications). Attribute the automatic
          // deletion to the note's creator (no schema change). Both the SELECT
          // above and removePage filter `deletedAt IS NULL`, so a double sweep
          // is idempotent.
          await this.pageRepo.removePage(
            page.id,
            // creatorId is set on every created page; a temporary note always
            // has one. Cast to satisfy the non-null deletedById parameter.
            page.creatorId as string,
            page.workspaceId,
          );
          trashed++;
        } catch (error) {
          this.logger.error(
            `Failed to trash expired temporary note ${page.id}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }

      if (trashed > 0) {
        this.logger.debug(
          `Temporary-note cleanup completed: ${trashed} notes trashed`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Temporary-note cleanup job failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
