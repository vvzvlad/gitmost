import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ShareAliasRepo } from '@docmost/db/repos/share-alias/share-alias.repo';
import { ShareAliasService } from 'src/core/share/share-alias.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
  createPage,
} from './db';

/**
 * Issue #226 (regression of #205): "a page has EXACTLY ONE custom address".
 * Exercises against real Postgres:
 *   - the partial unique index `(workspace_id, page_id) WHERE page_id IS NOT NULL`
 *     (migration 20260627T120000) — one alias per page, but dangling aliases
 *     (page_id NULL) may coexist;
 *   - the migration's dedup DELETE keeps the NEWEST row per page;
 *   - ShareAliasService.setAlias renames in place (te -> ted) instead of
 *     spawning a second row, and self-heals the page down to one alias.
 */
describe('share_aliases one-per-page invariant [integration]', () => {
  let db: Kysely<any>;
  let repo: ShareAliasRepo;
  let service: ShareAliasService;
  let wsId: string;
  let spaceId: string;

  // setAlias only consults pageRepo on the unconfirmed-reassign (409) path.
  const pageRepo = {
    findById: async (id: string) => ({ id, title: `title-${id}` }),
  };

  beforeAll(async () => {
    db = getTestDb();
    repo = new ShareAliasRepo(db as any);
    service = new ShareAliasService(
      repo as any,
      pageRepo as any,
      {} as any, // shareService — unused by setAlias
      db as any,
    );
    wsId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, wsId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  const newPage = async (): Promise<string> =>
    (await createPage(db, { workspaceId: wsId, spaceId })).id;

  const aliasRowsFor = (pageId: string) =>
    db
      .selectFrom('shareAliases')
      .select(['id', 'alias'])
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', wsId)
      .orderBy('alias')
      .execute();

  it('partial unique index rejects a second alias for the same page (23505)', async () => {
    const pageId = await newPage();
    await repo.insert({ workspaceId: wsId, alias: 'first', pageId });

    let code: string | undefined;
    try {
      await repo.insert({ workspaceId: wsId, alias: 'second', pageId });
    } catch (err: any) {
      code = err?.code ?? err?.cause?.code;
    }
    expect(code).toBe('23505');
  });

  it('allows multiple DANGLING aliases (page_id NULL) — partial index excludes them', async () => {
    const a = await repo.insert({
      workspaceId: wsId,
      alias: `dangling-${randomUUID().slice(0, 8)}`,
      pageId: null as any,
    });
    const b = await repo.insert({
      workspaceId: wsId,
      alias: `dangling-${randomUUID().slice(0, 8)}`,
      pageId: null as any,
    });
    expect(a.id).toBeDefined();
    expect(b.id).toBeDefined();
    expect(a.id).not.toBe(b.id);
  });

  it("migration dedup DELETE keeps the page's NEWEST alias row", async () => {
    const pageId = await newPage();
    // Temporarily drop the guard so we can seed the legacy duplicate shape.
    await sql`DROP INDEX share_aliases_workspace_id_page_id_unique`.execute(db);
    try {
      const mk = async (alias: string, createdAt: string): Promise<string> => {
        const id = randomUUID();
        await db
          .insertInto('shareAliases')
          .values({ id, workspaceId: wsId, alias, pageId, createdAt })
          .execute();
        return id;
      };
      await mk('oldest', '2026-01-01T00:00:00Z');
      await mk('middle', '2026-02-01T00:00:00Z');
      const newest = await mk('newest', '2026-03-01T00:00:00Z');

      // Exact dedup statement from the migration.
      await sql`
        DELETE FROM share_aliases sa
        USING share_aliases keep
        WHERE sa.page_id IS NOT NULL
          AND sa.workspace_id = keep.workspace_id
          AND sa.page_id = keep.page_id
          AND (keep.created_at, keep.id) > (sa.created_at, sa.id)
      `.execute(db);

      const rows = await aliasRowsFor(pageId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: newest, alias: 'newest' });
    } finally {
      await sql`
        CREATE UNIQUE INDEX share_aliases_workspace_id_page_id_unique
        ON share_aliases (workspace_id, page_id)
        WHERE page_id IS NOT NULL
      `.execute(db);
    }
  });

  it('setAlias renames te -> ted in place: page ends with ONE row named ted', async () => {
    const pageId = await newPage();
    const creatorId = null as any;
    const first = await service.setAlias({
      workspaceId: wsId,
      pageId,
      creatorId,
      alias: 'te',
    });
    expect(first.alias).toBe('te');

    const renamed = await service.setAlias({
      workspaceId: wsId,
      pageId,
      creatorId,
      alias: 'ted',
    });
    // Same row id — a RENAME, not a new insert.
    expect(renamed.id).toBe(first.id);
    expect(renamed.alias).toBe('ted');

    const rows = await aliasRowsFor(pageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].alias).toBe('ted'); // the stale `te` row is gone

    // The modal read resolves the current (only) row deterministically.
    const shown = await service.getAliasForPage(pageId, wsId);
    expect(shown?.alias).toBe('ted');
  });

  it('setAlias inserts the first alias, then is a no-op for the same name', async () => {
    const pageId = await newPage();
    const inserted = await service.setAlias({
      workspaceId: wsId,
      pageId,
      creatorId: null as any,
      alias: 'hello',
    });
    const again = await service.setAlias({
      workspaceId: wsId,
      pageId,
      creatorId: null as any,
      alias: 'hello',
    });
    expect(again.id).toBe(inserted.id);
    expect(await aliasRowsFor(pageId)).toHaveLength(1);
  });

  it('cross-page collision throws 409, and confirmReassign moves the single row', async () => {
    const pageA = await newPage();
    const pageB = await newPage();
    await service.setAlias({
      workspaceId: wsId,
      pageId: pageA,
      creatorId: null as any,
      alias: 'shared',
    });

    await expect(
      service.setAlias({
        workspaceId: wsId,
        pageId: pageB,
        creatorId: null as any,
        alias: 'shared',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const moved = await service.setAlias({
      workspaceId: wsId,
      pageId: pageB,
      creatorId: null as any,
      alias: 'shared',
      confirmReassign: true,
    });
    expect(moved.alias).toBe('shared');

    // The name now belongs to pageB only; pageA has no alias.
    expect(await aliasRowsFor(pageA)).toHaveLength(0);
    const bRows = await aliasRowsFor(pageB);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].alias).toBe('shared');
  });
});
