import { PageRepo } from './page.repo';

/**
 * Regression guard for #201: restorePage must disarm the temporary-note death
 * timer by setting `temporaryExpiresAt = null` alongside the un-delete fields.
 * Otherwise a restored note whose frozen deadline already passed would be
 * re-trashed by the very next cleanup sweep. There is no real DB here — a
 * chainable Kysely proxy records every `.set(...)` payload so we can assert the
 * single restore UPDATE clears the deadline.
 */
function makeRestoreDbStub(opts: {
  pageToRestore: any;
  descendants: any[];
}) {
  const setCalls: any[] = [];
  const proxy: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'set')
        return (payload: any) => {
          setCalls.push(payload);
          return proxy;
        };
      if (prop === 'executeTakeFirst')
        return () => Promise.resolve(opts.pageToRestore);
      if (prop === 'execute') return () => Promise.resolve(opts.descendants);
      if (prop === 'withRecursive')
        return (_name: string, cb: any) => {
          // Exercise the recursive CTE builder against the proxy without a DB.
          try {
            cb(proxy);
          } catch {
            // builder shape only; ignore
          }
          return proxy;
        };
      return () => proxy;
    },
  });
  return { proxy, setCalls };
}

describe('PageRepo.restorePage temporary-timer disarm (#201)', () => {
  it('clears temporaryExpiresAt together with the un-delete fields', async () => {
    const { proxy, setCalls } = makeRestoreDbStub({
      // No parent => the deleted-parent lookup and detach branch are skipped, so
      // the only UPDATE is the bulk restore we assert on.
      pageToRestore: { id: 'p1', parentPageId: null, spaceId: 's1' },
      descendants: [{ id: 'p1' }],
    });
    const eventEmitter = { emit: jest.fn() } as any;

    const repo = new PageRepo(proxy, {} as any, eventEmitter);

    await repo.restorePage('p1', 'w1');

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toEqual({
      deletedById: null,
      deletedAt: null,
      temporaryExpiresAt: null,
    });
  });
});
