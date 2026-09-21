import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { ShareService } from 'src/core/share/share.service';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import * as publishedModeMigration from 'src/database/migrations/20260714T180000-shares-published-mode';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
  createPage,
} from './db';

/**
 * #370 Stage B — "approved" (publish-only-the-saved-version) share mode, against
 * real Postgres (so the migration column + the hand-written recursive-CTE
 * threading in getShareForPage are exercised for real, not mocked).
 *
 * Guards:
 *   - getShareForPage carries `publishedMode` through ALL of the CTE points
 *     (anchor select, recursive-union select, returned object) — a direct share
 *     AND a descendant (union) share both read it back. If ANY of the 4 threading
 *     points is dropped, one of these reddens.
 *   - createShare / updateShare auto-mint the first manual baseline ON ENABLE.
 *   - approved + includeSubPages is rejected (BadRequestException) on both paths.
 *   - resolveReadableSharePage under approved swaps content+title to the manual
 *     version while PRESERVING page.id + workspaceId.
 */
describe('share published_mode (approved) [integration]', () => {
  let db: Kysely<any>;
  let service: ShareService;
  let shareRepo: ShareRepo;
  let pageHistoryRepo: PageHistoryRepo;
  let wsId: string;
  let spaceId: string;

  // shares.creator_id / page_history.last_updated_by_id are uuid columns; use
  // null (nullable) rather than a synthetic non-uuid id.
  const USER = null as any;

  // resolveReadableSharePage runs the restricted-ancestor gate; keep it open.
  const pagePermissionRepo = {
    hasRestrictedAncestor: async () => false,
  };

  beforeAll(async () => {
    db = getTestDb();
    shareRepo = new ShareRepo(db as any, {} as any);
    const pageRepo = new PageRepo(db as any, {} as any, {} as any);
    pageHistoryRepo = new PageHistoryRepo(db as any);
    service = new ShareService(
      shareRepo as any,
      pageRepo as any,
      pagePermissionRepo as any,
      db as any,
      {} as any, // tokenService — no attachments in these docs
      {} as any, // transclusionService
      { findById: async () => ({ settings: {} }) } as any, // workspaceRepo
      pageHistoryRepo as any,
    );
    wsId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, wsId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  const docWith = (text: string) => ({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
    ],
  });

  const newPage = async (
    text = 'live body',
    parentPageId?: string,
  ): Promise<string> => {
    const { id } = await createPage(db, { workspaceId: wsId, spaceId });
    await db
      .updateTable('pages')
      .set({ content: docWith(text) as any, parentPageId: parentPageId ?? null })
      .where('id', '=', id)
      .execute();
    return id;
  };

  const insertShare = async (args: {
    pageId: string;
    publishedMode?: string;
    includeSubPages?: boolean;
  }) => {
    const id = randomUUID();
    await db
      .insertInto('shares')
      .values({
        id,
        key: `k-${id.slice(0, 12)}`,
        pageId: args.pageId,
        includeSubPages: args.includeSubPages ?? false,
        publishedMode: args.publishedMode ?? 'live',
        creatorId: USER,
        spaceId,
        workspaceId: wsId,
      })
      .execute();
    return id;
  };

  const manualRows = (pageId: string) =>
    db
      .selectFrom('pageHistory')
      .select(['id', 'kind', 'title'])
      .where('pageId', '=', pageId)
      .where('kind', '=', 'manual')
      .execute();

  const publishedModeColumn = async () =>
    db
      .selectFrom('information_schema.columns' as any)
      .select(['columnName', 'dataType', 'isNullable', 'columnDefault'] as any)
      .where('tableName' as any, '=', 'shares')
      .where('columnName' as any, '=', 'published_mode')
      .executeTakeFirst();

  // --- migration up/down round-trip ----------------------------------------

  it('migration down() drops published_mode; up() re-adds it NOT NULL default live', async () => {
    // global-setup already migrated up, so the column is present.
    const before: any = await publishedModeColumn();
    expect(before).toBeDefined();
    expect(before.isNullable).toBe('NO');
    expect(String(before.columnDefault)).toContain("'live'");

    await publishedModeMigration.down(db as any);
    expect(await publishedModeColumn()).toBeUndefined();

    // Restore so the rest of the suite (and afterAll) sees the real schema.
    await publishedModeMigration.up(db as any);
    const after: any = await publishedModeColumn();
    expect(after).toBeDefined();
    expect(after.isNullable).toBe('NO');
  });

  // --- getShareForPage 4-point threading -----------------------------------

  it('getShareForPage carries publishedMode for a DIRECT share (anchor select + returned object)', async () => {
    const pageId = await newPage();
    await insertShare({ pageId, publishedMode: 'approved' });

    const share = await service.getShareForPage(pageId, wsId);
    expect(share).toBeDefined();
    expect(share!.publishedMode).toBe('approved');
  });

  it('getShareForPage carries publishedMode for a DESCENDANT share (recursive-union select)', async () => {
    // Parent shared with includeSubPages + approved (inserted directly, bypassing
    // the service XOR gate, purely to exercise the CTE union threading on a
    // child that inherits the ancestor share).
    const parentId = await newPage('parent body');
    await insertShare({
      pageId: parentId,
      publishedMode: 'approved',
      includeSubPages: true,
    });
    const childId = await newPage('child body', parentId);

    const share = await service.getShareForPage(childId, wsId);
    expect(share).toBeDefined();
    // Resolved via the recursive union up to the ancestor share.
    expect((share!.level as number) > 0).toBe(true);
    expect(share!.publishedMode).toBe('approved');
  });

  // --- baseline auto-create on enable --------------------------------------

  it('createShare(approved) mints the first manual baseline from current content', async () => {
    const pageId = await newPage('baseline body');
    const page = { id: pageId, spaceId } as any;

    expect(await manualRows(pageId)).toHaveLength(0);

    await service.createShare({
      authUserId: USER,
      workspaceId: wsId,
      page,
      createShareDto: { pageId, includeSubPages: false, publishedMode: 'approved' } as any,
    });

    const rows = await manualRows(pageId);
    expect(rows).toHaveLength(1);
  });

  it('updateShare enabling approved on a live share mints the baseline; a second call is idempotent', async () => {
    const pageId = await newPage('later-saved body');
    const shareId = await insertShare({ pageId, publishedMode: 'live' });

    expect(await manualRows(pageId)).toHaveLength(0);

    await service.updateShare(shareId, {
      shareId,
      publishedMode: 'approved',
    } as any);
    expect(await manualRows(pageId)).toHaveLength(1);

    // Idempotent: staying approved does not duplicate the baseline.
    await service.updateShare(shareId, {
      shareId,
      searchIndexing: true,
    } as any);
    expect(await manualRows(pageId)).toHaveLength(1);
  });

  // --- XOR gate ------------------------------------------------------------

  it('createShare rejects approved + includeSubPages', async () => {
    const pageId = await newPage();
    await expect(
      service.createShare({
        authUserId: USER,
        workspaceId: wsId,
        page: { id: pageId, spaceId } as any,
        createShareDto: {
          pageId,
          includeSubPages: true,
          publishedMode: 'approved',
        } as any,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateShare rejects setting approved while includeSubPages is already on', async () => {
    const pageId = await newPage();
    const shareId = await insertShare({ pageId, includeSubPages: true });
    await expect(
      service.updateShare(shareId, { shareId, publishedMode: 'approved' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- resolveReadableSharePage content freeze -----------------------------

  // --- atomicity regression lock (F1) --------------------------------------
  // The share-write and the approved baseline mint MUST commit in ONE
  // transaction. If a future change moves the mint off `trx` back onto
  // `this.db`, an "approved" share could durably persist WITHOUT a baseline —
  // the fail-open confidentiality hole the fix closed. These two tests fail the
  // moment that atomicity is broken: with the mint outside the trx, the failed
  // mint would no longer roll back the share row (test 1) / the mode UPDATE
  // (test 2), so the post-condition assertions below would flip.

  it('createShare(approved) rolls back the shares insert when the baseline mint throws', async () => {
    const pageId = await newPage('mint-fail create body');
    const page = { id: pageId, spaceId } as any;

    // No manual baseline yet -> ensureApprovedBaseline will attempt a real mint.
    expect(await manualRows(pageId)).toHaveLength(0);

    // saveHistory is the WRITE the baseline mint performs; force it to throw so
    // the transaction body rejects after the shares row was inserted.
    const spy = jest
      .spyOn(pageHistoryRepo, 'saveHistory')
      .mockRejectedValueOnce(new Error('boom'));

    try {
      await expect(
        service.createShare({
          authUserId: USER,
          workspaceId: wsId,
          page,
          createShareDto: {
            pageId,
            includeSubPages: false,
            publishedMode: 'approved',
          } as any,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The whole transaction rolled back: NO shares row survived the failed
      // mint. If the mint ran outside the trx, this row would persist.
      const share = await shareRepo.findByPageId(pageId);
      expect(share).toBeFalsy();
      // And no orphan baseline was committed either.
      expect(await manualRows(pageId)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('updateShare(->approved) rolls back the mode UPDATE when the baseline mint throws', async () => {
    const pageId = await newPage('mint-fail update body');
    // Existing LIVE share with no manual baseline.
    const shareId = await insertShare({ pageId, publishedMode: 'live' });
    expect(await manualRows(pageId)).toHaveLength(0);

    const spy = jest
      .spyOn(pageHistoryRepo, 'saveHistory')
      .mockRejectedValueOnce(new Error('boom'));

    try {
      await expect(
        service.updateShare(shareId, {
          shareId,
          publishedMode: 'approved',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The UPDATE rolled back with the failed mint: the row is STILL 'live'.
      // If the mint ran outside the trx, publishedMode would be 'approved'.
      const after = await shareRepo.findById(shareId);
      expect(after).toBeDefined();
      expect(after!.publishedMode).toBe('live');
      // No orphan baseline committed.
      expect(await manualRows(pageId)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('resolveReadableSharePage under approved swaps content+title but PRESERVES id + workspaceId', async () => {
    const pageId = await newPage('LIVE draft body');
    const shareId = await insertShare({ pageId, publishedMode: 'approved' });

    // Seed a manual version distinct from the live draft.
    await pageHistoryRepo.insertPageHistory({
      pageId,
      slugId: `hist-${pageId.slice(0, 8)}`,
      title: 'SAVED title',
      content: docWith('SAVED version body') as any,
      kind: 'manual',
      spaceId,
      workspaceId: wsId,
    } as any);

    const resolved = await service.resolveReadableSharePage(
      shareId,
      pageId,
      wsId,
    );
    expect(resolved).not.toBeNull();
    // Content + title are the SAVED version.
    expect(resolved!.page.title).toBe('SAVED title');
    expect(JSON.stringify(resolved!.page.content)).toContain(
      'SAVED version body',
    );
    // id + workspaceId stay LIVE (attachment-token ownership must not shift).
    expect(resolved!.page.id).toBe(pageId);
    expect(resolved!.page.workspaceId).toBe(wsId);
  });
});
