import { Kysely, sql } from 'kysely';
import {
  up,
  down,
} from '../../src/database/migrations/20260708T120000-ai-chat-run-steps';
import { getTestDb, destroyTestDb } from './db';

/**
 * #492 migration up/down roundtrip on a LIVE Postgres. global-setup already
 * migrated docmost_test to latest (so the table exists at start); this drives the
 * migration's own down()/up() and asserts the table presence toggles, then leaves
 * it PRESENT (up) so the shared test DB is intact for any spec that runs after.
 */
async function tableExists(db: Kysely<any>): Promise<boolean> {
  const row = (
    await sql<{ t: string | null }>`select to_regclass('ai_chat_run_steps') as t`.execute(
      db,
    )
  ).rows[0];
  return row.t !== null;
}

async function uniqueIndexExists(db: Kysely<any>): Promise<boolean> {
  const row = (
    await sql<{
      t: string | null;
    }>`select to_regclass('ai_chat_run_steps_message_step_uidx') as t`.execute(db)
  ).rows[0];
  return row.t !== null;
}

describe('20260708 ai_chat_run_steps migration roundtrip [integration]', () => {
  let db: Kysely<any>;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    // Belt-and-suspenders: guarantee the table is present for later specs even if
    // an assertion threw mid-roundtrip.
    if (!(await tableExists(db))) await up(db);
    await destroyTestDb();
  });

  it('down() drops the table+index and up() recreates them (idempotent)', async () => {
    // Starts applied (global-setup migrated to latest).
    expect(await tableExists(db)).toBe(true);
    expect(await uniqueIndexExists(db)).toBe(true);

    await down(db);
    expect(await tableExists(db)).toBe(false);
    expect(await uniqueIndexExists(db)).toBe(false);

    await up(db);
    expect(await tableExists(db)).toBe(true);
    expect(await uniqueIndexExists(db)).toBe(true);

    // up() is idempotent (ifNotExists) — a second run is a harmless no-op.
    await expect(up(db)).resolves.not.toThrow();
    expect(await tableExists(db)).toBe(true);
  });
});
