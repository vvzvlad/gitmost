import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { executeTx } from '@docmost/db/utils';

/**
 * Background sweeper for temporary notes ("structure or die"). A note whose
 * frozen deadline (`pages.temporary_expires_at`) has passed is auto-moved to
 * trash via the exact same soft-delete path as a manual delete. Modelled on
 * TrashCleanupService; `@nestjs/schedule` is already enabled globally.
 */
@Injectable()
export class TemporaryNoteCleanupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TemporaryNoteCleanupService.name);

  // Cap a single sweep so a large backlog (e.g. many notes created during
  // downtime under a short lifetime) is not loaded into memory at once. The
  // remainder is drained on the next hourly run; sub-hour overshoot is fine.
  private static readonly SWEEP_BATCH_LIMIT = 500;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
  ) {}

  // Sweep once at startup so notes that expired during downtime are trashed
  // right away instead of waiting up to an hour for the first @Interval tick.
  // Best-effort: never let a startup-sweep failure block application boot.
  async onApplicationBootstrap() {
    try {
      await this.sweepExpiredTemporaryNotes();
    } catch (error) {
      this.logger.error(
        'Temporary-note startup sweep failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  // Hourly granularity: lifetimes are configured in hours, so a sub-hour
  // overshoot past the deadline is acceptable.
  @Interval('temporary-note-cleanup', 60 * 60 * 1000)
  async sweepExpiredTemporaryNotes() {
    try {
      const now = new Date();

      // Candidate ids (non-locking). The authoritative re-check happens per row
      // under a row lock below, so this cheap pass just bounds the batch.
      const expired = await this.db
        .selectFrom('pages')
        .select(['id'])
        .where('temporaryExpiresAt', 'is not', null)
        .where('temporaryExpiresAt', '<', now)
        .where('deletedAt', 'is', null) // not already in trash
        .limit(TemporaryNoteCleanupService.SWEEP_BATCH_LIMIT)
        .execute();

      let trashed = 0;
      for (const candidate of expired) {
        try {
          const didTrash = await executeTx(this.db, async (trx) => {
            // Re-check the row UNDER A LOCK inside the transaction. `FOR UPDATE
            // SKIP LOCKED`:
            //  - serialises against a concurrent "Make permanent"
            //    (toggleTemporary UPDATE takes the same row lock): if it commits
            //    first, the deadline predicate below no longer matches and we
            //    skip; if we lock first, it waits until this delete commits.
            //  - SKIP LOCKED lets a second worker/instance skip a row another
            //    sweeper already claimed instead of blocking on it (no double
            //    processing, no thundering herd).
            // The predicate re-asserts still-armed AND still-expired AND
            // not-already-trashed, so a make-permanent / prior sweep drops the row.
            const locked = await trx
              .selectFrom('pages')
              .select(['id', 'creatorId', 'workspaceId'])
              .where('id', '=', candidate.id)
              .where('temporaryExpiresAt', 'is not', null)
              .where('temporaryExpiresAt', '<', now)
              .where('deletedAt', 'is', null)
              .forUpdate()
              .skipLocked()
              .executeTakeFirst();

            if (!locked) return false;

            // Reuse the exact soft-delete path (recursive children + share
            // removal + PAGE_SOFT_DELETED broadcast), running IN this locked
            // transaction so the delete is atomic with the re-check and cannot
            // deadlock on a nested independent transaction. The broadcast is
            // deferred by removePage to this transaction's commit. Attribute the
            // automatic deletion to the note's creator (no schema change).
            await this.pageRepo.removePage(
              locked.id,
              // creatorId is set on every created page; a temporary note always
              // has one. Cast to satisfy the non-null deletedById parameter.
              locked.creatorId as string,
              locked.workspaceId,
              trx,
            );
            return true;
          });
          if (didTrash) trashed++;
        } catch (error) {
          this.logger.error(
            `Failed to trash expired temporary note ${candidate.id}`,
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
