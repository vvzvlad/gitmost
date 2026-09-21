import { Logger } from '@nestjs/common';
import { AiChatService, AiChatRunHooks } from './ai-chat.service';
import { AiChatRunService } from './ai-chat-run.service';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Lifecycle unit tests for AiChatService.onModuleInit (#183 crash-recovery
 * sweep). The sweep is BEST-EFFORT: a failure must be logged (warn) but must
 * NEVER throw out of onModuleInit and block server startup. Exercised with a
 * hand-rolled mock repo — no Nest graph, no DB. Only `aiChatMessageRepo` is
 * touched by onModuleInit, so the other constructor deps are stubbed as never.
 */
describe('AiChatService.onModuleInit (startup sweep)', () => {
  function makeService(sweepStreaming: jest.Mock) {
    const aiChatMessageRepo = { sweepStreaming };
    const service = new AiChatService(
      {} as never, // ai
      {} as never, // aiChatRepo
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      {} as never, // aiSettings
      {} as never, // tools
      {} as never, // mcpClients
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo
      {} as never, // pageAccess
      {} as never, // environment
    );
    return { service, aiChatMessageRepo };
  }

  afterEach(() => jest.restoreAllMocks());

  it('happy path: calls sweepStreaming and resolves', async () => {
    const sweepStreaming = jest.fn().mockResolvedValue(0);
    const { service } = makeService(sweepStreaming);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(sweepStreaming).toHaveBeenCalledTimes(1);
  });

  it('logs how many rows were swept when > 0', async () => {
    const sweepStreaming = jest.fn().mockResolvedValue(3);
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const { service } = makeService(sweepStreaming);
    await service.onModuleInit();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('3');
  });

  it('sweepStreaming throws -> onModuleInit resolves (does NOT throw) and warns', async () => {
    const sweepStreaming = jest
      .fn()
      .mockRejectedValue(new Error('db unavailable'));
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service } = makeService(sweepStreaming);
    // Must not throw — a sweep failure may never block startup.
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('db unavailable');
  });
});

/**
 * #184 CRITICAL run-lifecycle safety net (review fix). A transient failure
 * AFTER a successful beginRun but BEFORE streamText's terminal callbacks own the
 * lifecycle must STILL settle the run — otherwise the run row is stuck 'running'
 * forever (sweepRunning only runs at startup) and the partial unique index + the
 * controller pre-check 409 every future turn in that chat until a restart. Here
 * we model the very first bare await after beginRun (the user-message insert)
 * throwing, wiring the run hooks to a REAL AiChatRunService (mock repo) exactly
 * as the controller does, and assert the run is settled to 'error' and its
 * in-memory entry dropped (so a follow-up turn would NOT be 409'd).
 */
describe('AiChatService.stream run-lifecycle safety net (#184)', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  afterEach(() => jest.restoreAllMocks());

  it('an exception after beginRun settles the run to error and drops the in-memory entry', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    // Real run service over a mock repo, so finalizeRun's in-memory bookkeeping
    // (active.delete) is exercised for real.
    const runRepo = {
      insert: jest.fn().mockResolvedValue({ id: 'run-1', status: 'running' }),
      update: jest.fn().mockResolvedValue({ id: 'run-1' }),
      // #487: the terminal settle now goes through the CONDITIONAL write.
      finalizeIfActive: jest
        .fn()
        .mockResolvedValue({ id: 'run-1', status: 'failed' }),
      findById: jest.fn().mockResolvedValue(undefined),
    };
    const runService = new AiChatRunService(runRepo as never, { isCloud: () => false } as never);

    // The user-message insert throws. #489 runs the history load + convert BEFORE
    // the insert (convert-before-insert, so a retry cannot duplicate the user row),
    // so `findAllByChat` (a real repo method) is now called first — stub it to an
    // empty history so the flow reaches the insert. Both awaits are AFTER beginRun,
    // so the "exception after beginRun -> settled to error" invariant is unchanged;
    // the throw point simply moved from insert to a later insert after a no-op load.
    const aiChatMessageRepo = {
      findAllByChat: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockRejectedValue(new Error('insert boom')),
    };
    const aiChatRepo = {
      // Existing chat -> chatId stays, no new-chat insert path.
      findById: jest.fn().mockResolvedValue({ id: 'chat-1', creatorId: 'u1' }),
    };

    const service = new AiChatService(
      {} as never, // ai
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      {} as never, // aiSettings
      {} as never, // tools
      {} as never, // mcpClients
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo
      {} as never, // pageAccess
      {} as never, // environment
    );

    const runHooks: AiChatRunHooks = {
      begin: (chatId) =>
        runService.beginRun({
          chatId,
          workspaceId: workspace.id,
          userId: user.id,
          trigger: 'user',
        }),
      onSettled: (runId, status, error) =>
        runService.finalizeRun(runId, workspace.id, status, error),
    };

    await expect(
      service.stream({
        user,
        workspace,
        sessionId: 'sess',
        body: {
          chatId: 'chat-1',
          messages: [
            { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          ],
        },
        res: {} as never,
        signal: new AbortController().signal,
        model: {} as never,
        role: null,
        runHooks,
      }),
    ).rejects.toThrow('insert boom');

    // The run was begun...
    expect(runRepo.insert).toHaveBeenCalledTimes(1);
    // ...then settled to a terminal FAILED status by the safety net (via the
    // #487 conditional write)...
    expect(runRepo.finalizeIfActive).toHaveBeenCalledTimes(1);
    expect(runRepo.finalizeIfActive).toHaveBeenCalledWith(
      'run-1',
      'ws1',
      expect.objectContaining({ status: 'failed' }),
    );
    // ...and the in-memory entry is gone, so a follow-up turn is NOT 409'd.
    expect(runService.isLocallyActive('run-1')).toBe(false);
  });
});
