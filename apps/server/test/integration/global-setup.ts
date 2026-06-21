import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { Kysely, Migrator, FileMigrationProvider } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { TEST_DATABASE_URL, buildTestDb } from './db';

const MAINTENANCE_URL =
  process.env.TEST_MAINTENANCE_DATABASE_URL ??
  'postgresql://docmost:docmost_dev_pw@localhost:5432/docmost';

const TEST_DB_NAME = 'docmost_test';

// migrate.ts points FileMigrationProvider at src/database/migrations; mirror it.
const migrationFolder = path.resolve(
  __dirname,
  '../../src/database/migrations',
);

/**
 * Jest globalSetup: (re)create the isolated test database and migrate it to
 * latest. Mirrors apps/server/src/database/migrate.ts (Kysely Migrator +
 * FileMigrationProvider) so the schema is exactly what the app expects.
 */
export default async function globalSetup(): Promise<void> {
  // 1. DROP/CREATE the test DB via the maintenance connection. These statements
  //    cannot run inside a transaction; use the raw postgres client's simple
  //    query (`.simple()`) so the driver does not wrap them.
  const maintenance = postgres(MAINTENANCE_URL, { max: 1, onnotice: () => {} });
  try {
    await maintenance`DROP DATABASE IF EXISTS docmost_test WITH (FORCE)`.simple();
    await maintenance`CREATE DATABASE docmost_test`.simple();
  } finally {
    await maintenance.end({ timeout: 5 });
  }

  // 2. Enable pgvector on the fresh DB (migrations create vector columns).
  const ext = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await ext`CREATE EXTENSION IF NOT EXISTS vector`.simple();
  } finally {
    await ext.end({ timeout: 5 });
  }

  // 3. Run all migrations to latest against docmost_test.
  const db: Kysely<any> = new Kysely<any>({
    dialect: new PostgresJSDialect({
      postgres: postgres(TEST_DATABASE_URL, { onnotice: () => {} }),
    }),
  });
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });

  const { error, results } = await migrator.migrateToLatest();
  // Fail loud on ANY errored migration, even if Migrator did not also surface a
  // top-level `error` — never run the suite against a half-migrated schema.
  const failed = (results ?? []).filter((r) => r.status === 'Error');
  await db.destroy();

  if (error || failed.length > 0) {
    const names = failed.map((r) => r.migrationName).join(', ');
    throw new Error(
      `Test DB migration failed${names ? ` (${names})` : ''}: ${
        (error as Error)?.message ?? error ?? 'errored migration result'
      }`,
    );
  }

  // 4. Pin the URL for the test workers (db.ts reads it from env).
  process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;

  // Sanity touch: open + close the shared test Kysely once so a bad connection
  // surfaces here rather than mid-suite.
  const probe = buildTestDb();
  await probe.selectFrom('workspaces').select('id').limit(1).execute();
  await probe.destroy();
}
