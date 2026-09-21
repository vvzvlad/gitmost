import { Kysely } from 'kysely';
import {
  AiChatRunRepo,
  SWEEP_RUN_STALE_MS,
} from '@docmost/db/repos/ai-chat/ai-chat-run.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { AiChatRunService } from '../../src/core/ai-chat/ai-chat-run.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createChat,
} from './db';

/**
 * Integration coverage for the #184 phase-1 durable agent run: real SQL against
 * docmost_test. Proves the core invariant primitives — a run is a first-class
 * lifecycle row, at most one is active per chat, a detached run's progress
 * survives with NO subscriber, an explicit stop settles it as aborted, a
 * reconnect read returns the persisted state, and a crash sweep recovers
 * dangling runs.
 */
describe('AiChatRun durable lifecycle [integration]', () => {
  let db: Kysely<any>;
  let runRepo: AiChatRunRepo;
  let messageRepo: AiChatMessageRepo;
  let service: AiChatRunService;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let chatId: string;

  beforeAll(async () => {
    db = getTestDb();
    runRepo = new AiChatRunRepo(db as any);
    messageRepo = new AiChatMessageRepo(db as any);
    // Boot-sweep isn't triggered here; the isCloud stub is all the service needs
    // for these direct-call integration cases (F7).
    service = new AiChatRunService(runRepo, { isCloud: () => false } as never);
    workspaceId = (await createWorkspace(db)).id;
    otherWorkspaceId = (await createWorkspace(db)).id;
    userId = (await createUser(db, workspaceId)).id;
    chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  // Each test that creates an active run settles it (or uses its own chat) so the
  // partial unique index does not bleed across tests.

  it('insert + findById round-trips a run row, defaulting status/trigger', async () => {
    const run = await runRepo.insert({
      chatId,
      workspaceId,
      createdBy: userId,
    });
    expect(run.status).toBe('pending');
    expect(run.trigger).toBe('user');
    expect(run.stepCount).toBe(0);

    const found = await runRepo.findById(run.id, workspaceId);
    expect(found!.id).toBe(run.id);
    // Workspace-scoped: a foreign workspace sees nothing.
    expect(await runRepo.findById(run.id, otherWorkspaceId)).toBeUndefined();

    // settle so it does not occupy the active slot
    await runRepo.update(run.id, workspaceId, {
      status: 'succeeded',
      finishedAt: new Date(),
    });
  });

  it('enforces ONE ACTIVE run per chat (partial unique index rejects a second)', async () => {
    const activeChat = (
      await createChat(db, { workspaceId, creatorId: userId })
    ).id;
    const first = await runRepo.insert({
      chatId: activeChat,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });
    // A second pending/running run on the SAME chat must be rejected by the DB.
    await expect(
      runRepo.insert({
        chatId: activeChat,
        workspaceId,
        createdBy: userId,
        status: 'running',
      }),
    ).rejects.toThrow();

    // findActiveByChat returns exactly the one active run.
    const active = await runRepo.findActiveByChat(activeChat, workspaceId);
    expect(active!.id).toBe(first.id);

    // Once it settles, the slot frees and a new run may start.
    await runRepo.update(first.id, workspaceId, {
      status: 'succeeded',
      finishedAt: new Date(),
    });
    expect(
      await runRepo.findActiveByChat(activeChat, workspaceId),
    ).toBeUndefined();
    const second = await runRepo.insert({
      chatId: activeChat,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });
    expect(second.id).not.toBe(first.id);
    await runRepo.update(second.id, workspaceId, {
      status: 'aborted',
      finishedAt: new Date(),
    });
  });

  it('DETACHED run: persists + finalizes succeeded with NO subscriber, reconnect returns state', async () => {
    // A dedicated chat so the active-run slot is clean.
    const runChat = (
      await createChat(db, { workspaceId, creatorId: userId })
    ).id;

    // beginRun = the runner starts the turn (registers an in-memory controller).
    const handle = await service.beginRun({
      chatId: runChat,
      workspaceId,
      userId,
    });
    expect(handle.signal.aborted).toBe(false);
    expect(service.isLocallyActive(handle.runId)).toBe(true);

    // The assistant projection row (#183) is seeded + linked.
    const seeded = await messageRepo.insert({
      chatId: runChat,
      workspaceId,
      userId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      metadata: { parts: [] } as never,
    });
    await service.linkAssistantMessage(handle.runId, workspaceId, seeded.id);

    // Progress is persisted as steps finish — NO HTTP socket involved here at all.
    await service.recordStep(handle.runId, workspaceId, 1);
    await messageRepo.update(seeded.id, workspaceId, {
      content: 'partial work',
      metadata: { parts: [{ type: 'text', text: 'partial work' }] },
    });

    // The turn completes; finalize the projection then the run.
    await messageRepo.update(seeded.id, workspaceId, {
      content: 'final answer',
      status: 'completed',
    });
    await service.finalizeRun(handle.runId, workspaceId, 'completed');

    expect(service.isLocallyActive(handle.runId)).toBe(false);

    // Reconnect: the latest run for the chat + its projected message, from the DB.
    const run = await service.getLatestForChat(runChat, workspaceId);
    expect(run!.status).toBe('succeeded');
    expect(run!.stepCount).toBe(1);
    expect(run!.assistantMessageId).toBe(seeded.id);
    expect(run!.finishedAt).toBeTruthy();
    const message = await messageRepo.findById(seeded.id, workspaceId);
    expect(message!.status).toBe('completed');
    expect(message!.content).toBe('final answer');
  });

  it('EXPLICIT stop aborts the run signal, marks the row, and settles as aborted', async () => {
    const runChat = (
      await createChat(db, { workspaceId, creatorId: userId })
    ).id;
    const handle = await service.beginRun({
      chatId: runChat,
      workspaceId,
      userId,
    });

    // User presses Stop.
    const stopped = await service.requestStop(handle.runId, workspaceId);
    expect(stopped).toBe(true);
    expect(handle.signal.aborted).toBe(true);

    // The row carries the stop request (distinct from a disconnect, which would
    // leave stop_requested_at NULL).
    const afterStop = await runRepo.findById(handle.runId, workspaceId);
    expect(afterStop!.stopRequestedAt).toBeTruthy();

    // The terminal callback (onAbort) settles the run.
    await service.finalizeRun(handle.runId, workspaceId, 'aborted');
    const run = await service.getLatestForChat(runChat, workspaceId);
    expect(run!.status).toBe('aborted');
  });

  it('markStopRequested is a no-op on an already-settled run (returns undefined)', async () => {
    const runChat = (
      await createChat(db, { workspaceId, creatorId: userId })
    ).id;
    const run = await runRepo.insert({
      chatId: runChat,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });
    await runRepo.update(run.id, workspaceId, {
      status: 'succeeded',
      finishedAt: new Date(),
    });
    const marked = await runRepo.markStopRequested(run.id, workspaceId);
    expect(marked).toBeUndefined();
  });

  it('sweepRunning aborts STALE dangling runs but not fresh or settled ones', async () => {
    const sweepChat1 = (
      await createChat(db, { workspaceId, creatorId: userId })
    ).id;
    const sweepChat2 = (
      await createChat(db, { workspaceId, creatorId: userId })
    ).id;
    const sweepChat3 = (
      await createChat(db, { workspaceId, creatorId: userId })
    ).id;

    const stale = await runRepo.insert({
      chatId: sweepChat1,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });
    const fresh = await runRepo.insert({
      chatId: sweepChat2,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });
    const settled = await runRepo.insert({
      chatId: sweepChat3,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });
    await runRepo.update(settled.id, workspaceId, {
      status: 'succeeded',
      finishedAt: new Date(),
    });
    // Backdate the stale run's updatedAt past the 10-minute staleness window.
    await db
      .updateTable('aiChatRuns')
      .set({ updatedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where('id', '=', stale.id)
      .execute();

    // WINDOWED sweep (phase-2 multi-instance timer path): only runs older than the
    // staleness window are aborted, so a sibling replica's fresh run survives. The
    // no-arg boot sweep (variant C) is unconditional — covered separately below.
    const swept = await runRepo.sweepRunning({ staleMs: SWEEP_RUN_STALE_MS });
    expect(swept).toBeGreaterThanOrEqual(1);

    expect((await runRepo.findById(stale.id, workspaceId))!.status).toBe(
      'aborted',
    );
    // Fresh (recently-updated) running run survives the WINDOWED sweep — a sibling
    // replica may still be executing it.
    expect((await runRepo.findById(fresh.id, workspaceId))!.status).toBe(
      'running',
    );
    expect((await runRepo.findById(settled.id, workspaceId))!.status).toBe(
      'succeeded',
    );

    // cleanup active fresh run
    await runRepo.update(fresh.id, workspaceId, {
      status: 'aborted',
      finishedAt: new Date(),
    });
  });

  it('#487 finalizeIfActive is CONDITIONAL: a late terminal write cannot clobber the settled status (real SQL)', async () => {
    const c = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const run = await runRepo.insert({
      chatId: c,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });

    // First terminal write: the run IS active, so it flips + returns the row.
    const first = await runRepo.finalizeIfActive(run.id, workspaceId, {
      status: 'succeeded',
      error: null,
    });
    expect(first!.status).toBe('succeeded');
    expect(first!.finishedAt).toBeTruthy();

    // A late/second writer tries to flip it to 'aborted' — the WHERE status IN
    // ('pending','running') guard matches NOTHING now, so it is a benign no-op.
    const second = await runRepo.finalizeIfActive(run.id, workspaceId, {
      status: 'aborted',
      error: 'late clobber attempt',
    });
    expect(second).toBeUndefined();

    // The persisted terminal status is UNCHANGED — last-writer-wins is gone.
    const row = await runRepo.findById(run.id, workspaceId);
    expect(row!.status).toBe('succeeded');
    expect(row!.error).toBeNull();
  });

  it('#487 double-settle through the service collapses to one write at the SQL gate', async () => {
    const c = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const handle = await service.beginRun({ chatId: c, workspaceId, userId });

    // First settle writes 'aborted' via the conditional write.
    await service.finalizeRun(handle.runId, workspaceId, 'aborted');
    // A late safety-net settle to 'error' is a no-op (row already terminal).
    await service.finalizeRun(handle.runId, workspaceId, 'error', 'late');

    const row = await runRepo.findById(handle.runId, workspaceId);
    expect(row!.status).toBe('aborted');
    expect(service.isLocallyActive(handle.runId)).toBe(false);
    expect(service.hasZombie(handle.runId)).toBe(false);
  });

  it('sweepRunning() with NO args (boot sweep / variant C) aborts even a FRESH running run', async () => {
    // F1/DECISION C at the SQL level: the unconditional boot sweep has NO
    // staleness window, so a run updated just now (a fast restart) is settled too
    // — otherwise it would stay 'running' forever and 409 every future turn.
    const bootChat = (
      await createChat(db, { workspaceId, creatorId: userId })
    ).id;
    const fresh = await runRepo.insert({
      chatId: bootChat,
      workspaceId,
      createdBy: userId,
      status: 'running',
    });
    // updatedAt = now (fresh, untouched). The no-arg sweep settles it anyway.
    const swept = await runRepo.sweepRunning();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect((await runRepo.findById(fresh.id, workspaceId))!.status).toBe(
      'aborted',
    );
  });
});
