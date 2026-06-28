import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getTestDb, destroyTestDb, createWorkspace, createSpace } from './db';

/**
 * `PageRepo.getEmbeddablePageIds` MUST stay in lockstep with
 * `PageRepo.countEmbeddablePages` (page.repo.ts) — the bulk reindex iterates the
 * ID set while the status endpoint reports the count as the live denominator, so
 * if the two predicates ever diverge the "done X of Y" counter ends on the wrong
 * total. Both share the SAME WHERE: a page qualifies iff it is non-deleted AND
 * (text_content has a non-whitespace char OR it has a non-deleted embedding row).
 *
 * This is a DB-level invariant: the predicate lives in raw SQL (`text_content ~
 * '[^[:space:]]'`) and an EXISTS subquery, so a unit test with mocked Kysely
 * cannot observe it. We seed every boundary case against real Postgres and
 * assert the returned ID set EQUALS the count (and is exactly the expected set).
 * A future edit that touches one predicate but not the other turns this red.
 */
describe('PageRepo embeddable-page set: getEmbeddablePageIds <-> countEmbeddablePages [integration]', () => {
  let db: Kysely<any>;
  let repo: PageRepo;
  let workspaceId: string;
  let spaceId: string;

  beforeAll(async () => {
    db = getTestDb();
    // Only the Kysely-backed query methods under test are exercised, so the
    // SpaceMemberRepo / EventEmitter2 deps are never touched — stub them.
    repo = new PageRepo(
      db as any,
      {} as unknown as SpaceMemberRepo,
      {} as unknown as EventEmitter2,
    );
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  // Insert a page with explicit text_content / deleted_at (createPage in db.ts
  // sets neither), returning its id so the test can assert membership.
  async function insertPage(args: {
    textContent: string | null;
    deletedAt?: Date | null;
  }): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('pages')
      .values({
        id,
        slugId: `slug-${id.slice(0, 8)}`,
        title: `page-${id.slice(0, 8)}`,
        spaceId,
        workspaceId,
        textContent: args.textContent,
        deletedAt: args.deletedAt ?? null,
      })
      .execute();
    return id;
  }

  // Insert one embedding chunk row for a page (NOT NULL columns + deleted_at).
  async function insertEmbedding(
    pageId: string,
    opts: { deletedAt?: Date | null } = {},
  ): Promise<void> {
    await db
      .insertInto('pageEmbeddings')
      .values({
        id: randomUUID(),
        workspaceId,
        pageId,
        spaceId,
        chunkIndex: 0,
        chunkStart: 0,
        chunkLength: 1,
        content: 'x',
        modelName: 'test-model',
        modelDimensions: 1,
        deletedAt: opts.deletedAt ?? null,
      })
      .execute();
  }

  it('returns exactly the embeddable set and its size equals countEmbeddablePages', async () => {
    // IN the set --------------------------------------------------------------
    // (a) non-deleted page with real body text.
    const withText = await insertPage({ textContent: 'hello world' });
    // (b) non-deleted page with NO text but a live embedding row (EXISTS clause:
    //     a page that lost its text yet still has stale vectors must be visited
    //     so the reindex can clear them).
    const noTextLiveEmbedding = await insertPage({ textContent: null });
    await insertEmbedding(noTextLiveEmbedding);

    // OUT of the set ----------------------------------------------------------
    // (c) non-deleted, text_content NULL, no embeddings.
    await insertPage({ textContent: null });
    // (d) non-deleted, whitespace-only text (regex requires a non-space char).
    await insertPage({ textContent: '   \n\t  ' });
    // (e) deleted page WITH body text — excluded by the non-deleted predicate.
    await insertPage({
      textContent: 'deleted but had text',
      deletedAt: new Date(),
    });
    // (f) non-deleted, no text, with ONLY a DELETED embedding row — the EXISTS
    //     subquery filters pe.deleted_at IS NULL, so this stays out.
    const onlyDeletedEmbedding = await insertPage({ textContent: null });
    await insertEmbedding(onlyDeletedEmbedding, { deletedAt: new Date() });

    const ids = await repo.getEmbeddablePageIds(workspaceId);
    const count = await repo.countEmbeddablePages(workspaceId);

    // The two queries agree on the size (the load-bearing lockstep invariant)...
    expect(ids.length).toBe(count);
    // ...and the set is exactly the two qualifying pages, nothing else.
    expect(new Set(ids)).toEqual(new Set([withText, noTextLiveEmbedding]));
    expect(count).toBe(2);
  });
});
