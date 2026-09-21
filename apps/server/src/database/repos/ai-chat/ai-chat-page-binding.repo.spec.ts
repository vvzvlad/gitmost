import { AiChatPageBindingRepo } from './ai-chat-page-binding.repo';
import type { KyselyDB } from '../../types/kysely.types';

/**
 * Unit test for AiChatPageBindingRepo.findChatIdByPage — the #665 binding resolver
 * that replaced findLatestByPage behind POST /ai-chat/bound-chat. It builds the
 * scoping query, so we assert the EXACT predicates the spec mandates over a
 * chainable builder mock (no live DB): the (user, page) binding row joined to its
 * chat, re-checking creatorId + workspaceId + deletedAt at read time so a stale row
 * can never surface a foreign / cross-workspace / soft-deleted chat. A live-Postgres
 * join test (CASCADE, backfill) is the integration spec's job.
 */
describe('AiChatPageBindingRepo.findChatIdByPage', () => {
  type Recorded = {
    from?: string;
    join?: [string, string, string];
    wheres: Array<[string, string, unknown]>;
  };

  function makeDb(result: unknown): { db: KyselyDB; rec: Recorded } {
    const rec: Recorded = { wheres: [] };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.innerJoin = (t: string, a: string, b: string) => {
      rec.join = [t, a, b];
      return builder;
    };
    builder.where = (col: string, op: string, val: unknown) => {
      rec.wheres.push([col, op, val]);
      return builder;
    };
    builder.executeTakeFirst = () => Promise.resolve(result);
    const db = {
      selectFrom: (table: string) => {
        rec.from = table;
        return builder;
      },
    } as unknown as KyselyDB;
    return { db, rec };
  }

  it('returns the bound chat id and scopes by user + page + ownership + workspace + live', async () => {
    const { db, rec } = makeDb({ chatId: 'c1' });
    const repo = new AiChatPageBindingRepo(db);

    const res = await repo.findChatIdByPage('u1', 'ws1', 'p1');

    expect(res).toBe('c1');
    expect(rec.from).toBe('aiChatPageBindings as b');
    expect(rec.join).toEqual(['aiChats as c', 'c.id', 'b.chatId']);
    expect(rec.wheres).toEqual(
      expect.arrayContaining([
        ['b.userId', '=', 'u1'],
        ['b.pageId', '=', 'p1'],
        ['c.creatorId', '=', 'u1'],
        ['c.workspaceId', '=', 'ws1'],
        ['c.deletedAt', 'is', null],
      ]),
    );
  });

  it('returns null when no binding (or a filtered-out chat) matches', async () => {
    const { db } = makeDb(undefined);
    const repo = new AiChatPageBindingRepo(db);
    await expect(
      repo.findChatIdByPage('u1', 'ws1', 'p1'),
    ).resolves.toBeNull();
  });
});

/**
 * upsert / clear write-path unit tests: assert the ON CONFLICT (user_id, page_id)
 * upsert and the (user, page)-scoped delete over a chainable builder mock.
 */
describe('AiChatPageBindingRepo write path', () => {
  it('upsert inserts on the (userId,pageId) key and updates chatId on conflict', async () => {
    let insertedInto: string | undefined;
    let values: unknown;
    let conflictCols: string[] | undefined;
    let updateSet: Record<string, unknown> | undefined;
    let executed = false;

    const oc = {
      columns: (cols: string[]) => {
        conflictCols = cols;
        return oc;
      },
      doUpdateSet: (s: Record<string, unknown>) => {
        updateSet = s;
        return oc;
      },
    };
    const builder: Record<string, unknown> = {};
    builder.values = (v: unknown) => {
      values = v;
      return builder;
    };
    builder.onConflict = (fn: (b: typeof oc) => unknown) => {
      fn(oc);
      return builder;
    };
    builder.execute = () => {
      executed = true;
      return Promise.resolve();
    };
    const db = {
      insertInto: (t: string) => {
        insertedInto = t;
        return builder;
      },
    } as unknown as KyselyDB;

    const repo = new AiChatPageBindingRepo(db);
    await repo.upsert('u1', 'p1', 'c1');

    expect(insertedInto).toBe('aiChatPageBindings');
    expect(values).toMatchObject({ userId: 'u1', pageId: 'p1', chatId: 'c1' });
    expect(conflictCols).toEqual(['userId', 'pageId']);
    expect(updateSet).toMatchObject({ chatId: 'c1' });
    expect(executed).toBe(true);
  });

  it('clear deletes the (userId,pageId) row', async () => {
    const wheres: Array<[string, string, unknown]> = [];
    let deletedFrom: string | undefined;
    let executed = false;
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.where = (col: string, op: string, val: unknown) => {
      wheres.push([col, op, val]);
      return builder;
    };
    builder.execute = () => {
      executed = true;
      return Promise.resolve();
    };
    void chain;
    const db = {
      deleteFrom: (t: string) => {
        deletedFrom = t;
        return builder;
      },
    } as unknown as KyselyDB;

    const repo = new AiChatPageBindingRepo(db);
    await repo.clear('u1', 'p1');

    expect(deletedFrom).toBe('aiChatPageBindings');
    expect(wheres).toEqual([
      ['userId', '=', 'u1'],
      ['pageId', '=', 'p1'],
    ]);
    expect(executed).toBe(true);
  });
});
