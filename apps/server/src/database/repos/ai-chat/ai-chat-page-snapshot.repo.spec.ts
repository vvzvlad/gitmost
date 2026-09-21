import { AiChatPageSnapshotRepo } from './ai-chat-page-snapshot.repo';
import type { KyselyDB } from '../../types/kysely.types';

/**
 * Unit tests for AiChatPageSnapshotRepo (#274). These build the scoping /
 * conflict query, so we assert the EXACT predicates + upsert shape over a
 * chainable builder mock (no live DB): findByChatPage scopes chat + page +
 * workspace; upsert writes the values, targets the (chatId, pageId) conflict key,
 * and updates content/updatedAt on conflict. A live-Postgres round trip is out of
 * scope for this pure unit test.
 */
describe('AiChatPageSnapshotRepo', () => {
  type Recorded = {
    table?: string;
    wheres: Array<[string, string, unknown]>;
    values?: Record<string, unknown>;
    conflictColumns?: string[];
    conflictUpdate?: Record<string, unknown>;
  };

  function makeDb(result: unknown): { db: KyselyDB; rec: Recorded } {
    const rec: Recorded = { wheres: [] };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.selectAll = chain;
    builder.returningAll = chain;
    builder.where = (col: string, op: string, val: unknown) => {
      rec.wheres.push([col, op, val]);
      return builder;
    };
    builder.values = (v: Record<string, unknown>) => {
      rec.values = v;
      return builder;
    };
    builder.onConflict = (
      cb: (oc: {
        columns: (c: string[]) => { doUpdateSet: (s: Record<string, unknown>) => unknown };
      }) => unknown,
    ) => {
      cb({
        columns: (c: string[]) => {
          rec.conflictColumns = c;
          return {
            doUpdateSet: (s: Record<string, unknown>) => {
              rec.conflictUpdate = s;
              return builder;
            },
          };
        },
      });
      return builder;
    };
    builder.executeTakeFirst = () => Promise.resolve(result);
    const db = {
      selectFrom: (table: string) => {
        rec.table = table;
        return builder;
      },
      insertInto: (table: string) => {
        rec.table = table;
        return builder;
      },
    } as unknown as KyselyDB;
    return { db, rec };
  }

  describe('findByChatPage', () => {
    it('scopes by chat + page + workspace and returns the row', async () => {
      const row = { id: 's1', chatId: 'c1', pageId: 'p1', workspaceId: 'ws1' };
      const { db, rec } = makeDb(row);
      const repo = new AiChatPageSnapshotRepo(db);

      const res = await repo.findByChatPage('c1', 'p1', 'ws1');

      expect(res).toBe(row);
      expect(rec.table).toBe('aiChatPageSnapshots');
      expect(rec.wheres).toEqual([
        ['chatId', '=', 'c1'],
        ['pageId', '=', 'p1'],
        ['workspaceId', '=', 'ws1'],
      ]);
    });

    it('returns undefined when no snapshot exists yet', async () => {
      const { db } = makeDb(undefined);
      const repo = new AiChatPageSnapshotRepo(db);
      await expect(
        repo.findByChatPage('c1', 'p1', 'ws1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('upsert', () => {
    it('inserts the values and upserts on the (chatId, pageId) key', async () => {
      const { db, rec } = makeDb({ id: 's1' });
      const repo = new AiChatPageSnapshotRepo(db);
      const pageUpdatedAt = new Date('2026-07-02T10:00:00Z');

      await repo.upsert({
        chatId: 'c1',
        pageId: 'p1',
        workspaceId: 'ws1',
        contentMd: '# hello',
        pageUpdatedAt,
      });

      expect(rec.table).toBe('aiChatPageSnapshots');
      expect(rec.values).toEqual({
        chatId: 'c1',
        pageId: 'p1',
        workspaceId: 'ws1',
        contentMd: '# hello',
        pageUpdatedAt,
      });
      expect(rec.conflictColumns).toEqual(['chatId', 'pageId']);
      expect(rec.conflictUpdate).toMatchObject({
        contentMd: '# hello',
        pageUpdatedAt,
      });
      expect(rec.conflictUpdate?.updatedAt).toBeInstanceOf(Date);
    });
  });
});
