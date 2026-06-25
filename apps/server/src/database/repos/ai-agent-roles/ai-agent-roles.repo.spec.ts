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

    // The repo normalizes the row (modelConfig parse), so it returns a COPY, not
    // the same reference; assert the row's fields are carried through.
    expect(result).toMatchObject({
      id: 'r-1',
      workspaceId: 'ws-1',
      enabled: true,
    });
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

/**
 * Column-threading tests for the auto-start feature: insert defaults autoStart to
 * true and stores an empty launchMessage as null; update only sets a column when
 * the patch field is present, and clears launchMessage to null on empty string.
 */
describe('AiAgentRoleRepo insert/update auto-start columns', () => {
  function makeInsertRepo() {
    const values = jest.fn();
    const builder = {
      values: jest.fn((v: unknown) => {
        values(v);
        return builder;
      }),
      returningAll: jest.fn(() => builder),
      executeTakeFirst: jest.fn().mockResolvedValue({}),
    };
    const db = {
      insertInto: jest.fn(() => builder),
    } as unknown as KyselyDB;
    return { repo: new AiAgentRoleRepo(db), values };
  }

  function makeUpdateRepo() {
    const set = jest.fn();
    const builder = {
      set: jest.fn((s: unknown) => {
        set(s);
        return builder;
      }),
      where: jest.fn(() => builder),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const db = {
      updateTable: jest.fn(() => builder),
    } as unknown as KyselyDB;
    return { repo: new AiAgentRoleRepo(db), set };
  }

  it('insert defaults autoStart to true and stores empty launchMessage as null', async () => {
    const { repo, values } = makeInsertRepo();
    await repo.insert({
      workspaceId: 'ws-1',
      name: 'R',
      instructions: 'do',
      launchMessage: '',
    });
    const v = values.mock.calls[0][0];
    expect(v.autoStart).toBe(true);
    expect(v.launchMessage).toBeNull();
  });

  it('insert threads autoStart:false and a launchMessage', async () => {
    const { repo, values } = makeInsertRepo();
    await repo.insert({
      workspaceId: 'ws-1',
      name: 'R',
      instructions: 'do',
      autoStart: false,
      launchMessage: 'Go',
    });
    const v = values.mock.calls[0][0];
    expect(v.autoStart).toBe(false);
    expect(v.launchMessage).toBe('Go');
  });

  it('update omits unchanged columns; clears launchMessage to null on empty', async () => {
    const { repo, set } = makeUpdateRepo();
    await repo.update('r-1', 'ws-1', { autoStart: false });
    expect(set.mock.calls[0][0].autoStart).toBe(false);
    expect('launchMessage' in set.mock.calls[0][0]).toBe(false);

    const { repo: repo2, set: set2 } = makeUpdateRepo();
    await repo2.update('r-1', 'ws-1', { launchMessage: '' });
    expect(set2.mock.calls[0][0].launchMessage).toBeNull();
    expect('autoStart' in set2.mock.calls[0][0]).toBe(false);
  });
});
