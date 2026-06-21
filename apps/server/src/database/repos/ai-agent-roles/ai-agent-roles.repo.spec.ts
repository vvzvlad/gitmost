import { AiAgentRoleRepo } from './ai-agent-roles.repo';
import type { KyselyDB } from '../../types/kysely.types';

/**
 * Unit test for the SECURITY invariant carried by
 * AiAgentRoleRepo.findLiveEnabled: it is the single source of truth shared by
 * the authenticated chat and the anonymous public-share assistant for "resolve
 * a roleId to a LIVE, ENABLED role scoped to the workspace, else undefined".
 *
 * A live Postgres is out of scope here; instead we record the query the repo
 * builds and assert it pins ALL of the security filters: id, workspaceId,
 * deletedAt IS NULL, and enabled = true. If any of those `where` clauses is
 * dropped, the role scoping silently widens — this test guards exactly that.
 */
describe('AiAgentRoleRepo.findLiveEnabled', () => {
  function makeRepoWithSpy(result: unknown) {
    const where = jest.fn();
    const builder = {
      selectAll: jest.fn(() => builder),
      where: jest.fn((...args: unknown[]) => {
        where(...args);
        return builder;
      }),
      executeTakeFirst: jest.fn().mockResolvedValue(result),
    };
    const db = {
      selectFrom: jest.fn(() => builder),
    } as unknown as KyselyDB;
    return { repo: new AiAgentRoleRepo(db), db, where };
  }

  it('queries scoped to id + workspace, live (deletedAt null) AND enabled', async () => {
    const role = { id: 'r-1', workspaceId: 'ws-1', enabled: true };
    const { repo, db, where } = makeRepoWithSpy(role);

    const result = await repo.findLiveEnabled('r-1', 'ws-1');

    expect(result).toBe(role);
    expect(db.selectFrom).toHaveBeenCalledWith('aiAgentRoles');
    // Every security filter must be present.
    expect(where).toHaveBeenCalledWith('id', '=', 'r-1');
    expect(where).toHaveBeenCalledWith('workspaceId', '=', 'ws-1');
    expect(where).toHaveBeenCalledWith('deletedAt', 'is', null);
    expect(where).toHaveBeenCalledWith('enabled', '=', true);
  });

  it('returns undefined when no live+enabled role matches', async () => {
    const { repo } = makeRepoWithSpy(undefined);
    expect(await repo.findLiveEnabled('r-1', 'ws-1')).toBeUndefined();
  });
});
