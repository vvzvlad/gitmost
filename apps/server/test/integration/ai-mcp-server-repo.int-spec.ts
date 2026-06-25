import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AiMcpServerRepo } from '@docmost/db/repos/ai-chat/ai-mcp-server.repo';
import { getTestDb, destroyTestDb, createWorkspace } from './db';

/**
 * AiMcpServerRepo `tool_allowlist` jsonb round-trip (PR #172 / issue #173 §3).
 *
 * The fix under test is a DB round-trip, so a unit test cannot observe it: the
 * write must land as a real jsonb ARRAY (not a double-encoded string scalar),
 * and the read must repair any legacy string-scalar rows. The read-side
 * `parseToolAllowlist` MASKS a write regression (it parses the string back), so
 * without this integration check, reverting `::text::jsonb` to `::jsonb` would
 * keep every unit test green while silently corrupting the column again.
 */
describe('AiMcpServerRepo tool_allowlist jsonb round-trip [integration]', () => {
  let db: Kysely<any>;
  let repo: AiMcpServerRepo;
  let ws: string;

  beforeAll(async () => {
    db = getTestDb();
    repo = new AiMcpServerRepo(db as any);
    ws = (await createWorkspace(db)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  const jsonbTypeof = async (id: string): Promise<string | null> => {
    const res = await sql<{ t: string | null }>`
      SELECT jsonb_typeof(tool_allowlist) AS t
      FROM ai_mcp_servers WHERE id = ${id}
    `.execute(db);
    return res.rows[0]?.t ?? null;
  };

  it('insert stores the allowlist as a jsonb ARRAY (not a string scalar)', async () => {
    const row = await repo.insert({
      workspaceId: ws,
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://example.com/mcp',
      toolAllowlist: ['search', 'crawl'],
    });

    // The column holds a real jsonb array — the whole point of ::text::jsonb.
    expect(await jsonbTypeof(row.id)).toBe('array');

    // And the read returns a genuine string[], not a JSON string.
    const found = await repo.findById(row.id, ws);
    expect(found?.toolAllowlist).toEqual(['search', 'crawl']);
    expect(Array.isArray(found?.toolAllowlist)).toBe(true);
  });

  it('an empty allowlist is normalized to null (no restriction), not []', async () => {
    const row = await repo.insert({
      workspaceId: ws,
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://example.com/mcp',
      toolAllowlist: [],
    });
    // The column is SQL NULL, so jsonb_typeof returns SQL NULL (JS null).
    expect(await jsonbTypeof(row.id)).toBeNull();
    expect((await repo.findById(row.id, ws))?.toolAllowlist).toBeNull();
  });

  it('repairs a legacy double-encoded (string scalar) row on read (self-heal)', async () => {
    // Seed a row whose tool_allowlist is a jsonb STRING SCALAR holding the JSON
    // text — exactly what the old `::jsonb` double-encoding produced.
    const id = randomUUID();
    await sql`
      INSERT INTO ai_mcp_servers (id, workspace_id, name, transport, url, tool_allowlist)
      VALUES (
        ${id}, ${ws}, ${`srv-${id}`}, 'http', 'https://example.com/mcp',
        to_jsonb(${'["alpha","beta"]'}::text)
      )
    `.execute(db);

    // Sanity: the seeded column really IS the corrupt string-scalar shape.
    expect(await jsonbTypeof(id)).toBe('string');

    // The repo read heals it back to a real string[].
    expect((await repo.findById(id, ws))?.toolAllowlist).toEqual([
      'alpha',
      'beta',
    ]);
    const enabled = await repo.listEnabled(ws);
    const healed = enabled.find((r) => r.id === id);
    expect(healed?.toolAllowlist).toEqual(['alpha', 'beta']);
  });

  it('FAIL-OPEN: a present-but-corrupt tool_allowlist reads back as null (no restriction)', async () => {
    // #185 re-review pt 8: normalizeRow's fail-open branch — the column is
    // PRESENT but does not parse into a string[] (here a jsonb string scalar
    // holding non-array JSON). The read must degrade to `null` ("no restriction"),
    // not crash. (A warn is logged with the server id; not asserted here.)
    const id = randomUUID();
    await sql`
      INSERT INTO ai_mcp_servers (id, workspace_id, name, transport, url, tool_allowlist)
      VALUES (
        ${id}, ${ws}, ${`srv-${id}`}, 'http', 'https://example.com/mcp',
        to_jsonb(${'{"not":"an array"}'}::text)
      )
    `.execute(db);
    // Sanity: the column is present (a jsonb string scalar), not SQL NULL.
    expect(await jsonbTypeof(id)).toBe('string');
    // ...yet the read degrades to null (fail-open).
    expect((await repo.findById(id, ws))?.toolAllowlist).toBeNull();
  });
});

/**
 * AiMcpServerRepo `instructions` text round-trip (#180). The column is plain
 * text (no jsonb); blank/whitespace is normalized to null on both insert and
 * update so an empty guide is never persisted.
 */
describe('AiMcpServerRepo instructions round-trip [integration]', () => {
  let db: Kysely<any>;
  let repo: AiMcpServerRepo;
  let ws: string;

  beforeAll(async () => {
    db = getTestDb();
    repo = new AiMcpServerRepo(db as any);
    ws = (await createWorkspace(db)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('insert stores trimmed non-blank instructions and reads them back', async () => {
    const row = await repo.insert({
      workspaceId: ws,
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://example.com/mcp',
      instructions: '  Use search for fresh facts.  ',
    });
    expect((await repo.findById(row.id, ws))?.instructions).toBe(
      'Use search for fresh facts.',
    );
  });

  it('insert normalizes blank/whitespace instructions to null', async () => {
    const row = await repo.insert({
      workspaceId: ws,
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://example.com/mcp',
      instructions: '   ',
    });
    expect((await repo.findById(row.id, ws))?.instructions).toBeNull();
  });

  it('insert with omitted instructions stores null', async () => {
    const row = await repo.insert({
      workspaceId: ws,
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://example.com/mcp',
    });
    expect((await repo.findById(row.id, ws))?.instructions).toBeNull();
  });

  it('update sets, clears (blank => null), and leaves unchanged when absent', async () => {
    const row = await repo.insert({
      workspaceId: ws,
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://example.com/mcp',
      instructions: 'initial guide',
    });

    // Set a new value.
    await repo.update(row.id, ws, { instructions: 'updated guide' });
    expect((await repo.findById(row.id, ws))?.instructions).toBe(
      'updated guide',
    );

    // Absent in the patch => unchanged.
    await repo.update(row.id, ws, { name: 'renamed' });
    expect((await repo.findById(row.id, ws))?.instructions).toBe(
      'updated guide',
    );

    // Blank => cleared to null.
    await repo.update(row.id, ws, { instructions: '   ' });
    expect((await repo.findById(row.id, ws))?.instructions).toBeNull();
  });
});
