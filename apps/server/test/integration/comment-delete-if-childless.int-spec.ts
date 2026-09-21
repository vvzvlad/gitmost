import { Kysely } from 'kysely';
import { CommentRepo } from '../../src/database/repos/comment/comment.repo';
import {
  getTestDb,
  destroyTestDb,
  buildTestDb,
  createWorkspace,
  createSpace,
  createPage,
  createUser,
  createComment,
} from './db';

/**
 * Real-DB coverage for CommentRepo.deleteCommentIfChildless (#338 F4/F6).
 *
 * This is the guard that keeps an ephemeral-suggestion hard-delete from
 * cascade-destroying a reply (`comments.parent_comment_id` is ON DELETE CASCADE).
 * The unit tests MOCK this method to 0/1, so only an int-spec actually exercises
 * the SQL — the FOR UPDATE lock-then-recheck transaction — against Postgres.
 *
 * The concurrency case is the whole point: a plain anti-join
 * `DELETE … WHERE NOT EXISTS(child)` passes (a) and (b) but SILENTLY loses a
 * reply that commits mid-operation under READ COMMITTED (EvalPlanQual does not
 * re-check a merely-locked row). Test (c) reproduces exactly that interleaving
 * and asserts the row + reply both survive.
 */
describe('CommentRepo.deleteCommentIfChildless [integration]', () => {
  let db: Kysely<any>;
  let repo: CommentRepo;
  let workspaceId: string;
  let spaceId: string;
  let pageId: string;
  let userId: string;

  beforeAll(async () => {
    db = getTestDb();
    repo = new CommentRepo(db as any);
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
    pageId = (await createPage(db, { workspaceId, spaceId })).id;
    userId = (await createUser(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  async function rowExists(id: string): Promise<boolean> {
    const row = await db
      .selectFrom('comments')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    return Boolean(row);
  }

  function seedTopLevel() {
    return createComment(db, {
      workspaceId,
      spaceId,
      pageId,
      creatorId: userId,
      selection: 'old text',
      suggestedText: 'new text',
    });
  }

  function seedReply(parentId: string) {
    return createComment(db, {
      workspaceId,
      spaceId,
      pageId,
      creatorId: userId,
      parentCommentId: parentId,
    });
  }

  it('(a) childless top-level → returns 1 and the row is gone', async () => {
    const parent = await seedTopLevel();
    expect(await rowExists(parent.id)).toBe(true);

    const deleted = await repo.deleteCommentIfChildless(parent.id);

    expect(deleted).toBe(1);
    expect(await rowExists(parent.id)).toBe(false);
  });

  it('(b) top-level WITH a committed reply → returns 0, parent AND reply survive (gate blocks the cascade)', async () => {
    const parent = await seedTopLevel();
    const reply = await seedReply(parent.id);

    const deleted = await repo.deleteCommentIfChildless(parent.id);

    expect(deleted).toBe(0);
    expect(await rowExists(parent.id)).toBe(true);
    expect(await rowExists(reply.id)).toBe(true);
  });

  it('(c) reply COMMITS mid-operation (FOR UPDATE path) → returns 0, parent + reply survive; a blind anti-join would lose the reply', async () => {
    const parent = await seedTopLevel();

    // Second connection holds an open transaction that inserts a reply (taking
    // FOR KEY SHARE on the parent via the FK) and does NOT commit until we open
    // the gate — reproducing the "reply not yet committed" window.
    const conn2 = buildTestDb();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let replyId: string | undefined;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    try {
      const replyTx = conn2.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('comments')
          .values({
            workspaceId,
            spaceId,
            pageId,
            creatorId: userId,
            parentCommentId: parent.id,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        replyId = row.id as string;
        // Hold the FOR KEY SHARE lock on the parent until the gate opens.
        await gate;
      });

      // Let the reply INSERT acquire its lock before the delete starts.
      await sleep(250);

      // deleteCommentIfChildless does SELECT ... FOR UPDATE on the parent, which
      // conflicts with the reply's FOR KEY SHARE, so it BLOCKS here.
      const deletePromise = repo.deleteCommentIfChildless(parent.id);

      // Give the delete time to reach (and block on) its FOR UPDATE, then let the
      // reply commit. The delete then wakes, re-checks under the lock, sees the
      // now-committed reply, and returns 0.
      await sleep(250);
      openGate();
      await replyTx;

      const deleted = await deletePromise;

      expect(deleted).toBe(0);
      expect(await rowExists(parent.id)).toBe(true);
      expect(replyId).toBeDefined();
      expect(await rowExists(replyId!)).toBe(true);
    } finally {
      // Always release the gate (in case an assertion threw before openGate) and
      // close the extra connection so global-teardown can DROP the database.
      openGate();
      await conn2.destroy();
    }
  });
});
