import { Logger } from '@nestjs/common';
import { AiChatService } from './ai-chat.service';

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
