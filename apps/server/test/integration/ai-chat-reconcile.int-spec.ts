import { Kysely } from 'kysely';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { AiChatRunRepo } from '@docmost/db/repos/ai-chat/ai-chat-run.repo';
import { AiChatRunService } from '../../src/core/ai-chat/ai-chat-run.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createChat,
  createMessage,
} from './db';

/**
 * #487 commit 4 — bidirectional reconcile + owner-write priority, real SQL.
 *
 * Proves the OBSERVABLE recovery properties against docmost_test:
 *  - the CONDITIONAL owner-write beats a reconcile stamp, and a stamp never
 *    clobbers a proper terminal row;
 *  - a LATE owner-finalize with real content OVERWRITES a reconcile 'aborted'
 *    stamp (finalizeFailed);
 *  - each reconcile clause (b message<-run, c stale-run, d historical row) settles
 *    the stuck row/run, and a LIVE run entry is never touched;
 *  - the "kill DB on finish" recovery: after the DB comes back, neither the
 *    message row nor the run row stays stuck.
 */
describe('#487 reconcile + owner-write priority [integration]', () => {
  let db: Kysely<any>;
  let messageRepo: AiChatMessageRepo;
  let runRepo: AiChatRunRepo;
  let runService: AiChatRunService;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    db = getTestDb();
    messageRepo = new AiChatMessageRepo(db as any);
    runRepo = new AiChatRunRepo(db as any);
    runService = new AiChatRunService(runRepo, { isCloud: () => false } as never);
    workspaceId = (await createWorkspace(db)).id;
    userId = (await createUser(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  const newChat = async () =>
    (await createChat(db, { workspaceId, creatorId: userId })).id;

  const metaOf = async (id: string): Promise<Record<string, unknown> | null> => {
    const row = await messageRepo.findById(id, workspaceId);
    return (row?.metadata as Record<string, unknown> | null) ?? null;
  };

  it('owner finalizeOwner writes a streaming row and CLEARS finalizeFailed', async () => {
    const chatId = await newChat();
    const m = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
      metadata: { parts: [] },
    });
    const wrote = await messageRepo.finalizeOwner(m.id, workspaceId, {
      content: 'final answer',
      status: 'completed',
      metadata: { parts: [{ type: 'text', text: 'final answer' }] },
    } as never);
    expect(wrote!.status).toBe('completed');
    expect((await metaOf(m.id))?.finalizeFailed).toBeUndefined();
  });

  it('a reconcile stamp NEVER clobbers a proper terminal row (finalizeOwner is a no-op there)', async () => {
    const chatId = await newChat();
    const m = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'completed',
      content: 'real',
      metadata: { parts: [] },
    });
    // The reconcile stamp is onlyIfStreaming -> no-op on a completed row.
    const stamped = await messageRepo.stampTerminalIfStreaming(
      m.id,
      workspaceId,
      'aborted',
    );
    expect(stamped).toBeUndefined();
    expect((await messageRepo.findById(m.id, workspaceId))!.status).toBe(
      'completed',
    );
  });

  it('LATE owner-finalize with real content OVERWRITES a reconcile aborted stamp', async () => {
    const chatId = await newChat();
    const m = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
      metadata: { parts: [{ type: 'text', text: 'partial' }] },
    });
    // Reconcile stamps it aborted + finalizeFailed (final text lived only in mem).
    const stamped = await messageRepo.stampTerminalIfStreaming(
      m.id,
      workspaceId,
      'aborted',
    );
    expect(stamped!.status).toBe('aborted');
    expect((await metaOf(m.id))?.finalizeFailed).toBe(true);

    // A LATE owner-write (finalizeFailed=true satisfies the OR) overwrites it with
    // real content, clearing the flag — owner-write priority.
    const wrote = await messageRepo.finalizeOwner(m.id, workspaceId, {
      content: 'the real final answer',
      status: 'completed',
      metadata: { parts: [{ type: 'text', text: 'the real final answer' }] },
    } as never);
    expect(wrote!.status).toBe('completed');
    expect(wrote!.content).toBe('the real final answer');
    expect((await metaOf(m.id))?.finalizeFailed).toBeUndefined();
  });

  it('clause (c): a stale active run with NO live entry -> aborted; a LIVE entry is untouched', async () => {
    // Stale run, NOT owned by this replica (no entry) -> reconcile aborts it.
    const staleChat = await newChat();
    const stale = await runRepo.insert({
      chatId: staleChat,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });
    await db
      .updateTable('aiChatRuns')
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where('id', '=', stale.id)
      .execute();

    // A live run OWNED by this replica (beginRun registers an in-memory entry),
    // ALSO backdated stale — the "no entry" primary gate must protect it.
    const liveChat = await newChat();
    const live = await runService.beginRun({
      chatId: liveChat,
      workspaceId,
      userId,
    });
    await db
      .updateTable('aiChatRuns')
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where('id', '=', live.runId)
      .execute();

    const aborted = await runService.reconcileStaleRuns(15 * 60 * 1000);
    expect(aborted).toBeGreaterThanOrEqual(1);
    expect((await runRepo.findById(stale.id, workspaceId))!.status).toBe(
      'aborted',
    );
    // The live entry is NEVER aborted, however stale its row looks.
    expect((await runRepo.findById(live.runId, workspaceId))!.status).toBe(
      'running',
    );
    expect(runService.isLocallyActive(live.runId)).toBe(true);

    // cleanup the live run
    await runService.finalizeRun(live.runId, workspaceId, 'aborted');
  });

  it('clause (b): a streaming message whose RUN is terminal is stamped by run status (succeeded -> aborted, NOT completed-empty)', async () => {
    const chatId = await newChat();
    const msg = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
      metadata: { parts: [] },
    });
    // A SUCCEEDED run linked to the still-streaming message (the asymmetry).
    const run = await runRepo.insert({
      chatId,
      workspaceId,
      createdBy: userId,
      status: 'running',
      assistantMessageId: msg.id,
    });
    await runRepo.finalizeIfActive(run.id, workspaceId, {
      status: 'succeeded',
      error: null,
    });

    const stuck = await messageRepo.findStreamingWithTerminalRun();
    const mine = stuck.find((s) => s.messageId === msg.id);
    expect(mine?.runStatus).toBe('succeeded');
    // Reconcile clause (b): succeeded run -> message 'aborted' (NOT 'completed'),
    // the final text lived only in memory (documented loss), +finalizeFailed.
    const status = mine!.runStatus === 'failed' ? 'error' : 'aborted';
    await messageRepo.stampTerminalIfStreaming(msg.id, workspaceId, status);
    const row = await messageRepo.findById(msg.id, workspaceId);
    expect(row!.status).toBe('aborted');
    expect((row!.metadata as Record<string, unknown>).finalizeFailed).toBe(true);
  });

  it('clause (d): a stale streaming row with NO active run on the chat -> aborted+finalizeFailed', async () => {
    const chatId = await newChat();
    const msg = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
      metadata: { parts: [] },
    });
    await db
      .updateTable('aiChatMessages')
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where('id', '=', msg.id)
      .execute();

    const swept = await messageRepo.sweepStreamingWithoutActiveRun(
      15 * 60 * 1000,
    );
    expect(swept).toBeGreaterThanOrEqual(1);
    const row = await messageRepo.findById(msg.id, workspaceId);
    expect(row!.status).toBe('aborted');
    expect((row!.metadata as Record<string, unknown>).finalizeFailed).toBe(true);
  });

  it('clause (d) is DOUBLE-GATED: a stale streaming row WITH an active run on the chat is left alone', async () => {
    const chatId = await newChat();
    const msg = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
      metadata: { parts: [] },
    });
    await db
      .updateTable('aiChatMessages')
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where('id', '=', msg.id)
      .execute();
    // An ACTIVE run on the same chat -> clause (d) must NOT touch the message.
    const run = await runRepo.insert({
      chatId,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });

    await messageRepo.sweepStreamingWithoutActiveRun(15 * 60 * 1000);
    expect((await messageRepo.findById(msg.id, workspaceId))!.status).toBe(
      'streaming',
    );
    await runRepo.finalizeIfActive(run.id, workspaceId, {
      status: 'aborted',
      error: null,
    });
  });

  it('"kill DB on finish" recovery: after the DB is back, reconcile leaves NEITHER the row nor the run stuck', async () => {
    // Simulate a process that seeded the assistant row + run, then died before
    // finalizing EITHER (a mid-turn crash): a streaming message + a running run,
    // both stale, with no in-memory entry (fresh service = fresh maps).
    const chatId = await newChat();
    const msg = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      status: 'streaming',
      metadata: { parts: [{ type: 'text', text: 'partial' }] },
    });
    const run = await runRepo.insert({
      chatId,
      workspaceId,
      createdBy: userId,
      status: 'running',
      assistantMessageId: msg.id,
    });
    await db
      .updateTable('aiChatRuns')
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where('id', '=', run.id)
      .execute();
    await db
      .updateTable('aiChatMessages')
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where('id', '=', msg.id)
      .execute();

    // Reconcile (as the periodic job would): (c) aborts the orphan run, then
    // (b) settles the message from the now-terminal run.
    await runService.reconcileStaleRuns(15 * 60 * 1000);
    const stuck = await messageRepo.findStreamingWithTerminalRun();
    for (const s of stuck) {
      const status = s.runStatus === 'failed' ? 'error' : 'aborted';
      await messageRepo.stampTerminalIfStreaming(s.messageId, s.workspaceId, status);
    }

    // Neither is stuck: the run is terminal AND the message is terminal.
    expect((await runRepo.findById(run.id, workspaceId))!.status).toBe('aborted');
    const row = await messageRepo.findById(msg.id, workspaceId);
    expect(row!.status).toBe('aborted');
    expect((row!.metadata as Record<string, unknown>).finalizeFailed).toBe(true);
  });
});
