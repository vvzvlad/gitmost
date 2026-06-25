import { Kysely } from 'kysely';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createChat,
  createMessage,
} from './db';

/**
 * Integration coverage for the #183 step-granular durability primitives on
 * AiChatMessageRepo: `update` (in-place patch by id+workspace, bumps updatedAt,
 * returns the row) and `sweepStreaming` (crash recovery: flip dangling
 * 'streaming' rows to 'aborted'). Real SQL against docmost_test, not a mock.
 */
describe('AiChatMessageRepo.update + sweepStreaming [integration]', () => {
  let db: Kysely<any>;
  let repo: AiChatMessageRepo;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let chatId: string;
  let otherChatId: string;

  beforeAll(async () => {
    db = getTestDb();
    repo = new AiChatMessageRepo(db as any);
    workspaceId = (await createWorkspace(db)).id;
    otherWorkspaceId = (await createWorkspace(db)).id;
    userId = (await createUser(db, workspaceId)).id;
    chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const otherUser = await createUser(db, otherWorkspaceId);
    otherChatId = (
      await createChat(db, {
        workspaceId: otherWorkspaceId,
        creatorId: otherUser.id,
      })
    ).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('update patches content/status/metadata and bumps updatedAt', async () => {
    const seeded = await repo.insert({
      chatId,
      workspaceId,
      userId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      metadata: { parts: [] } as never,
    });
    const before = seeded.updatedAt;
    // Ensure a measurable timestamp delta.
    await new Promise((r) => setTimeout(r, 5));

    const updated = await repo.update(seeded.id, workspaceId, {
      content: 'final answer',
      status: 'completed',
      metadata: { parts: [{ type: 'text', text: 'final answer' }] },
    });

    expect(updated).toBeDefined();
    expect(updated!.content).toBe('final answer');
    expect(updated!.status).toBe('completed');
    expect((updated!.metadata as any).parts).toHaveLength(1);
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

  it('update is workspace-scoped: a foreign workspace id matches nothing', async () => {
    const seeded = await repo.insert({
      chatId,
      workspaceId,
      userId,
      role: 'assistant',
      content: 'orig',
      status: 'streaming',
    });
    const res = await repo.update(seeded.id, otherWorkspaceId, {
      status: 'completed',
    });
    expect(res).toBeUndefined();
    // The row in the real workspace is untouched.
    const rows = await repo.findAllByChat(chatId, workspaceId);
    const stillThere = rows.find((r) => r.id === seeded.id);
    expect(stillThere!.status).toBe('streaming');
    // Clean up so it does not pollute the sweep test below.
    await repo.update(seeded.id, workspaceId, { status: 'completed' });
  });

  it('sweepStreaming flips dangling streaming rows to aborted and counts them', async () => {
    // Two dangling streaming rows in our workspace + one in another workspace.
    const a = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
    });
    const b = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
    });
    // A settled row must NOT be touched.
    const done = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'completed',
    });
    // A legacy NULL-status row must NOT be touched.
    const legacy = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: null,
    });
    await createMessage(db, {
      workspaceId: otherWorkspaceId,
      chatId: otherChatId,
      role: 'assistant',
      status: 'streaming',
    });

    const swept = await repo.sweepStreaming();
    // At least the 3 streaming rows we created (2 here + 1 in the other ws).
    expect(swept).toBeGreaterThanOrEqual(3);

    const rows = await repo.findAllByChat(chatId, workspaceId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)!.status).toBe('aborted');
    expect(byId.get(b.id)!.status).toBe('aborted');
    expect(byId.get(done.id)!.status).toBe('completed');
    expect(byId.get(legacy.id)!.status).toBeNull();

    // Idempotent: a second sweep finds nothing left in our seeded set.
    const again = await repo.sweepStreaming();
    const rows2 = await repo.findAllByChat(chatId, workspaceId);
    // Our two rows stay aborted regardless of `again`'s global count.
    expect(rows2.find((r) => r.id === a.id)!.status).toBe('aborted');
    expect(again).toBeGreaterThanOrEqual(0);
  });
});
