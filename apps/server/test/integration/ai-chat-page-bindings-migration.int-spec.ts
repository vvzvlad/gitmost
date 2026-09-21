import { Kysely, sql } from 'kysely';
import { randomUUID } from 'crypto';
import {
  up,
  down,
} from '../../src/database/migrations/20260716T130000-ai-chat-page-bindings';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createSpace,
  createPage,
} from './db';

/**
 * #665 migration on a LIVE Postgres: the ON DELETE CASCADE integrity (criterion
 * 18) and the backfill (criterion 19) both need real FKs and a real migration run,
 * so they cannot be a builder-mock unit test. global-setup already migrated
 * docmost_test to latest (the table exists at start); this drives down()/up()
 * around a hand-seeded ai_chats snapshot to test the backfill honestly, and it
 * leaves the table PRESENT (up) so the shared DB is intact for later specs.
 */
async function tableExists(db: Kysely<any>): Promise<boolean> {
  const row = (
    await sql<{ t: string | null }>`select to_regclass('ai_chat_page_bindings') as t`.execute(
      db,
    )
  ).rows[0];
  return row.t !== null;
}

// Raw snake_case inserts (bypass CamelCasePlugin) so we can set page_id + a
// controlled created_at, which the createChat helper does not expose.
async function insertChat(
  db: Kysely<any>,
  args: {
    workspaceId: string;
    creatorId: string;
    pageId: string | null;
    createdAt: string;
    deletedAt?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO ai_chats (id, workspace_id, creator_id, page_id, created_at, deleted_at)
    VALUES (${id}, ${args.workspaceId}, ${args.creatorId}, ${args.pageId},
            ${args.createdAt}, ${args.deletedAt ?? null})
  `.execute(db);
  return id;
}

async function bindingsFor(
  db: Kysely<any>,
  pageId: string,
): Promise<Array<{ userId: string; chatId: string }>> {
  // The shared test Kysely has CamelCasePlugin, so raw-sql result keys come back
  // camelCased (user_id -> userId) even though the column is snake_case.
  const rows = (
    await sql<{ userId: string; chatId: string }>`
      SELECT user_id, chat_id FROM ai_chat_page_bindings WHERE page_id = ${pageId}
    `.execute(db)
  ).rows;
  return rows;
}

describe('20260716 ai_chat_page_bindings migration [integration]', () => {
  let db: Kysely<any>;
  let workspaceId: string;
  let spaceId: string;
  let userId: string;

  beforeAll(async () => {
    db = getTestDb();
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
    userId = (await createUser(db, workspaceId)).id;
  });

  afterAll(async () => {
    // Guarantee the table is present for later specs even if an assertion threw.
    if (!(await tableExists(db))) await up(db);
    await destroyTestDb();
  });

  it('criterion 19: backfill seeds one binding per (creator,page) = the newest non-deleted chat', async () => {
    const pageA = (await createPage(db, { workspaceId, spaceId })).id;
    const pageB = (await createPage(db, { workspaceId, spaceId })).id;

    // Drop the table so we can seed chats and re-run up() to exercise the backfill.
    await down(db);
    expect(await tableExists(db)).toBe(false);

    // pageA: an older and a newer chat for the same user -> newest must win.
    const older = await insertChat(db, {
      workspaceId,
      creatorId: userId,
      pageId: pageA,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const newer = await insertChat(db, {
      workspaceId,
      creatorId: userId,
      pageId: pageA,
      createdAt: '2026-02-01T00:00:00Z',
    });
    // A deleted chat is ignored even if it is the newest.
    await insertChat(db, {
      workspaceId,
      creatorId: userId,
      pageId: pageA,
      createdAt: '2026-03-01T00:00:00Z',
      deletedAt: '2026-03-02T00:00:00Z',
    });
    // pageB: a single chat -> bound to it.
    const onlyB = await insertChat(db, {
      workspaceId,
      creatorId: userId,
      pageId: pageB,
      createdAt: '2026-01-15T00:00:00Z',
    });
    void older;

    await up(db);
    expect(await tableExists(db)).toBe(true);

    const a = await bindingsFor(db, pageA);
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual({ userId, chatId: newer });

    const b = await bindingsFor(db, pageB);
    expect(b).toEqual([{ userId, chatId: onlyB }]);
  });

  it('criterion 18: hard-deleting a page CASCADEs its bindings away', async () => {
    const page = (await createPage(db, { workspaceId, spaceId })).id;
    const chat = await insertChat(db, {
      workspaceId,
      creatorId: userId,
      pageId: page,
      createdAt: '2026-04-01T00:00:00Z',
    });
    await sql`
      INSERT INTO ai_chat_page_bindings (id, user_id, page_id, chat_id)
      VALUES (gen_uuid_v7(), ${userId}, ${page}, ${chat})
    `.execute(db);
    expect(await bindingsFor(db, page)).toHaveLength(1);

    await sql`DELETE FROM pages WHERE id = ${page}`.execute(db);
    expect(await bindingsFor(db, page)).toHaveLength(0);
  });

  it('hard-deleting the bound chat CASCADEs its binding away', async () => {
    const page = (await createPage(db, { workspaceId, spaceId })).id;
    const chat = await insertChat(db, {
      workspaceId,
      creatorId: userId,
      pageId: page,
      createdAt: '2026-05-01T00:00:00Z',
    });
    await sql`
      INSERT INTO ai_chat_page_bindings (id, user_id, page_id, chat_id)
      VALUES (gen_uuid_v7(), ${userId}, ${page}, ${chat})
    `.execute(db);
    expect(await bindingsFor(db, page)).toHaveLength(1);

    await sql`DELETE FROM ai_chats WHERE id = ${chat}`.execute(db);
    expect(await bindingsFor(db, page)).toHaveLength(0);
  });

  it('UNIQUE(user_id, page_id): a second binding for the same pair is rejected', async () => {
    const page = (await createPage(db, { workspaceId, spaceId })).id;
    const c1 = await insertChat(db, {
      workspaceId,
      creatorId: userId,
      pageId: page,
      createdAt: '2026-06-01T00:00:00Z',
    });
    const c2 = await insertChat(db, {
      workspaceId,
      creatorId: userId,
      pageId: page,
      createdAt: '2026-06-02T00:00:00Z',
    });
    await sql`
      INSERT INTO ai_chat_page_bindings (id, user_id, page_id, chat_id)
      VALUES (gen_uuid_v7(), ${userId}, ${page}, ${c1})
    `.execute(db);
    await expect(
      sql`
        INSERT INTO ai_chat_page_bindings (id, user_id, page_id, chat_id)
        VALUES (gen_uuid_v7(), ${userId}, ${page}, ${c2})
      `.execute(db),
    ).rejects.toThrow();
  });
});
