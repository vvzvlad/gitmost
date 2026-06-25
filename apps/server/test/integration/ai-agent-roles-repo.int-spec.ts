import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { getTestDb, destroyTestDb, createWorkspace } from './db';

/**
 * B — AiAgentRoleRepo: tenant isolation + soft-delete-aware lookups + the
 * partial unique index `WHERE deleted_at IS NULL` (migration
 * 20260620T120000-ai-agent-roles.ts). Exercises real SQL constraints.
 */
describe('AiAgentRoleRepo isolation + partial unique index [integration]', () => {
  let db: Kysely<any>;
  let repo: AiAgentRoleRepo;
  let w1: string;
  let w2: string;

  beforeAll(async () => {
    db = getTestDb();
    repo = new AiAgentRoleRepo(db as any);
    w1 = (await createWorkspace(db)).id;
    w2 = (await createWorkspace(db)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('findById / listByWorkspace exclude soft-deleted rows', async () => {
    const live = await repo.insert({
      workspaceId: w1,
      name: 'Live',
      instructions: 'x',
    });
    const dead = await repo.insert({
      workspaceId: w1,
      name: 'Dead',
      instructions: 'x',
    });
    await repo.softDelete(dead.id, w1);

    expect(await repo.findById(live.id, w1)).toBeDefined();
    expect(await repo.findById(dead.id, w1)).toBeUndefined();

    const names = (await repo.listByWorkspace(w1)).map((r) => r.name);
    expect(names).toContain('Live');
    expect(names).not.toContain('Dead');
  });

  it('findById of a W2 role from W1 context returns undefined (tenant isolation)', async () => {
    const w2role = await repo.insert({
      workspaceId: w2,
      name: 'W2Role',
      instructions: 'x',
    });

    expect(await repo.findById(w2role.id, w2)).toBeDefined();
    // Same id, wrong workspace context -> not visible.
    expect(await repo.findById(w2role.id, w1)).toBeUndefined();
  });

  it('duplicate (name, workspace) while not-deleted throws 23505 unique violation', async () => {
    await repo.insert({ workspaceId: w1, name: 'Dup', instructions: 'x' });

    let code: string | undefined;
    try {
      await repo.insert({ workspaceId: w1, name: 'Dup', instructions: 'x' });
    } catch (err: any) {
      code = err?.code ?? err?.cause?.code;
    }
    expect(code).toBe('23505');
  });

  it('same name is reusable after softDelete (partial unique index WHERE deleted_at IS NULL)', async () => {
    const first = await repo.insert({
      workspaceId: w1,
      name: 'Reusable',
      instructions: 'x',
    });
    await repo.softDelete(first.id, w1);

    // Now inserting the same name must succeed because the soft-deleted row is
    // excluded from the partial unique index.
    const second = await repo.insert({
      workspaceId: w1,
      name: 'Reusable',
      instructions: 'x',
    });
    expect(second.id).toBeDefined();
    expect(second.id).not.toBe(first.id);
  });

  it('same name in W1 and W2 is allowed (unique is per-workspace)', async () => {
    const a = await repo.insert({
      workspaceId: w1,
      name: 'CrossTenant',
      instructions: 'x',
    });
    const b = await repo.insert({
      workspaceId: w2,
      name: 'CrossTenant',
      instructions: 'x',
    });
    expect(a.id).toBeDefined();
    expect(b.id).toBeDefined();
    expect(a.id).not.toBe(b.id);
  });

  // model_config jsonb round-trip (issue #173 §1): the same double-encoding bug
  // PR #172 fixed for tool_allowlist lived in jsonbObject. A DB round-trip is the
  // only way to observe it — the write must land as a real jsonb OBJECT, and a
  // legacy string-scalar row must self-heal on read (else the model override is
  // silently dropped and the role falls back to the default model).
  const jsonbTypeof = async (id: string): Promise<string | null> => {
    const res = await sql<{ t: string | null }>`
      SELECT jsonb_typeof(model_config) AS t
      FROM ai_agent_roles WHERE id = ${id}
    `.execute(db);
    return res.rows[0]?.t ?? null;
  };

  it('insert stores model_config as a jsonb OBJECT and reads it back as an object', async () => {
    const role = await repo.insert({
      workspaceId: w1,
      name: `Model-${randomUUID()}`,
      instructions: 'x',
      modelConfig: { driver: 'gemini', chatModel: 'gemini-2.0-flash' },
    });
    expect(await jsonbTypeof(role.id)).toBe('object');
    // The returned row is already normalized to an object.
    expect(role.modelConfig).toEqual({
      driver: 'gemini',
      chatModel: 'gemini-2.0-flash',
    });
    const found = await repo.findById(role.id, w1);
    expect(found?.modelConfig).toEqual({
      driver: 'gemini',
      chatModel: 'gemini-2.0-flash',
    });
  });

  it('an empty model_config is normalized to null (no override)', async () => {
    const role = await repo.insert({
      workspaceId: w1,
      name: `Empty-${randomUUID()}`,
      instructions: 'x',
      modelConfig: {},
    });
    // The column is SQL NULL, so jsonb_typeof returns SQL NULL (JS null).
    expect(await jsonbTypeof(role.id)).toBeNull();
    expect((await repo.findById(role.id, w1))?.modelConfig).toBeNull();
  });

  it('repairs a legacy double-encoded (string scalar) model_config on read', async () => {
    const id = randomUUID();
    // Seed the corrupt string-scalar shape the old `::jsonb` bind produced.
    await sql`
      INSERT INTO ai_agent_roles (id, workspace_id, name, instructions, model_config)
      VALUES (
        ${id}, ${w1}, ${`Legacy-${id}`}, 'x',
        to_jsonb(${'{"driver":"openai","chatModel":"gpt"}'}::text)
      )
    `.execute(db);
    expect(await jsonbTypeof(id)).toBe('string'); // sanity: really corrupt

    expect((await repo.findById(id, w1))?.modelConfig).toEqual({
      driver: 'openai',
      chatModel: 'gpt',
    });
  });
});
