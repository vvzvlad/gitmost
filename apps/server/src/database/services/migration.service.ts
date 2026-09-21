import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Migrator, FileMigrationProvider } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { ensureConcurrentIndexes } from '@docmost/db/concurrent-indexes';

@Injectable()
export class MigrationService {
  private readonly logger = new Logger(`Database${MigrationService.name}`);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async migrateToLatest(): Promise<void> {
    // Build write-blocking trigram indexes CONCURRENTLY (no transaction) BEFORE
    // the migrator runs, so the corresponding in-migration `CREATE INDEX IF NOT
    // EXISTS` no-ops instead of taking a SHARE lock on `pages` during deploy
    // (#495). Best-effort: on a fresh DB (no `pages`/`f_unaccent` yet) this is a
    // no-op and the migrations build the index normally.
    await ensureConcurrentIndexes(this.db, (message, error) => {
      if (error) this.logger.warn(`${message}: ${String(error)}`);
      else this.logger.log(message);
    });

    const migrator = new Migrator({
      db: this.db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(__dirname, '..', 'migrations'),
      }),
      // A long-lived branch can add a migration whose timestamped filename sorts
      // BEFORE migrations already applied in prod (e.g. #234's 20260627 landing
      // after 20260704 was live). With the default (ordered) setting the startup
      // migrator then sees "corrupted migrations" — the applied set is no longer a
      // prefix of the sorted list — throws, and the app crash-loops on boot
      // (incident #361: 502s for ~11 min). allowUnorderedMigrations runs any
      // not-yet-applied migration regardless of filename order, so a back-dated
      // migration is applied instead of bricking startup. A CI order-gate still
      // discourages back-dating; this is the runtime safety net.
      allowUnorderedMigrations: true,
    });

    const { error, results } = await migrator.migrateToLatest();

    if (results && results.length === 0) {
      this.logger.log('No pending database migrations');
      return;
    }

    results?.forEach((it) => {
      if (it.status === 'Success') {
        this.logger.log(
          `Migration "${it.migrationName}" executed successfully`,
        );
      } else if (it.status === 'Error') {
        this.logger.error(`Failed to execute migration "${it.migrationName}"`);
      }
    });

    if (error) {
      this.logger.error('Failed to run database migration. Exiting program.');
      this.logger.error(error);
      process.exit(1);
    }
  }
}
