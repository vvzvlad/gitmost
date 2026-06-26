import { ShareAliasRepo } from './share-alias.repo';
import type { KyselyDB } from '../../types/kysely.types';

/**
 * SQL-shape unit tests for ShareAliasRepo. A live Postgres is out of scope;
 * instead we spy on the Kysely builder to assert each method pins the
 * workspace scope (so a name in one workspace can never resolve another's
 * page) and threads the right columns.
 */
describe('ShareAliasRepo', () => {
  function makeSelectRepo(result: unknown) {
    const where = jest.fn();
    const builder: any = {
      select: jest.fn(() => builder),
      where: jest.fn((...args: unknown[]) => {
        where(...args);
        return builder;
      }),
      executeTakeFirst: jest.fn().mockResolvedValue(result),
    };
    const db = { selectFrom: jest.fn(() => builder) } as unknown as KyselyDB;
    return { repo: new ShareAliasRepo(db), db, where, builder };
  }

  it('findByAliasAndWorkspace scopes by alias AND workspace', async () => {
    const row = { id: 'a-1', alias: 'foo', workspaceId: 'ws-1' };
    const { repo, db, where } = makeSelectRepo(row);

    const res = await repo.findByAliasAndWorkspace('foo', 'ws-1');

    expect(res).toBe(row);
    expect(db.selectFrom).toHaveBeenCalledWith('shareAliases');
    expect(where).toHaveBeenCalledWith('alias', '=', 'foo');
    expect(where).toHaveBeenCalledWith('workspaceId', '=', 'ws-1');
  });

  it('findByPageId scopes by page AND workspace', async () => {
    const { repo, where } = makeSelectRepo(undefined);
    await repo.findByPageId('p-1', 'ws-1');
    expect(where).toHaveBeenCalledWith('pageId', '=', 'p-1');
    expect(where).toHaveBeenCalledWith('workspaceId', '=', 'ws-1');
  });

  it('insert writes the provided columns and returns the row', async () => {
    const values = jest.fn();
    const inserted = { id: 'a-1' };
    const builder: any = {
      values: jest.fn((v: unknown) => {
        values(v);
        return builder;
      }),
      returning: jest.fn(() => builder),
      executeTakeFirst: jest.fn().mockResolvedValue(inserted),
    };
    const db = { insertInto: jest.fn(() => builder) } as unknown as KyselyDB;
    const repo = new ShareAliasRepo(db);

    const res = await repo.insert({
      workspaceId: 'ws-1',
      alias: 'foo',
      pageId: 'p-1',
      creatorId: 'u-1',
    });

    expect(db.insertInto).toHaveBeenCalledWith('shareAliases');
    expect(values).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      alias: 'foo',
      pageId: 'p-1',
      creatorId: 'u-1',
    });
    expect(res).toBe(inserted);
  });

  it('updatePageId retargets a single row scoped by id + workspace', async () => {
    const set = jest.fn();
    const where = jest.fn();
    const builder: any = {
      set: jest.fn((s: unknown) => {
        set(s);
        return builder;
      }),
      where: jest.fn((...args: unknown[]) => {
        where(...args);
        return builder;
      }),
      returning: jest.fn(() => builder),
      executeTakeFirst: jest.fn().mockResolvedValue({ id: 'a-1' }),
    };
    const db = { updateTable: jest.fn(() => builder) } as unknown as KyselyDB;
    const repo = new ShareAliasRepo(db);

    await repo.updatePageId('a-1', 'p-2', 'ws-1');

    expect(db.updateTable).toHaveBeenCalledWith('shareAliases');
    expect(set.mock.calls[0][0].pageId).toBe('p-2');
    expect(set.mock.calls[0][0].updatedAt).toBeInstanceOf(Date);
    expect(where).toHaveBeenCalledWith('id', '=', 'a-1');
    expect(where).toHaveBeenCalledWith('workspaceId', '=', 'ws-1');
  });

  it('delete scopes by id + workspace', async () => {
    const where = jest.fn();
    const builder: any = {
      where: jest.fn((...args: unknown[]) => {
        where(...args);
        return builder;
      }),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const db = { deleteFrom: jest.fn(() => builder) } as unknown as KyselyDB;
    const repo = new ShareAliasRepo(db);

    await repo.delete('a-1', 'ws-1');

    expect(db.deleteFrom).toHaveBeenCalledWith('shareAliases');
    expect(where).toHaveBeenCalledWith('id', '=', 'a-1');
    expect(where).toHaveBeenCalledWith('workspaceId', '=', 'ws-1');
  });
});
