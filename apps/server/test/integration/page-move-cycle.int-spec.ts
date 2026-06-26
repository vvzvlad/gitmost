import { Kysely } from 'kysely';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from 'src/core/page/services/page.service';
import { Page } from '@docmost/db/types/entity.types';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
  createPage,
} from './db';

/**
 * #207 #7 — TOCTOU in PageService.movePage: two concurrent moves
 * ("A under B" + "B under A") must NOT be able to persist a parent/child cycle.
 *
 * Before the fix the cycle check (getPageBreadCrumbs) and the UPDATE were two
 * separate, unlocked statements, so both movers could read the same pre-write
 * acyclic snapshot, both pass the guard, and persist A.parentPageId=B AND
 * B.parentPageId=A. The fix runs the guard + UPDATE in one transaction behind a
 * per-space advisory lock, so the moves serialize: whichever commits second
 * sees the first's write and its guard rejects the cycle.
 *
 * This test drives the real PageService.movePage against a real Postgres,
 * firing the two opposing moves concurrently, and asserts that no cycle ever
 * persists (walking parentPageId from both pages always reaches a root with no
 * repeated id) and that exactly one of the two opposing moves is rejected.
 */
describe('PageService.movePage concurrent A<->B cycle guard [integration]', () => {
  let db: Kysely<any>;
  let pageRepo: PageRepo;
  let pageService: PageService;
  let workspaceId: string;
  let spaceId: string;

  // A valid fractional-index position key; movePage validates the position.
  const position = generateJitteredKeyBetween(null, null);

  beforeAll(async () => {
    db = getTestDb();
    // Event emission is a side effect movePage performs but the cycle behaviour
    // does not depend on; a no-op emitter keeps the harness minimal.
    const eventEmitter = { emit: () => true } as any;
    pageRepo = new PageRepo(db as any, {} as any, eventEmitter);
    // Only pageRepo (1), db (4) and eventEmitter (9) are touched by movePage;
    // the remaining constructor deps are unused on this path.
    pageService = new PageService(
      pageRepo,
      undefined as any,
      undefined as any,
      db as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      eventEmitter,
      undefined as any,
      undefined as any,
      undefined as any,
    );

    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  async function findPage(id: string): Promise<Page> {
    const page = await pageRepo.findById(id);
    if (!page) throw new Error(`page ${id} not found`);
    return page;
  }

  // Walk parentPageId upward from startId. Throws if a node repeats (cycle) or
  // the walk fails to terminate; returns normally only when a root is reached.
  async function assertReachesRoot(startId: string): Promise<void> {
    const seen = new Set<string>();
    let cur: string | null = startId;
    let steps = 0;
    while (cur) {
      if (seen.has(cur)) {
        throw new Error(`cycle detected: revisited ${cur}`);
      }
      seen.add(cur);
      const row: { parentPageId: string | null } | undefined = await db
        .selectFrom('pages')
        .select('parentPageId')
        .where('id', '=', cur)
        .executeTakeFirst();
      cur = row?.parentPageId ?? null;
      if (++steps > 1000) {
        throw new Error('parent walk did not terminate');
      }
    }
  }

  it('two opposing concurrent moves never persist a parent/child cycle', async () => {
    // Repeat to exercise different scheduler interleavings of the two moves.
    for (let i = 0; i < 8; i++) {
      const a = await createPage(db, { workspaceId, spaceId, title: `A-${i}` });
      const b = await createPage(db, { workspaceId, spaceId, title: `B-${i}` });

      const movedA = await findPage(a.id);
      const movedB = await findPage(b.id);

      const results = await Promise.allSettled([
        pageService.movePage(
          { pageId: a.id, parentPageId: b.id, position } as any,
          movedA,
        ),
        pageService.movePage(
          { pageId: b.id, parentPageId: a.id, position } as any,
          movedB,
        ),
      ]);

      // No cycle may have been persisted by either ordering.
      await assertReachesRoot(a.id);
      await assertReachesRoot(b.id);

      // The serialization guarantees exactly one of the opposing moves wins;
      // the other must be rejected as a subtree cycle.
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason?.message).toMatch(/into its own subtree/);
    }
  });
});
