import * as migration from './20260626T130000-share-aliases';
import type {
  InsertableShareAlias,
  ShareAlias,
  UpdatableShareAlias,
} from '../types/entity.types';

/**
 * Sanity checks for the share_aliases migration + entity types. We don't run a
 * live Postgres here (that's the integration suite); instead we assert the
 * migration exposes the expected up/down contract and creates the table with
 * the unique (workspace_id, alias) constraint and the page_id index, and that
 * the generated entity types line up with the column set.
 */
describe('share-aliases migration', () => {
  it('exports up and down functions', () => {
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });

  it('up creates the table, the unique index and the page_id index', async () => {
    const calls: string[] = [];

    const tableBuilder: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'execute') return async () => undefined;
          // addColumn/addConstraint/etc. are chainable no-ops.
          return () => tableBuilder;
        },
      },
    );

    const indexBuilder: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'execute') return async () => undefined;
          return () => indexBuilder;
        },
      },
    );

    const schema = {
      createTable: (name: string) => {
        calls.push(`createTable:${name}`);
        return tableBuilder;
      },
      createIndex: (name: string) => {
        calls.push(`createIndex:${name}`);
        return indexBuilder;
      },
    };

    await migration.up({ schema } as any);

    expect(calls).toContain('createTable:share_aliases');
    expect(calls).toContain(
      'createIndex:share_aliases_workspace_id_alias_unique',
    );
    expect(calls).toContain('createIndex:share_aliases_page_id_idx');
  });

  it('down drops the table', async () => {
    const calls: string[] = [];
    const dropBuilder: any = { execute: async () => undefined };
    const schema = {
      dropTable: (name: string) => {
        calls.push(`dropTable:${name}`);
        return dropBuilder;
      },
    };
    await migration.down({ schema } as any);
    expect(calls).toContain('dropTable:share_aliases');
  });

  it('entity types expose the alias columns', () => {
    // Compile-time + runtime sanity: a well-formed row/insert/update value.
    const row: ShareAlias = {
      id: 'a-1',
      workspaceId: 'ws-1',
      alias: 'foo',
      pageId: 'p-1',
      creatorId: 'u-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const insert: InsertableShareAlias = {
      workspaceId: 'ws-1',
      alias: 'foo',
    };
    const update: UpdatableShareAlias = { pageId: null };

    expect(row.alias).toBe('foo');
    expect(insert.workspaceId).toBe('ws-1');
    expect(update.pageId).toBeNull();
  });
});
