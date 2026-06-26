import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { PageService } from 'src/core/page/services/page.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
  createPage,
  TEST_DATABASE_URL,
} from './db';

/**
 * #207 #8 — recursive page-tree CTEs (ancestors in getPageBreadCrumbs,
 * descendants in forceDelete) must not hang when a parent/child cycle already
 * exists in the data. Before the fix neither CTE had a CYCLE clause or a depth
 * cap, so a cycle (e.g. one persisted by the #7 TOCTOU race) made withRecursive
 * loop forever — and since the move guard itself runs the ancestor CTE, a cycle
 * would disable the very guard meant to prevent it.
 *
 * The fix adds a depth counter bounded by MAX_PAGE_TREE_DEPTH to both CTEs.
 * These tests seed an A<->B cycle directly (bypassing the guard), then run the
 * real CTE paths against Postgres with a short connection-level statement_timeout
 * so a regression (an unbounded CTE) fails fast as a query timeout instead of a
 * bounded result.
 */
describe('recursive page-tree CTEs cycle/depth guard [integration]', () => {
  // Upper bound on rows the depth-capped CTEs can emit for a 2-node cycle: one
  // row per depth level 0..MAX. Kept loose so the assertion does not couple to
  // the exact constant, only to "bounded".
  const BOUNDED_MAX_ROWS = 20_000;

  let db: Kysely<any>;
  // Dedicated Kysely whose connections carry a short statement_timeout, so an
  // unbounded recursive CTE aborts quickly instead of hanging the suite.
  let timeoutDb: Kysely<any>;
  let workspaceId: string;
  let spaceId: string;

  beforeAll(async () => {
    db = getTestDb();
    timeoutDb = new Kysely<any>({
      dialect: new PostgresJSDialect({
        postgres: postgres(TEST_DATABASE_URL, {
          max: 2,
          onnotice: () => {},
          // Applied to every connection on connect: cap any single statement.
          connection: { statement_timeout: 4000 },
          types: {
            bigint: {
              to: 20,
              from: [20, 1700],
              serialize: (value: number) => value.toString(),
              parse: (value: string) => Number.parseInt(value),
            },
          },
        }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
  });

  afterAll(async () => {
    await timeoutDb.destroy();
    await destroyTestDb();
  });

  // Seed two fresh pages and wire them into a direct parent/child cycle,
  // bypassing PageService.movePage's guard the way the #7 race would.
  async function seedCycle(): Promise<{ aId: string; bId: string }> {
    const a = await createPage(db, { workspaceId, spaceId, title: 'cycle-A' });
    const b = await createPage(db, { workspaceId, spaceId, title: 'cycle-B' });
    await db
      .updateTable('pages')
      .set({ parentPageId: b.id })
      .where('id', '=', a.id)
      .execute();
    await db
      .updateTable('pages')
      .set({ parentPageId: a.id })
      .where('id', '=', b.id)
      .execute();
    return { aId: a.id, bId: b.id };
  }

  function makeService(database: Kysely<any>): PageService {
    const eventEmitter = { emit: () => true } as any;
    const attachmentQueue = { add: async () => undefined } as any;
    return new PageService(
      undefined as any, // pageRepo (unused by these paths)
      undefined as any, // pagePermissionRepo
      undefined as any, // attachmentRepo
      database as any, // db
      undefined as any, // storageService
      attachmentQueue, // attachmentQueue
      undefined as any, // aiQueue
      undefined as any, // generalQueue
      eventEmitter, // eventEmitter
      undefined as any, // collaborationGateway
      undefined as any, // watcherService
      undefined as any, // transclusionService
    );
  }

  it('getPageBreadCrumbs returns a bounded result (no hang) when a cycle exists', async () => {
    const { aId } = await seedCycle();
    const service = makeService(timeoutDb);

    // Must resolve (the depth cap stops the walk) rather than time out.
    const crumbs = await service.getPageBreadCrumbs(aId);

    expect(Array.isArray(crumbs)).toBe(true);
    expect(crumbs.length).toBeGreaterThan(1);
    expect(crumbs.length).toBeLessThanOrEqual(BOUNDED_MAX_ROWS);
  });

  it('forceDelete descendant CTE is bounded (no hang) and removes the cyclic pages', async () => {
    const { aId, bId } = await seedCycle();
    const service = makeService(timeoutDb);

    // Must complete instead of looping on the descendant CTE.
    await service.forceDelete(aId, workspaceId);

    const survivors = await db
      .selectFrom('pages')
      .select('id')
      .where('id', 'in', [aId, bId])
      .execute();
    expect(survivors).toHaveLength(0);
  });
});
