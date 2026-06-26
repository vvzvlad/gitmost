import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageService } from 'src/core/page/services/page.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
  createUser,
} from './db';

/**
 * #206 attach-1 — Duplicating a subtree where the SAME attachment is referenced
 * by more than one page must copy a working blob/row for EVERY copy, not just
 * the last page processed.
 *
 * Setup: root page A and child page B both embed the same image (attachmentId X,
 * the attachment row owned by A in the DB). Duplicating A produces copies A' and
 * B'. Before the fix the per-attachmentId map held a single entry, so B's entry
 * clobbered A's and the row-ownership guard (`attachment.pageId !== oldPageId`)
 * then skipped the only DB row entirely: zero blobs copied, zero new rows, both
 * copies' images 404. The fix keys the map to a LIST and copies once per
 * referencing page, dropping the broken guard.
 *
 * This drives the real PageService.duplicatePage against a real Postgres with a
 * recording storage stub, and asserts: storage.copy called twice and two fresh
 * attachment rows exist (one owned by A', one by B'), each matching the rewritten
 * attachmentId in its page's content.
 */
describe('PageService.duplicatePage shared attachment [integration]', () => {
  let db: Kysely<any>;
  let pageRepo: PageRepo;
  let pagePermissionRepo: PagePermissionRepo;
  let pageService: PageService;
  let workspaceId: string;
  let spaceId: string;
  let userId: string;

  // Records every (source, dest) blob copy the service requests.
  const copyCalls: Array<{ from: string; to: string }> = [];
  const storageService = {
    copy: async (from: string, to: string) => {
      copyCalls.push({ from, to });
    },
  } as any;

  // Duplicate persists transclusion/reference rows in best-effort try/catch
  // blocks; a no-op stub keeps the harness focused on the attachment path.
  const transclusionService = {
    insertTransclusionsForPages: async () => {},
    insertReferencesForPages: async () => {},
    insertTemplateReferencesForPages: async () => {},
  } as any;

  const eventEmitter = { emit: () => true } as any;

  function imageDoc(attachmentId: string) {
    return {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            attachmentId,
            src: `/api/files/${attachmentId}/image.png`,
            width: '100%',
            align: 'center',
          },
        },
      ],
    };
  }

  beforeAll(async () => {
    db = getTestDb();
    pageRepo = new PageRepo(db as any, {} as any, eventEmitter);
    // filterAccessiblePageIds short-circuits to the input ids when the space has
    // no restricted pages, so groupRepo/cache (2nd/3rd ctor args) are never hit.
    pagePermissionRepo = new PagePermissionRepo(
      db as any,
      {} as any,
      {} as any,
    );
    pageService = new PageService(
      pageRepo,
      pagePermissionRepo,
      undefined as any, // attachmentRepo (unused on duplicate path)
      db as any,
      storageService,
      undefined as any, // attachmentQueue
      undefined as any, // aiQueue
      undefined as any, // generalQueue
      eventEmitter,
      undefined as any, // collaborationGateway
      undefined as any, // watcherService
      transclusionService,
    );

    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
    userId = (await createUser(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('copies a shared attachment for every page that references it', async () => {
    copyCalls.length = 0;

    const attachmentId = randomUUID();
    const pageAId = randomUUID();
    const pageBId = randomUUID();

    // Root A and child B both embed the same attachmentId.
    await db
      .insertInto('pages')
      .values({
        id: pageAId,
        slugId: `a-${pageAId.slice(0, 8)}`,
        title: 'A',
        content: imageDoc(attachmentId) as any,
        position: 'a0',
        spaceId,
        workspaceId,
        creatorId: userId,
      })
      .execute();
    await db
      .insertInto('pages')
      .values({
        id: pageBId,
        slugId: `b-${pageBId.slice(0, 8)}`,
        title: 'B',
        content: imageDoc(attachmentId) as any,
        position: 'a0',
        parentPageId: pageAId,
        spaceId,
        workspaceId,
        creatorId: userId,
      })
      .execute();

    // Single attachment row, owned by A.
    await db
      .insertInto('attachments')
      .values({
        id: attachmentId,
        type: 'image',
        filePath: `${spaceId}/${attachmentId}/image.png`,
        fileName: 'image.png',
        fileExt: 'png',
        mimeType: 'image/png',
        creatorId: userId,
        workspaceId,
        pageId: pageAId,
        spaceId,
      })
      .execute();

    const rootPage = await pageRepo.findById(pageAId);
    const result = await pageService.duplicatePage(
      rootPage as any,
      undefined,
      { id: userId, workspaceId } as any,
    );

    const newRootId = result.id;
    const newChildIds = result.childPageIds;
    expect(newChildIds).toHaveLength(1);
    const newChildId = newChildIds[0];

    // Both pages' images were copied: one blob per referencing page.
    expect(copyCalls).toHaveLength(2);

    // Two fresh attachment rows exist, one owned by each copied page.
    const newAttachments = await db
      .selectFrom('attachments')
      .selectAll()
      .where('pageId', 'in', [newRootId, newChildId])
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(newAttachments).toHaveLength(2);

    const ownerIds = newAttachments.map((a) => a.pageId).sort();
    expect(ownerIds).toEqual([newRootId, newChildId].sort());

    // Each copied page's content points at a rewritten attachmentId that now has
    // a real row (i.e. the image src resolves instead of 404ing).
    for (const pageId of [newRootId, newChildId]) {
      const page = await db
        .selectFrom('pages')
        .select(['content'])
        .where('id', '=', pageId)
        .executeTakeFirstOrThrow();
      const node = (page.content as any).content[0];
      expect(node.type).toBe('image');
      const referencedId = node.attrs.attachmentId;
      expect(referencedId).not.toBe(attachmentId); // remapped to a fresh id
      const row = newAttachments.find((a) => a.id === referencedId);
      expect(row).toBeDefined();
      expect(row!.pageId).toBe(pageId);
    }
  });
});
