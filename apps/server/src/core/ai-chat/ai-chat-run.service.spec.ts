import { Logger } from '@nestjs/common';
import {
  AiChatRunService,
  RunAlreadyActiveError,
  ONE_ACTIVE_RUN_PER_CHAT_INDEX,
  mapTurnStatusToRun,
} from './ai-chat-run.service';

/** Shape a Postgres unique-violation the way the postgres.js driver surfaces it:
 *  SQLSTATE 23505 + the offending index in `constraint_name`. */
function uniqueViolation(constraintName: string): Error & {
  code: string;
  constraint_name: string;
} {
  return Object.assign(
    new Error('duplicate key value violates unique constraint'),
    {
      code: '23505',
      constraint_name: constraintName,
    },
  );
}

/**
 * Unit coverage for the #184 phase-1 run lifecycle (AiChatRunService) with a
 * hand-rolled mock repo — no Nest graph, no DB. The invariant under test is the
 * one that makes a run "autonomous": a run keeps going when its SUBSCRIBER (the
 * browser) detaches, and ONLY an explicit stop aborts it. We assert that at the
 * abort-signal level (the signal the agent loop actually consumes).
 */

/** Minimal EnvironmentService stub. Single-instance (CLOUD unset) by default. */
function makeEnv(isCloud = false) {
  return { isCloud: () => isCloud };
}

function makeRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    insert: jest.fn(async (v: any) => ({
      id: 'run-1',
      status: v.status ?? 'running',
      chatId: v.chatId,
      workspaceId: v.workspaceId,
    })),
    update: jest.fn(async () => ({ id: 'run-1' })),
    // #487: terminal finalize now goes through the CONDITIONAL write. Default
    // returns a truthy row (the run WAS active -> this call wrote it).
    finalizeIfActive: jest.fn(async () => ({ id: 'run-1', status: 'succeeded' })),
    markStopRequested: jest.fn(async () => ({ id: 'run-1' })),
    findActiveByChat: jest.fn(async () => undefined),
    findLatestByChat: jest.fn(async () => undefined),
    findById: jest.fn(async () => undefined),
    sweepRunning: jest.fn(async () => 0),
    ...overrides,
  };
}

describe('mapTurnStatusToRun', () => {
  it('maps the turn terminal status to the run terminal status', () => {
    expect(mapTurnStatusToRun('completed')).toBe('succeeded');
    expect(mapTurnStatusToRun('error')).toBe('failed');
    expect(mapTurnStatusToRun('aborted')).toBe('aborted');
  });
});

describe('AiChatRunService.onModuleInit (startup sweep)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('calls sweepRunning and resolves; logs when > 0', async () => {
    const repo = makeRepo({ sweepRunning: jest.fn(async () => 2) });
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(repo.sweepRunning).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('2');
  });

  it('a sweep failure is swallowed (never blocks startup)', async () => {
    const repo = makeRepo({
      sweepRunning: jest.fn(async () => {
        throw new Error('db down');
      }),
    });
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    // The first warn is the sweep failure (the multi-instance warn never fires
    // single-instance), so the message is the db error.
    expect(String(warnSpy.mock.calls[0][0])).toContain('db down');
  });

  it('F1 (DECISION C): the boot sweep is UNCONDITIONAL — sweepRunning is called with NO staleness window, so a fresh running run (updatedAt = now) is settled, not skipped', async () => {
    // The bug: a fast restart (deploy/OOM within minutes of the last step) left a
    // run stuck 'running' under the old 10-min window, 409ing every later turn in
    // the chat. The fix settles ALL pending|running on boot. We assert the service
    // invokes sweepRunning with no `staleMs` (the unconditional path); the repo's
    // own spec proves no-window => no updatedAt filter.
    const repo = makeRepo({ sweepRunning: jest.fn(async () => 1) });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.onModuleInit();
    expect(repo.sweepRunning).toHaveBeenCalledTimes(1);
    const callArgs = repo.sweepRunning.mock.calls[0] as unknown[];
    const firstArg = callArgs[0] as { staleMs?: number } | undefined;
    // Either no opts at all, or opts without a staleMs window => unconditional.
    expect(firstArg?.staleMs).toBeUndefined();
  });

  it('F2 (DECISION A): warns at startup that autonomousRuns is single-instance-only when a horizontally-scaled deployment (CLOUD) is detected', async () => {
    const repo = makeRepo();
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv(true) as never);
    await svc.onModuleInit();
    const warned = warnSpy.mock.calls.some((c) =>
      /single-instance-only/i.test(String(c[0])),
    );
    expect(warned).toBe(true);
  });

  it('F2: does NOT warn about multi-instance on a single-instance (CLOUD unset) deployment', async () => {
    const repo = makeRepo();
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv(false) as never);
    await svc.onModuleInit();
    const warned = warnSpy.mock.calls.some((c) =>
      /single-instance-only/i.test(String(c[0])),
    );
    expect(warned).toBe(false);
  });
});

