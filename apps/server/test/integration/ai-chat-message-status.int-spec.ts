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
    // The 5ms sleep above guarantees a strictly-later timestamp.
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(
      new Date(before).getTime(),
    );
  });

  it('onlyIfStreaming update is a NO-OP once the row is finalized (race guard)', async () => {
    // Reproduce the step-update-vs-finalize race (#183 review): the row is
    // finalized to 'completed', then a LATE per-step 'streaming' update lands.
    // With `onlyIfStreaming` it must match nothing and leave the finalized row
    // untouched (no clobber back to 'streaming', no lost usage).
    const seeded = await repo.insert({
      chatId,
      workspaceId,
      userId,
      role: 'assistant',
      content: 'partial',
      status: 'streaming',
    });
    // Terminal finalize (unguarded) wins.
    await repo.update(seeded.id, workspaceId, {
      content: 'final answer',
      status: 'completed',
      metadata: { usage: { totalTokens: 42 } } as never,
    });
    // A straggler per-step update arrives AFTER finalize.
    const late = await repo.update(
      seeded.id,
      workspaceId,
      { content: 'partial', status: 'streaming', metadata: {} as never },
      { onlyIfStreaming: true },
    );
    expect(late).toBeUndefined(); // matched no 'streaming' row -> no-op
    const rows = await repo.findAllByChat(chatId, workspaceId);
    const row = rows.find((r) => r.id === seeded.id)!;
    expect(row.status).toBe('completed'); // NOT clobbered back to streaming
    expect(row.content).toBe('final answer');
    expect((row.metadata as any).usage.totalTokens).toBe(42); // usage preserved
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

  // Backdate a row's updatedAt so it qualifies as a STALE streaming row (the
  // sweep only flips rows untouched for >10 minutes — a live turn bumps
  // updatedAt every step, so it would never match).
  async function backdateUpdatedAt(
    id: string,
    minutesAgo: number,
  ): Promise<void> {
    await db
      .updateTable('aiChatMessages')
      .set({ updatedAt: new Date(Date.now() - minutesAgo * 60 * 1000) })
      .where('id', '=', id)
      .execute();
  }

  it('sweepStreaming flips STALE dangling streaming rows to aborted and counts them', async () => {
    // Two dangling streaming rows in our workspace + one in another workspace —
    // all backdated past the staleness threshold so the sweep picks them up.
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
    const other = await createMessage(db, {
      workspaceId: otherWorkspaceId,
      chatId: otherChatId,
      role: 'assistant',
      status: 'streaming',
    });
    await backdateUpdatedAt(a.id, 20);
    await backdateUpdatedAt(b.id, 20);
    await backdateUpdatedAt(other.id, 20);

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

    const swept = await repo.sweepStreaming();
    // At least the 3 stale streaming rows we created (2 here + 1 in the other ws).
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

  it('sweepStreaming does NOT sweep a FRESH streaming row (recency bound, #183 review)', async () => {
    // A row that is actively streaming (recent updatedAt) must survive the sweep:
    // a fresh replica's boot-sweep must never abort a turn another replica is
    // still streaming in a multi-instance deploy.
    const fresh = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
    });
    // A STALE streaming row created alongside it IS swept — proving the sweep
    // ran and the only difference is recency.
    const stale = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
    });
    await backdateUpdatedAt(stale.id, 20);

    await repo.sweepStreaming();

    const rows = await repo.findAllByChat(chatId, workspaceId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Fresh (recently-updated) streaming row is left untouched...
    expect(byId.get(fresh.id)!.status).toBe('streaming');
    // ...while the stale one alongside it was swept to 'aborted'.
    expect(byId.get(stale.id)!.status).toBe('aborted');
  });
});
