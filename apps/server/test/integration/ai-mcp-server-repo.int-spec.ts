import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { AiMcpServerRepo } from '@docmost/db/repos/ai-chat/ai-mcp-server.repo';
import { getTestDb, destroyTestDb, createWorkspace, createUser } from './db';

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

  // #476 (deliberate behaviour change): an empty allowlist used to be
  // normalized to SQL NULL, which downstream means "no restriction" — so an
  // admin's deny-all `[]` silently became allow-all. It must now round-trip as
  // a real jsonb `[]` (deny-all), distinct from NULL.
  it('an empty allowlist round-trips as jsonb [] (deny-all), not null (#476)', async () => {
    const row = await repo.insert({
      workspaceId: ws,
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://example.com/mcp',
      toolAllowlist: [],
    });
    // The column holds a real (empty) jsonb ARRAY, not SQL NULL.
    expect(await jsonbTypeof(row.id)).toBe('array');
    expect((await repo.findById(row.id, ws))?.toolAllowlist).toEqual([]);
  });

  it('update to [] persists jsonb [] and update to null clears to SQL NULL (#476)', async () => {
    const row = await repo.insert({
      workspaceId: ws,
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://example.com/mcp',
      toolAllowlist: ['search'],
    });

    // Deny-all via update: [] must survive as a real jsonb array.
    await repo.update(row.id, ws, { toolAllowlist: [] });
    expect(await jsonbTypeof(row.id)).toBe('array');
    expect((await repo.findById(row.id, ws))?.toolAllowlist).toEqual([]);

    // Explicit clear (null) still means "no restriction" = SQL NULL.
    await repo.update(row.id, ws, { toolAllowlist: null });
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

  // #476 (deliberate behaviour change, replaces the old FAIL-OPEN pin): a
  // present-but-corrupt tool_allowlist used to degrade to null ("no
  // restriction"), silently handing the agent ALL of the server's tools. It
  // must now FAIL CLOSED to `[]` (deny-all) and log an error.
  it('FAIL-CLOSED: a present-but-corrupt tool_allowlist reads back as [] (deny-all) + error log (#476)', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      // The column is PRESENT but does not parse into a string[] — a jsonb
      // string scalar holding unparseable text (a truncated legacy write).
      const id = randomUUID();
      await sql`
        INSERT INTO ai_mcp_servers (id, workspace_id, name, transport, url, tool_allowlist)
        VALUES (
          ${id}, ${ws}, ${`srv-${id}`}, 'http', 'https://example.com/mcp',
          to_jsonb(${'{oops'}::text)
        )
      `.execute(db);
      // Sanity: the column is present (a jsonb string scalar), not SQL NULL.
      expect(await jsonbTypeof(id)).toBe('string');
      // ...and the read degrades to [] (fail-closed deny-all), not null.
      expect((await repo.findById(id, ws))?.toolAllowlist).toEqual([]);
      // The narrowing is not silent: an error names the server id (never the
      // corrupt contents).
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Corrupt tool_allowlist for MCP server ${id}`),
      );
      expect(
        errorSpy.mock.calls.some((c) => String(c[0]).includes('{oops')),
      ).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('FAIL-CLOSED: corrupt non-array JSON (an object) also reads back as [] (#476)', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const id = randomUUID();
      await sql`
        INSERT INTO ai_mcp_servers (id, workspace_id, name, transport, url, tool_allowlist)
        VALUES (
          ${id}, ${ws}, ${`srv-${id}`}, 'http', 'https://example.com/mcp',
          to_jsonb(${'{"not":"an array"}'}::text)
        )
      `.execute(db);
      expect(await jsonbTypeof(id)).toBe('string');
      expect((await repo.findById(id, ws))?.toolAllowlist).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
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

/**
 * Personal external MCP servers (#686): the `user_id` column, admin/personal
 * isolation (the repo is the barrier), and the admin-first agent union order.
 *
 * These are DB-observable properties — a unit test cannot see the WHERE-scoping
 * or the SQL ORDER BY — so they live here (ARCH INVARIANT #8).
 */
describe('AiMcpServerRepo personal servers + admin isolation [integration]', () => {
  let db: Kysely<any>;
  let repo: AiMcpServerRepo;
  let ws: string;
  let userA: string;
  let userB: string;

  const seed = (
    over: { userId?: string | null; name?: string; enabled?: boolean } = {},
  ) =>
    repo.insert({
      workspaceId: ws,
      userId: over.userId ?? null,
      name: over.name ?? `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: over.enabled ?? true,
    });

  beforeAll(async () => {
    db = getTestDb();
    repo = new AiMcpServerRepo(db as any);
    ws = (await createWorkspace(db)).id;
    userA = (await createUser(db, ws)).id;
    userB = (await createUser(db, ws)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('insert persists user_id and findByIdForUser reads back a personal row', async () => {
    const admin = await seed();
    const personal = await seed({ userId: userA });

    expect(admin.userId).toBeNull();
    expect(personal.userId).toBe(userA);

    // Owner can read their personal row; the raw read is scope-agnostic.
    expect((await repo.findByIdForUser(personal.id, ws, userA))?.id).toBe(
      personal.id,
    );
    expect((await repo.findByIdRaw(personal.id))?.userId).toBe(userA);
  });

  it('admin reads NEVER return a personal row', async () => {
    const personal = await seed({ userId: userA });

    // findById (admin scope) cannot see a personal row...
    expect(await repo.findById(personal.id, ws)).toBeUndefined();
    // ...nor can the admin list / enabled-list.
    const listed = await repo.listByWorkspace(ws);
    expect(listed.some((r) => r.id === personal.id)).toBe(false);
    expect(listed.every((r) => r.userId === null)).toBe(true);
    const enabled = await repo.listEnabled(ws);
    expect(enabled.some((r) => r.id === personal.id)).toBe(false);
  });

  it('admin update/delete cannot mutate a personal row (repo is the barrier)', async () => {
    const personal = await seed({ userId: userA, name: 'original' });

    // Admin update is scoped user_id IS NULL, so this is a no-op on a personal row.
    await repo.update(personal.id, ws, { name: 'hijacked' });
    expect((await repo.findByIdRaw(personal.id))?.name).toBe('original');

    // Admin delete likewise cannot remove it.
    await repo.delete(personal.id, ws);
    expect(await repo.findByIdRaw(personal.id)).toBeDefined();
  });

  it('personal update/delete are owner-scoped (userB cannot touch userA rows)', async () => {
    const personal = await seed({ userId: userA, name: 'a-owned' });

    await repo.updateForUser(personal.id, ws, userB, { name: 'stolen' });
    expect((await repo.findByIdRaw(personal.id))?.name).toBe('a-owned');

    await repo.deleteForUser(personal.id, ws, userB);
    expect(await repo.findByIdRaw(personal.id)).toBeDefined();

    // The real owner can.
    await repo.updateForUser(personal.id, ws, userA, { name: 'renamed' });
    expect((await repo.findByIdForUser(personal.id, ws, userA))?.name).toBe(
      'renamed',
    );
  });

  it('listEnabledForAgent unions admin + the caller only, ordered admin-first', async () => {
    // Fresh workspace so ordering assertions are not polluted by prior rows.
    const w = (await createWorkspace(db)).id;
    const uA = (await createUser(db, w)).id;
    const uB = (await createUser(db, w)).id;
    const mk = (o: { userId?: string | null; enabled?: boolean }) =>
      repo.insert({
        workspaceId: w,
        userId: o.userId ?? null,
        name: `srv-${randomUUID()}`,
        transport: 'http',
        url: 'https://example.com/mcp',
        enabled: o.enabled ?? true,
      });

    const admin1 = await mk({ userId: null });
    const admin2 = await mk({ userId: null });
    const aPersonal = await mk({ userId: uA });
    const bPersonal = await mk({ userId: uB });
    await mk({ userId: uA, enabled: false }); // disabled -> excluded

    const forA = await repo.listEnabledForAgent(w, uA);
    const ids = forA.map((r) => r.id);

    // Only uA's personal row is included; uB's is not; the disabled one is not.
    expect(ids).toContain(aPersonal.id);
    expect(ids).not.toContain(bPersonal.id);
    expect(forA.every((r) => r.userId === null || r.userId === uA)).toBe(true);
    expect(forA.some((r) => r.userId === uA && r.enabled === false)).toBe(false);

    // Admin-first: every admin (null) row precedes every personal row.
    const firstPersonalIdx = forA.findIndex((r) => r.userId !== null);
    const lastAdminIdx = forA.map((r) => r.userId).lastIndexOf(null);
    expect(lastAdminIdx).toBeLessThan(firstPersonalIdx);
    // Both admin rows are present, created_at ASC (admin1 before admin2).
    expect(ids.indexOf(admin1.id)).toBeLessThan(ids.indexOf(admin2.id));
  });

  it('countByUser counts only that user, across enabled + disabled', async () => {
    const w = (await createWorkspace(db)).id;
    const uA = (await createUser(db, w)).id;
    const uB = (await createUser(db, w)).id;
    const mk = (userId: string | null, enabled = true) =>
      repo.insert({
        workspaceId: w,
        userId,
        name: `srv-${randomUUID()}`,
        transport: 'http',
        url: 'https://example.com/mcp',
        enabled,
      });

    await mk(null); // admin row — must NOT count
    await mk(uA);
    await mk(uA, false); // disabled personal still counts toward the cap
    await mk(uB);

    expect(await repo.countByUser(uA)).toBe(2);
    expect(await repo.countByUser(uB)).toBe(1);

    const forU = await repo.listByUser(w, uA);
    expect(forU.length).toBe(2);
    expect(forU.every((r) => r.userId === uA)).toBe(true);
  });
});
