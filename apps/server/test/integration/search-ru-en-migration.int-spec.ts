import { Kysely, sql } from 'kysely';
import { getTestDb, destroyTestDb } from './db';
import * as migration from '../../src/database/migrations/20260707T130000-search-ru-en-config';

/**
 * #529 A1 — the ru_en config migration must be REVERSIBLE in the correct order:
 * down() moves pages.tsv + page_embeddings.fts back to `english` BEFORE dropping
 * the ru_en config (a generated column still depending on ru_en would block the
 * DROP). This roundtrips down()→up() on the already-migrated test DB and asserts
 * the config, the pages trigger and the fts generated expression each flip and
 * flip back — the deploy-critical property.
 */
describe('search ru_en config migration [integration]', () => {
  let db: Kysely<any>;

  const configExists = async () => {
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_ts_config WHERE cfgname = 'ru_en'
    `.execute(db);
    return r.rows[0].n > 0;
  };

  const ftsDef = async () => {
    const r = await sql<{ def: string }>`
      SELECT pg_get_expr(adbin, adrelid) AS def
      FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE a.attname = 'fts' AND a.attrelid = 'page_embeddings'::regclass
    `.execute(db);
    return r.rows[0]?.def ?? '';
  };

  const triggerSrc = async () => {
    const r = await sql<{ src: string }>`
      SELECT prosrc AS src FROM pg_proc WHERE proname = 'pages_tsvector_trigger'
    `.execute(db);
    return r.rows[0]?.src ?? '';
  };

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    // Restore the canonical ru_en state for any later suite regardless of where
    // a test left off. up() is now safe on an existing config (ensureRuEnConfig
    // no-ops) and re-asserts both stored sides to ru_en.
    delete process.env.SEARCH_EMBEDDINGS_FTS_INLINE_REWRITE;
    await migration.up(db);
    await destroyTestDb();
  });

  it('starts at ru_en (config present, trigger + fts on ru_en)', async () => {
    expect(await configExists()).toBe(true);
    expect(await ftsDef()).toContain('ru_en');
    expect(await triggerSrc()).toContain('ru_en');
  });

  it('down() reverts tsv + fts to english THEN drops the config', async () => {
    await migration.down(db);
    expect(await configExists()).toBe(false);
    expect(await ftsDef()).toContain('english');
    expect(await ftsDef()).not.toContain('ru_en');
    expect(await triggerSrc()).toContain('english');
  });

  it('up() re-applies ru_en cleanly (idempotent config create)', async () => {
    await migration.up(db);
    expect(await configExists()).toBe(true);
    expect(await ftsDef()).toContain('ru_en');
    expect(await triggerSrc()).toContain('ru_en');
  });

  // B1.1 — running up() a SECOND time on an already-migrated DB is a true no-op:
  // it must NOT throw (the old drop-recreate-config would fail on the fts hard
  // dependency) and must NOT re-rewrite the embeddings table — the fts column
  // already references ru_en, so the at-target check short-circuits.
  it('up() is idempotent: a 2nd run does not error and leaves ru_en intact', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await configExists()).toBe(true);
    expect(await ftsDef()).toContain('ru_en');
    expect(await triggerSrc()).toContain('ru_en');
  });

  // B1.2 — env-gate opt-out: with SEARCH_EMBEDDINGS_FTS_INLINE_REWRITE=false the
  // embeddings rewrite is SKIPPED (fts stays where it was) but pages.tsv still
  // swaps inline, and the ru_en config is left in place (fts still depends on it).
  // Runs down() as the vehicle: english is NOT the current fts config, so the
  // skip path — not the at-target no-op — is exercised.
  it('env-gate=false: skips the fts rewrite but still swaps pages.tsv', async () => {
    // Precondition: fts + trigger on ru_en (from the prior test).
    expect(await ftsDef()).toContain('ru_en');
    process.env.SEARCH_EMBEDDINGS_FTS_INLINE_REWRITE = 'false';
    try {
      await migration.down(db);
      // fts rewrite skipped → still ru_en (the ACCESS EXCLUSIVE rewrite avoided).
      expect(await ftsDef()).toContain('ru_en');
      expect(await ftsDef()).not.toContain('english');
      // pages.tsv trigger still swapped inline to english (gate is fts-only).
      expect(await triggerSrc()).toContain('english');
      // Config left in place because fts still references it (guarded drop).
      expect(await configExists()).toBe(true);
    } finally {
      // Restore ru_en fully for the afterAll / later suites.
      delete process.env.SEARCH_EMBEDDINGS_FTS_INLINE_REWRITE;
      await migration.up(db);
      expect(await ftsDef()).toContain('ru_en');
      expect(await triggerSrc()).toContain('ru_en');
    }
  });
});