describe('AiChatRunService run lifecycle', () => {
  it('beginRun inserts a running row and registers a live abort controller', async () => {
    const repo = makeRepo();
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    const handle = await svc.beginRun({
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    });
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        workspaceId: 'ws-1',
        createdBy: 'user-1',
        status: 'running',
        trigger: 'user',
      }),
    );
    expect(handle.runId).toBe('run-1');
    expect(handle.signal.aborted).toBe(false);
    expect(svc.isLocallyActive('run-1')).toBe(true);
  });

  it('beginRun REJECTS the racer: a 23505 on the one-active-per-chat index throws RunAlreadyActiveError (not swallowed) and registers no controller', async () => {
    // The race: the controller's cheap pre-check passed for BOTH concurrent
    // turns, so the loser's INSERT hits the partial unique index. That rejection
    // is the authoritative gate — it must surface, not be swallowed into an
    // untracked turn.
    const repo = makeRepo({
      insert: jest.fn(async () => {
        throw uniqueViolation(ONE_ACTIVE_RUN_PER_CHAT_INDEX);
      }),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await expect(
      svc.beginRun({ chatId: 'chat-1', workspaceId: 'ws-1', userId: 'user-1' }),
    ).rejects.toBeInstanceOf(RunAlreadyActiveError);
    // No controller leaked for a rejected start.
    expect(svc.isLocallyActive('run-1')).toBe(false);
  });

  it('beginRun does NOT mask an unrelated unique violation as already-active', async () => {
    // A 23505 on some OTHER constraint is a real bug, not the race — it must
    // propagate unchanged so it is never silently treated as "already active".
    const other = uniqueViolation('ai_chat_runs_pkey');
    const repo = makeRepo({
      insert: jest.fn(async () => {
        throw other;
      }),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await expect(
      svc.beginRun({ chatId: 'chat-1', workspaceId: 'ws-1', userId: 'user-1' }),
    ).rejects.toBe(other);
  });

  it('beginRun propagates a non-unique insert failure unchanged', async () => {
    const boom = new Error('connection reset');
    const repo = makeRepo({
      insert: jest.fn(async () => {
        throw boom;
      }),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await expect(
      svc.beginRun({ chatId: 'chat-1', workspaceId: 'ws-1', userId: 'user-1' }),
    ).rejects.toBe(boom);
  });

  it('two concurrent begins on one chat: exactly one wins, the other is rejected as already-active', async () => {
    // Integration-style: model the DB partial unique index with a one-shot slot.
    // The first insert claims it; the second hits a 23505 on the active index.
    let slotTaken = false;
    const repo = makeRepo({
      insert: jest.fn(async (v: any) => {
        if (slotTaken) throw uniqueViolation(ONE_ACTIVE_RUN_PER_CHAT_INDEX);
        slotTaken = true;
        return { id: 'run-win', status: v.status, chatId: v.chatId };
      }),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    const results = await Promise.allSettled([
      svc.beginRun({ chatId: 'chat-1', workspaceId: 'ws-1', userId: 'user-1' }),
      svc.beginRun({ chatId: 'chat-1', workspaceId: 'ws-1', userId: 'user-1' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RunAlreadyActiveError,
    );
    // Exactly the winner is locally active.
    expect(svc.isLocallyActive('run-win')).toBe(true);
  });

  it('a SUBSCRIBER detaching does NOT abort the run (only an explicit stop does)', async () => {
    const repo = makeRepo();
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    const handle = await svc.beginRun({
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    });
    // Model a browser disconnect: nothing in the run service is told to stop.
    // The signal the agent loop consumes must stay un-aborted and the run stays
    // locally active — i.e. it keeps running server-side.
    expect(handle.signal.aborted).toBe(false);
    expect(svc.isLocallyActive('run-1')).toBe(true);
    // markStopRequested was never called by a mere detach.
    expect(repo.markStopRequested).not.toHaveBeenCalled();
  });

  it('requestStop aborts the live controller, marks the row, and reports true', async () => {
    const repo = makeRepo();
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    const handle = await svc.beginRun({
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    });
    const aborted = jest.fn();
    handle.signal.addEventListener('abort', aborted);

    const result = await svc.requestStop('run-1', 'ws-1');

    expect(result).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(repo.markStopRequested).toHaveBeenCalledWith('run-1', 'ws-1');
  });

  it('requestStop on a run this replica does NOT hold still marks the row (true)', async () => {
    // e.g. after a restart, or a sibling replica owns the controller. The row is
    // marked so the owning replica/sweep settles it; we report a stop took effect.
    const repo = makeRepo({
      markStopRequested: jest.fn(async () => ({ id: 'run-9' })),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    const result = await svc.requestStop('run-9', 'ws-1');
    expect(result).toBe(true);
    expect(svc.isLocallyActive('run-9')).toBe(false);
  });

  it('requestStop still aborts the live controller when markStopRequested rejects (transient DB error)', async () => {
    // F15: the in-memory abort is the ONLY thing that stops a run and must not be
    // hostage to the audit write of stop_requested_at. A transient failure on
    // markStopRequested must NOT prevent abort() nor make requestStop throw.
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const repo = makeRepo({
      markStopRequested: jest.fn(async () => {
        throw new Error('pool exhausted');
      }),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    const handle = await svc.beginRun({
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    });
    const aborted = jest.fn();
    handle.signal.addEventListener('abort', aborted);

    // Does NOT throw despite the DB write rejecting.
    const result = await svc.requestStop('run-1', 'ws-1');

    // The live turn was aborted even though the audit write failed...
    expect(handle.signal.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(repo.markStopRequested).toHaveBeenCalledWith('run-1', 'ws-1');
    // ...the catch branch logged the swallowed failure...
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // ...and a stop is reported as having taken effect (the entry existed).
    expect(result).toBe(true);
    warnSpy.mockRestore();
  });

  it('requestStop on an already-settled run (nothing active) reports false', async () => {
    const repo = makeRepo({
      markStopRequested: jest.fn(async () => undefined),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    const result = await svc.requestStop('run-done', 'ws-1');
    expect(result).toBe(false);
  });

  it('finalizeRun settles the row to the mapped status with finishedAt and drops the in-memory entry', async () => {
    const repo = makeRepo();
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    });
    expect(svc.isLocallyActive('run-1')).toBe(true);

    await svc.finalizeRun('run-1', 'ws-1', 'error', 'provider blew up');

    expect(svc.isLocallyActive('run-1')).toBe(false);
    // #487: the terminal write is CONDITIONAL (finalizeIfActive); finishedAt is
    // stamped inside the repo method, so the service passes just status + error.
    expect(repo.finalizeIfActive).toHaveBeenCalledWith(
      'run-1',
      'ws-1',
      expect.objectContaining({ status: 'failed', error: 'provider blew up' }),
    );
  });

  it('finalizeRun is IDEMPOTENT: a second settle no-ops (single terminal write)', async () => {
    // The #184 review fix: AiChatService.stream wraps the turn in a safety-net
    // catch that settles a failed turn AND streamText's terminal callback may
    // also settle — both routes call finalizeRun. Only the FIRST may write the
    // terminal row; the second must no-op so a late settle can never clobber the
    // real terminal status or double-write the row.
    const repo = makeRepo();
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    });

    await svc.finalizeRun('run-1', 'ws-1', 'error', 'first');
    expect(svc.isLocallyActive('run-1')).toBe(false);
    // A second settle (e.g. a streamText callback firing after the catch) no-ops.
    await svc.finalizeRun('run-1', 'ws-1', 'completed', undefined);

    expect(repo.finalizeIfActive).toHaveBeenCalledTimes(1);
    expect(repo.finalizeIfActive).toHaveBeenCalledWith(
      'run-1',
      'ws-1',
      expect.objectContaining({ status: 'failed', error: 'first' }),
    );
  });

  it('CONCURRENCY: two simultaneous finalizeRun on the same run write the terminal row EXACTLY ONCE (the 2nd caller exits synchronously at the atomic claim)', async () => {
    // The CRITICAL race: AiChatService.stream's safety-net catch settles the turn
    // to 'error' while a streamText terminal callback also settles it — both call
    // finalizeRun for the SAME runId. The once-gate must close ATOMICALLY: a
    // `settled.has` check alone is read BEFORE the awaited UPDATE, so both callers
    // would pass it and BOTH write the row (last-write-wins clobber + double
    // write). The fix claims the run with a SYNCHRONOUS `active.delete` before any
    // await, so the second caller returns in the same tick, before the UPDATE.
    //
    // We force the two calls to overlap by making `update` return a promise we
    // resolve only AFTER both finalizeRun calls have run their synchronous bodies.
    let resolveUpdate!: (v: unknown) => void;
    const updateGate = new Promise((res) => {
      resolveUpdate = res;
    });
    const finalizeIfActive = jest.fn(() => updateGate);
    const repo = makeRepo({ finalizeIfActive });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    });

    // Fire both before the (pending) update resolves. The first synchronously
    // claims the entry (active.delete) and awaits the write; the second, started
    // in the same macrotask, finds the entry already gone and returns at the claim
    // WITHOUT ever writing.
    const p1 = svc.finalizeRun('run-1', 'ws-1', 'completed');
    const p2 = svc.finalizeRun('run-1', 'ws-1', 'error', 'safety-net');

    // The decisive assertion: exactly one caller reached the terminal UPDATE.
    expect(finalizeIfActive).toHaveBeenCalledTimes(1);

    // Let the single in-flight update land; both calls resolve cleanly.
    resolveUpdate({ id: 'run-1', status: 'succeeded' });
    await Promise.all([p1, p2]);

    expect(finalizeIfActive).toHaveBeenCalledTimes(1);
    // The winner is the FIRST caller ('completed' -> 'succeeded'); the late
    // 'error' settle never wrote, so it could not clobber the real status.
    expect(finalizeIfActive).toHaveBeenCalledWith(
      'run-1',
      'ws-1',
      expect.objectContaining({ status: 'succeeded' }),
    );
    expect(svc.isLocallyActive('run-1')).toBe(false);
  });

  it('F6: a TRANSIENT terminal-write failure is ridden out by the bounded retry — the run is settled, not stranded', async () => {
    // The bug: finalizeRun used to DROP the in-memory entry BEFORE the terminal
    // UPDATE, then only warn-log a failure. A single transient blip (pool
    // exhaustion / deadlock / connection hiccup) on that PK UPDATE left the row
    // 'running' with nothing left to recover it -> every later turn in that chat
    // 409s until a restart. The fix updates FIRST and retries.
    let calls = 0;
    const repo = makeRepo({
      finalizeIfActive: jest.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('deadlock detected');
        return { id: 'run-1', status: 'succeeded' };
      }),
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    });

    await svc.finalizeRun('run-1', 'ws-1', 'completed');

    // The retry landed the terminal write: the entry is dropped (slot freed), no
    // zombie left, and the row carries the real terminal status.
    expect(svc.isLocallyActive('run-1')).toBe(false);
    expect(svc.hasZombie('run-1')).toBe(false);
    expect(repo.finalizeIfActive).toHaveBeenCalledTimes(2);
    expect(repo.finalizeIfActive).toHaveBeenLastCalledWith(
      'run-1',
      'ws-1',
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('#487 give-up: if the terminal write keeps failing, finalizeRun leaves a ZOMBIE (does NOT restore the entry) and settleZombie re-drives it', async () => {
    // Worst case: the DB is down for the whole first finalize (all attempts fail).
    // #487 changes the give-up behaviour: the entry is NOT restored (a restored
    // entry is indistinguishable from a live run). Instead a ZOMBIE record holds
    // the intended terminal status, and a re-drive (settleZombie — called by the
    // reconcile / supersede / opportunistic paths) applies it later.
    let healthy = false;
    const repo = makeRepo({
      finalizeIfActive: jest.fn(async () => {
        if (!healthy) throw new Error('pool exhausted');
        return { id: 'run-1', status: 'succeeded' };
      }),
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    });

    // First settle: every bounded attempt fails -> ZOMBIE, entry NOT restored.
    await svc.finalizeRun('run-1', 'ws-1', 'completed');
    expect(svc.isLocallyActive('run-1')).toBe(false); // NOT a live entry
    expect(svc.hasZombie('run-1')).toBe(true);
    expect(svc.zombieRunIds()).toContain('run-1');
    // The give-up emits ONE explicit, greppable ERROR mentioning the zombie.
    const gaveUp = errorSpy.mock.calls.some(
      (c) =>
        /NON-TERMINAL/.test(String(c[0])) &&
        /ZOMBIE/.test(String(c[0])) &&
        /run-1/.test(String(c[0])) &&
        /chat-1/.test(String(c[0])),
    );
    expect(gaveUp).toBe(true);
    // The settle notifier resolved as terminalWriteFailed (a subscriber learns the
    // slot still needs the intended status applied).
    const outcome = await svc.peekSettled('run-1');
    expect(outcome).toEqual({
      status: 'succeeded',
      error: null,
      terminalWriteFailed: true,
    });

    // The DB recovers; a re-drive settles the zombie via the conditional UPDATE.
    healthy = true;
    const redriven = await svc.settleZombie('run-1');
    expect(redriven).toBe(true);
    expect(svc.hasZombie('run-1')).toBe(false);
    expect(repo.finalizeIfActive).toHaveBeenLastCalledWith(
      'run-1',
      'ws-1',
      expect.objectContaining({ status: 'succeeded' }),
    );

    // A later finalizeRun is idempotent (row already terminal): it no-ops at the
    // once-gate, never re-writing.
    const callsBefore = repo.finalizeIfActive.mock.calls.length;
    await svc.finalizeRun('run-1', 'ws-1', 'error', 'late');
    expect(repo.finalizeIfActive).toHaveBeenCalledTimes(callsBefore);
  });

  it('#487 double-settle collapses to a benign no-op (conditional write; notifier resolves once)', async () => {
    // A second concurrent settle is stopped at the synchronous active.delete
    // claim, so the terminal write runs exactly once and the notifier resolves
    // exactly once with the FIRST settler's outcome.
    const repo = makeRepo();
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({ chatId: 'chat-1', workspaceId: 'ws-1', userId: 'u1' });

    await svc.finalizeRun('run-1', 'ws-1', 'aborted');
    await svc.finalizeRun('run-1', 'ws-1', 'error', 'late'); // no-op

    expect(repo.finalizeIfActive).toHaveBeenCalledTimes(1);
    const outcome = await svc.peekSettled('run-1');
    // peekSettled after resolve+delete falls through (notifier dropped, no zombie)
    // -> undefined; the FIRST settler already resolved any earlier subscriber.
    expect(outcome).toBeUndefined();
  });

  it('#487 late settledPromise subscriber gets the resolved outcome', async () => {
    const repo = makeRepo();
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({ chatId: 'chat-1', workspaceId: 'ws-1', userId: 'u1' });

    // Subscribe BEFORE settle: hold the promise reference (as supersede does).
    const early = svc.peekSettled('run-1');
    expect(early).toBeDefined();

    await svc.finalizeRun('run-1', 'ws-1', 'completed');

    // The reference grabbed before settle resolves with the written outcome, even
    // though the notifier was dropped from the map on resolve (bounded).
    await expect(early).resolves.toEqual({
      status: 'succeeded',
      error: null,
      terminalWriteFailed: false,
    });
  });

  it('recordStep / linkAssistantMessage are best-effort: a repo failure is swallowed', async () => {
    const repo = makeRepo({
      update: jest.fn(async () => {
        throw new Error('transient');
      }),
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await expect(svc.recordStep('run-1', 'ws-1', 3)).resolves.toBeUndefined();
    await expect(
      svc.linkAssistantMessage('run-1', 'ws-1', 'msg-1'),
    ).resolves.toBeUndefined();
  });
});

describe('#487 AiChatRunService.supersede (CAS)', () => {
  const chat = 'chat-1';
  const ws = 'ws-1';

  it('degrade: no active run on the chat -> caller sends a normal turn', async () => {
    const repo = makeRepo({
      findById: jest.fn(async () => undefined),
      findActiveByChat: jest.fn(async () => undefined),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    expect(await svc.supersede(chat, 'run-x', ws)).toEqual({ kind: 'degrade' });
  });

  it('invalid: the target run belongs to a DIFFERENT chat -> 400', async () => {
    const repo = makeRepo({
      findById: jest.fn(async () => ({
        id: 'run-x',
        chatId: 'other-chat',
        workspaceId: ws,
      })),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    expect(await svc.supersede(chat, 'run-x', ws)).toEqual({ kind: 'invalid' });
  });

  it('mismatch: a DIFFERENT run is active than the one targeted -> current runId', async () => {
    const repo = makeRepo({
      findById: jest.fn(async () => ({ id: 'run-x', chatId: chat, workspaceId: ws })),
      findActiveByChat: jest.fn(async () => ({
        id: 'run-live',
        chatId: chat,
        workspaceId: ws,
        status: 'running',
      })),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    expect(await svc.supersede(chat, 'run-x', ws)).toEqual({
      kind: 'mismatch',
      activeRunId: 'run-live',
    });
  });

  it('ready: the target IS active -> stop it, await its (fast) settle, free the slot', async () => {
    // Simulate a live long TOOL (NOT a slow UPDATE): the run stays active until an
    // explicit Stop unwinds it; commit-1's race makes that settle land quickly.
    // The abort listener stands in for streamText's onAbort -> finalizeRun.
    const repo = makeRepo({
      findById: jest.fn(async () => ({
        id: 'run-1',
        chatId: chat,
        workspaceId: ws,
        status: 'aborted',
        error: null,
      })),
      findActiveByChat: jest.fn(async () => ({
        id: 'run-1',
        chatId: chat,
        workspaceId: ws,
        status: 'running',
      })),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    const handle = await svc.beginRun({ chatId: chat, workspaceId: ws, userId: 'u1' });
    handle.signal.addEventListener('abort', () => {
      void svc.finalizeRun('run-1', ws, 'aborted');
    });

    // supersede: getRun -> getActiveByChat(==target) -> requestStop -> the abort
    // listener settles the run -> awaitSettled resolves -> ready.
    expect(await svc.supersede(chat, 'run-1', ws, 10_000)).toEqual({
      kind: 'ready',
    });
    expect(handle.signal.aborted).toBe(true); // Stop reached the run
  });

  it('timeout: the target never settles within W -> 409 SUPERSEDE_TIMEOUT (nothing persisted)', async () => {
    const repo = makeRepo({
      findById: jest.fn(async () => ({ id: 'run-1', chatId: chat, workspaceId: ws })),
      findActiveByChat: jest.fn(async () => ({
        id: 'run-1',
        chatId: chat,
        workspaceId: ws,
        status: 'running',
      })),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({ chatId: chat, workspaceId: ws, userId: 'u1' });
    // Do NOT settle the run: a tiny W elapses -> timeout.
    const result = await svc.supersede(chat, 'run-1', ws, 30);
    expect(result).toEqual({ kind: 'timeout' });
  });

  it('ready then a DUPLICATE supersede POST degrades (the run is already gone)', async () => {
    let active: unknown = {
      id: 'run-1',
      chatId: chat,
      workspaceId: ws,
      status: 'running',
    };
    const repo = makeRepo({
      findById: jest.fn(async () => ({
        id: 'run-1',
        chatId: chat,
        workspaceId: ws,
        status: 'aborted',
        error: null,
      })),
      findActiveByChat: jest.fn(async () => active),
      finalizeIfActive: jest.fn(async () => {
        active = undefined; // settling frees the active slot
        return { id: 'run-1', status: 'aborted' };
      }),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    const handle = await svc.beginRun({ chatId: chat, workspaceId: ws, userId: 'u1' });
    handle.signal.addEventListener('abort', () => {
      void svc.finalizeRun('run-1', ws, 'aborted');
    });

    expect(await svc.supersede(chat, 'run-1', ws, 10_000)).toEqual({
      kind: 'ready',
    });
    // The duplicate POST for the same target now finds no active run -> degrade.
    expect(await svc.supersede(chat, 'run-1', ws)).toEqual({ kind: 'degrade' });
  });

  it('reconcileStaleRuns: aborts a stale run with NO entry/zombie; NEVER touches a live entry', async () => {
    const finalizeIfActive = jest.fn(async () => ({ id: 'x', status: 'aborted' }));
    const repo = makeRepo({
      insert: jest.fn(async (v: any) => ({
        id: 'live-1',
        status: 'running',
        chatId: v.chatId,
        workspaceId: v.workspaceId,
      })),
      finalizeIfActive,
      findStaleActive: jest.fn(async () => [
        { id: 'orphan-1', workspaceId: ws, chatId: 'c-orphan' },
        { id: 'live-1', workspaceId: ws, chatId: 'c-live' },
      ]),
    });
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    // A LIVE run this replica owns (in the `active` map).
    await svc.beginRun({ chatId: 'c-live', workspaceId: ws, userId: 'u1' });
    expect(svc.isLocallyActive('live-1')).toBe(true);

    const aborted = await svc.reconcileStaleRuns(15 * 60 * 1000);
    expect(aborted).toBe(1);
    // The orphan (no entry) was aborted; the live entry was NEVER passed to the DB.
    expect(finalizeIfActive).toHaveBeenCalledTimes(1);
    expect(finalizeIfActive).toHaveBeenCalledWith(
      'orphan-1',
      ws,
      expect.objectContaining({ status: 'aborted' }),
    );
    expect(svc.isLocallyActive('live-1')).toBe(true);
  });

  it('gave-up zombie: supersede applies the intended status (settleZombie) then is ready', async () => {
    let healthy = false;
    let active: unknown = {
      id: 'run-1',
      chatId: chat,
      workspaceId: ws,
      status: 'running',
    };
    const repo = makeRepo({
      findById: jest.fn(async () => ({ id: 'run-1', chatId: chat, workspaceId: ws })),
      findActiveByChat: jest.fn(async () => active),
      finalizeIfActive: jest.fn(async () => {
        if (!healthy) throw new Error('db down');
        active = undefined;
        return { id: 'run-1', status: 'aborted' };
      }),
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({ chatId: chat, workspaceId: ws, userId: 'u1' });

    // The run's terminal write gives up -> zombie (row still 'running').
    await svc.finalizeRun('run-1', ws, 'aborted');
    expect(svc.hasZombie('run-1')).toBe(true);

    // The DB recovers; supersede awaits the (already-resolved, terminalWriteFailed)
    // settle, then settleZombie applies the intended status -> ready.
    healthy = true;
    expect(await svc.supersede(chat, 'run-1', ws, 10_000)).toEqual({
      kind: 'ready',
    });
    expect(svc.hasZombie('run-1')).toBe(false);
  });

  it('S5 micro-race: a periodic reconcile re-drives the zombie between awaitSettled and settleZombie -> supersede reports the freed slot as READY, NOT a false SUPERSEDE_TIMEOUT', async () => {
    // The scenario (self-healing today; this guard removes the transient false
    // timeout): finalizeRun gives up -> a zombie is recorded and the settle
    // notifier resolves terminalWriteFailed:true. supersede's awaitSettled reads
    // that (terminalWriteFailed:true) and moves to settleZombie. In the tiny
    // window BEFORE settleZombie runs, the periodic zombie reconcile WINS the
    // re-drive: it applies the intended status (row now TERMINAL) and clears the
    // zombie. So supersede's settleZombie finds no zombie -> returns false, yet
    // the slot is genuinely FREE. The guard re-reads the row and returns `ready`.
    let rowTerminal = false;
    const repo = makeRepo({
      // getRun / rowIsTerminal read the row: it flips to TERMINAL the moment the
      // reconcile wins (below), mirroring the conditional finalize the reconcile
      // applied.
      findById: jest.fn(async () => ({
        id: 'run-1',
        chatId: chat,
        workspaceId: ws,
        status: rowTerminal ? 'aborted' : 'running',
        error: null,
      })),
      findActiveByChat: jest.fn(async () => ({
        id: 'run-1',
        chatId: chat,
        workspaceId: ws,
        status: 'running',
      })),
      // The finalize keeps failing on THIS replica -> the run gives up (zombie).
      finalizeIfActive: jest.fn(async () => {
        throw new Error('db down for this replica');
      }),
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({ chatId: chat, workspaceId: ws, userId: 'u1' });

    // The terminal write gives up -> zombie (row still 'running' on this replica).
    await svc.finalizeRun('run-1', ws, 'aborted');
    expect(svc.hasZombie('run-1')).toBe(true);

    // Inject the concurrent reconcile at the exact race seam: when supersede
    // reaches settleZombie, the reconcile has ALREADY settled the row terminal
    // and cleared the zombie, so this call finds nothing to do (returns false).
    const settleSpy = jest
      .spyOn(svc, 'settleZombie')
      .mockImplementation(async (id: string) => {
        rowTerminal = true; // the reconcile's conditional UPDATE landed
        expect(svc.hasZombie(id)).toBe(true);
        const internal = svc as unknown as { zombies: Map<string, unknown> };
        internal.zombies.delete(id);
        return false; // zombie gone -> settleZombie's own contract returns false
      });

    // Without the guard this would be { kind: 'timeout' } (a FALSE timeout).
    expect(await svc.supersede(chat, 'run-1', ws, 10_000)).toEqual({
      kind: 'ready',
    });
    expect(settleSpy).toHaveBeenCalledWith('run-1');
  });

  it('S5 fail-safe (row NOT terminal): terminalWriteFailed + settleZombie fails AND the re-read row is still non-terminal -> a REAL SUPERSEDE_TIMEOUT (the give-up branch of the S5 guard)', async () => {
    // Mirror of the S5 micro-race, but on the GIVE-UP side (documented case 1): the
    // DB stays down for THIS replica, so finalizeRun gives up AND our OWN
    // settleZombie re-drive also throws -> returns false, and the row is never
    // flipped terminal. The S5 guard must NOT launder that into `ready`: it
    // re-reads the row (still 'running' -> non-terminal) and reports a genuine
    // timeout. This locks the fail-safe so a stuck 'running' row is never reported
    // as `ready` (which the caller would surface as the wrong RunAlreadyActiveError
    // instead of a clean SUPERSEDE_TIMEOUT). Reverting the S5 guard, or mutating
    // rowIsTerminal to `return true`, reds this.
    const repo = makeRepo({
      // The row is stranded non-terminal for the whole call: getRun (target
      // validation) and the S5 rowIsTerminal re-read both see 'running'.
      findById: jest.fn(async () => ({
        id: 'run-1',
        chatId: chat,
        workspaceId: ws,
        status: 'running',
        error: null,
      })),
      findActiveByChat: jest.fn(async () => ({
        id: 'run-1',
        chatId: chat,
        workspaceId: ws,
        status: 'running',
      })),
      // Finalize keeps failing on this replica -> finalizeRun gives up (zombie) AND
      // the real settleZombie re-drive also throws -> returns false.
      finalizeIfActive: jest.fn(async () => {
        throw new Error('db down for this replica');
      }),
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({ chatId: chat, workspaceId: ws, userId: 'u1' });

    // The terminal write gives up -> zombie (row still 'running' on this replica).
    await svc.finalizeRun('run-1', ws, 'aborted');
    expect(svc.hasZombie('run-1')).toBe(true);

    // settleZombie returns false (its own re-drive threw) AND rowIsTerminal reads
    // 'running' (non-terminal) -> the guard's fail-safe fires -> timeout.
    expect(await svc.supersede(chat, 'run-1', ws, 10_000)).toEqual({
      kind: 'timeout',
    });
    // Nothing settled the row, so the zombie is still held for a later re-drive.
    expect(svc.hasZombie('run-1')).toBe(true);
  });

  it('S5 fail-safe (rowIsTerminal read-error): terminalWriteFailed + settleZombie fails AND the row re-read THROWS -> timeout (the guard swallows the read error conservatively)', async () => {
    // Same give-up setup, but now the S5 re-read itself hits a DB read error.
    // rowIsTerminal swallows it and returns false (the outcome is UNCONFIRMED), so
    // the guard must fall through to a conservative timeout rather than a false
    // `ready`. Mutating rowIsTerminal to `return true` reds this too.
    let findByIdCalls = 0;
    const repo = makeRepo({
      // The FIRST read (supersede's getRun target validation) succeeds; the SECOND
      // read (the S5 rowIsTerminal re-read) throws a DB read error.
      findById: jest.fn(async () => {
        findByIdCalls += 1;
        if (findByIdCalls >= 2) {
          throw new Error('db read error on the S5 re-read');
        }
        return {
          id: 'run-1',
          chatId: chat,
          workspaceId: ws,
          status: 'running',
          error: null,
        };
      }),
      findActiveByChat: jest.fn(async () => ({
        id: 'run-1',
        chatId: chat,
        workspaceId: ws,
        status: 'running',
      })),
      finalizeIfActive: jest.fn(async () => {
        throw new Error('db down for this replica');
      }),
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const svc = new AiChatRunService(repo as never, makeEnv() as never);
    await svc.beginRun({ chatId: chat, workspaceId: ws, userId: 'u1' });

    // The terminal write gives up -> zombie (row still 'running' on this replica).
    await svc.finalizeRun('run-1', ws, 'aborted');
    expect(svc.hasZombie('run-1')).toBe(true);

    // settleZombie returns false and the rowIsTerminal re-read THROWS ->
    // rowIsTerminal swallows the error -> false -> a conservative timeout.
    expect(await svc.supersede(chat, 'run-1', ws, 10_000)).toEqual({
      kind: 'timeout',
    });
  });
});
