// Mock the `sql` tagged template so the migration's partial-index statement is
// recorded without a real database. Keep `Kysely` (type-only) intact.
const sqlCalls: string[] = [];
jest.mock('kysely', () => ({
  sql: (strings: TemplateStringsArray) => {
    sqlCalls.push(strings.join('{}'));
    return { execute: jest.fn().mockResolvedValue(undefined) };
  },
}));

import {
  up,
  down,
} from '../20260626T130000-page-temporary-notes';

/**
 * Chainable Kysely schema stub: each builder method returns `this` and records
 * (method, firstArg) so the test can assert the columns/index the migration
 * touches. `addColumn` runs its column-builder callback to exercise it.
 */
function makeSchemaStub() {
  const calls: Array<[string, any]> = [];
  const colBuilder: any = new Proxy(
    {},
    { get: () => () => colBuilder },
  );
  const builder: any = {
    schema: {} as any,
    alterTable(name: string) {
      calls.push(['alterTable', name]);
      return builder;
    },
    addColumn(name: string, _type: any, cb?: (c: any) => any) {
      calls.push(['addColumn', name]);
      if (cb) cb(colBuilder);
      return builder;
    },
    dropColumn(name: string) {
      calls.push(['dropColumn', name]);
      return builder;
    },
    dropIndex(name: string) {
      calls.push(['dropIndex', name]);
      return builder;
    },
    execute: jest.fn().mockResolvedValue(undefined),
  };
  builder.schema = builder;
  return { db: builder, calls };
}

describe('migration 20260626T130000-page-temporary-notes', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
  });

  it('up adds both columns and creates the partial cleanup index', async () => {
    const { db, calls } = makeSchemaStub();
    await up(db);

    const added = calls.filter((c) => c[0] === 'addColumn').map((c) => c[1]);
    expect(added).toContain('temporary_expires_at');
    expect(added).toContain('temporary_note_hours');

    const altered = calls.filter((c) => c[0] === 'alterTable').map((c) => c[1]);
    expect(altered).toContain('pages');
    expect(altered).toContain('workspaces');

    // The partial index is created via the raw sql tag.
    expect(sqlCalls.join(' ')).toContain('pages_temporary_expires_at_idx');
    expect(sqlCalls.join(' ')).toContain('temporary_expires_at IS NOT NULL');
    expect(sqlCalls.join(' ')).toContain('deleted_at IS NULL');
  });

  it('down reverses both columns and drops the index', async () => {
    const { db, calls } = makeSchemaStub();
    await down(db);

    const dropped = calls.filter((c) => c[0] === 'dropColumn').map((c) => c[1]);
    expect(dropped).toContain('temporary_expires_at');
    expect(dropped).toContain('temporary_note_hours');

    const droppedIdx = calls
      .filter((c) => c[0] === 'dropIndex')
      .map((c) => c[1]);
    expect(droppedIdx).toContain('pages_temporary_expires_at_idx');
  });
});
