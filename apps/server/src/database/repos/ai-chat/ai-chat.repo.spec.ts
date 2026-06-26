import { AiChatRepo } from './ai-chat.repo';
import type { KyselyDB } from '../../types/kysely.types';

/**
 * Unit test for AiChatRepo.findLatestByPage — the "bound chat" resolver behind
 * #191 (auto-open the last chat created on a document). It builds the scoping
 * query, so we assert the EXACT predicates/ordering the spec mandates over a
 * chainable builder mock (no live DB): user + workspace + page scope, the
 * deletedAt filter, newest-by-createdAt with an id tiebreaker, limit 1. A
 * live-Postgres ordering test is out of scope for this pure unit test.
 */
describe('AiChatRepo.findLatestByPage', () => {
  type Recorded = {
    table?: string;
    wheres: Array<[string, string, unknown]>;
    orderBys: Array<[string, string]>;
    limit?: number;
  };

  function makeDb(result: unknown): { db: KyselyDB; rec: Recorded } {
    const rec: Recorded = { wheres: [], orderBys: [] };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.selectAll = chain;
    builder.where = (col: string, op: string, val: unknown) => {
      rec.wheres.push([col, op, val]);
      return builder;
    };
    builder.orderBy = (col: string, dir: string) => {
      rec.orderBys.push([col, dir]);
      return builder;
    };
    builder.limit = (n: number) => {
      rec.limit = n;
      return builder;
    };
    builder.executeTakeFirst = () => Promise.resolve(result);
    const db = {
      selectFrom: (table: string) => {
        rec.table = table;
        return builder;
      },
    } as unknown as KyselyDB;
    return { db, rec };
  }

  it('returns the matched chat and scopes by user + workspace + page (deletedAt null)', async () => {
    const chat = { id: 'c1', creatorId: 'u1', workspaceId: 'ws1', pageId: 'p1' };
    const { db, rec } = makeDb(chat);
    const repo = new AiChatRepo(db);

    const res = await repo.findLatestByPage('u1', 'ws1', 'p1');

    expect(res).toBe(chat);
    expect(rec.table).toBe('aiChats');
    expect(rec.wheres).toEqual(
      expect.arrayContaining([
        ['creatorId', '=', 'u1'],
        ['workspaceId', '=', 'ws1'],
        ['pageId', '=', 'p1'],
        ['deletedAt', 'is', null],
      ]),
    );
  });

  it('orders newest-first by createdAt then id, limit 1', async () => {
    const { db, rec } = makeDb(undefined);
    const repo = new AiChatRepo(db);

    await repo.findLatestByPage('u1', 'ws1', 'p1');

    expect(rec.orderBys).toEqual([
      ['createdAt', 'desc'],
      ['id', 'desc'],
    ]);
    expect(rec.limit).toBe(1);
  });

  it('returns undefined when the page has no owned chat', async () => {
    const { db } = makeDb(undefined);
    const repo = new AiChatRepo(db);

    await expect(repo.findLatestByPage('u1', 'ws1', 'p1')).resolves.toBeUndefined();
  });
});
