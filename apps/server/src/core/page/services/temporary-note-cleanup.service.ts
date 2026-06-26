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
        .execute();

      let trashed = 0;
      for (const page of expired) {
        try {
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
