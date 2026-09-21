import { Kysely } from 'kysely';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
  createUser,
  createPage,
} from './db';

/**
 * #348 — the whole-workspace access-filter short-circuit is an ACCESS-CONTROL
 * path, so it must produce the SAME result as the full recursive-ancestor CTE.
 *
 * filterAccessiblePageIds({ workspaceId }) (no spaceId — the favorites /
 * notifications / recent / created-by / global-search callers) skips the CTE only
 * when the workspace has ZERO restricted pages. A page is "restricted &
 * inaccessible" when it (or an ancestor) has a `pageAccess` row and the user has
 * no matching `pagePermissions`. Driven against real Postgres, asserts:
 *   1. zero restrictions -> short-circuit returns the full input set;
 *   2. a restriction present -> the CTE runs and drops the page the user can't
 *      reach while keeping the reachable ones (behavior unchanged);
 *   3. inserting the FIRST pageAccess flips hasRestrictedPagesInWorkspace
 *      false -> true immediately (the 0->1 transition — now uncached, no stale
 *      window, review F1); it is scoped per workspace.
 */
describe('#348 filterAccessiblePageIds workspace short-circuit (real PG)', () => {
  let db: Kysely<any>;
  let repo: PagePermissionRepo;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let spaceId: string;

  beforeAll(async () => {
    db = getTestDb();
    // hasRestrictedPagesInWorkspace is now uncached, and no other cached
    // permission path is exercised here, so a no-op cache stub suffices.
    const cacheStub = {
      get: async () => undefined,
      set: async () => undefined,
      del: async () => undefined,
    } as never;
    repo = new PagePermissionRepo(db, new GroupRepo(db), cacheStub);

    const ws = await createWorkspace(db);
    workspaceId = ws.id;
    const other = await createWorkspace(db);
    otherWorkspaceId = other.id;
    const user = await createUser(db, workspaceId);
    userId = user.id;
    const space = await createSpace(db, workspaceId);
    spaceId = space.id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('zero restrictions: short-circuit returns the full input set', async () => {
    const p1 = await createPage(db, { workspaceId, spaceId });
    const p2 = await createPage(db, { workspaceId, spaceId });

    expect(await repo.hasRestrictedPagesInWorkspace(workspaceId)).toBe(false);

    const ids = [p1.id, p2.id];
    const filtered = await repo.filterAccessiblePageIds({
      pageIds: ids,
      userId,
      workspaceId,
    });
    expect(new Set(filtered)).toEqual(new Set(ids));
  });

  it('a restriction present: filters out the page the user cannot reach', async () => {
    const openPage = await createPage(db, { workspaceId, spaceId });
    const restrictedPage = await createPage(db, { workspaceId, spaceId });

    // Add a pageAccess row on restrictedPage with NO matching pagePermissions for
    // `userId` → the CTE anti-join marks it inaccessible for this user.
    await db
      .insertInto('pageAccess')
      .values({
        pageId: restrictedPage.id,
        workspaceId,
        spaceId,
        accessLevel: 'read',
        creatorId: userId,
      })
      .execute();

    // 0->1 transition is reflected immediately (uncached).
    expect(await repo.hasRestrictedPagesInWorkspace(workspaceId)).toBe(true);

    const filtered = await repo.filterAccessiblePageIds({
      pageIds: [openPage.id, restrictedPage.id],
      userId,
      workspaceId,
    });
    expect(filtered).toContain(openPage.id);
    expect(filtered).not.toContain(restrictedPage.id);
  });

  it('hasRestrictedPagesInWorkspace is scoped per workspace', async () => {
    // The other workspace has no pageAccess rows → still false, unaffected by the
    // restriction added above in `workspaceId`.
    expect(await repo.hasRestrictedPagesInWorkspace(otherWorkspaceId)).toBe(
      false,
    );
  });
});
