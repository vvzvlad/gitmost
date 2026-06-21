import { Kysely } from 'kysely';
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
    const live = await repo.insert({ workspaceId: w1, name: 'Live', instructions: 'x' });
    const dead = await repo.insert({ workspaceId: w1, name: 'Dead', instructions: 'x' });
    await repo.softDelete(dead.id, w1);

    expect(await repo.findById(live.id, w1)).toBeDefined();
    expect(await repo.findById(dead.id, w1)).toBeUndefined();

    const names = (await repo.listByWorkspace(w1)).map((r) => r.name);
    expect(names).toContain('Live');
    expect(names).not.toContain('Dead');
  });

  it('findById of a W2 role from W1 context returns undefined (tenant isolation)', async () => {
    const w2role = await repo.insert({ workspaceId: w2, name: 'W2Role', instructions: 'x' });

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
    const first = await repo.insert({ workspaceId: w1, name: 'Reusable', instructions: 'x' });
    await repo.softDelete(first.id, w1);

    // Now inserting the same name must succeed because the soft-deleted row is
    // excluded from the partial unique index.
    const second = await repo.insert({ workspaceId: w1, name: 'Reusable', instructions: 'x' });
    expect(second.id).toBeDefined();
    expect(second.id).not.toBe(first.id);
  });

  it('same name in W1 and W2 is allowed (unique is per-workspace)', async () => {
    const a = await repo.insert({ workspaceId: w1, name: 'CrossTenant', instructions: 'x' });
    const b = await repo.insert({ workspaceId: w2, name: 'CrossTenant', instructions: 'x' });
    expect(a.id).toBeDefined();
    expect(b.id).toBeDefined();
    expect(a.id).not.toBe(b.id);
  });
});
