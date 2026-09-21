import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Wiring spec for the #184 run-reconnect / run-stop endpoints
 * (`POST /ai-chat/run` and `POST /ai-chat/stop`). Both are OWNER-gated via
 * assertOwnedChat (the requesting user must own the chat) and NOT flag-gated.
 * Exercised with hand-rolled mocks — no Nest graph, no DB. The controller's
 * constructor order is (aiChatService, aiChatRunService, aiChatRepo,
 * aiChatMessageRepo, aiTranscription).
 */
describe('AiChatController run endpoints (#184)', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  function makeController(opts: {
    chat?: unknown; // what aiChatRepo.findById returns (owner-gate)
    run?: unknown; // getLatestForChat / getRun result
    activeRun?: unknown; // getActiveForChat result
    message?: unknown; // aiChatMessageRepo.findById result
    stopped?: boolean; // requestStop result
  }) {
    const aiChatRunService = {
      getLatestForChat: jest.fn().mockResolvedValue(opts.run),
      getRun: jest.fn().mockResolvedValue(opts.run),
      getActiveForChat: jest.fn().mockResolvedValue(opts.activeRun),
      requestStop: jest.fn().mockResolvedValue(opts.stopped ?? false),
    };
    const aiChatRepo = {
      findById: jest.fn().mockResolvedValue(opts.chat),
    };
    const aiChatMessageRepo = {
      findById: jest.fn().mockResolvedValue(opts.message),
    };
    const controller = new AiChatController(
      {} as never, // aiChatService
      aiChatRunService as never,
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiTranscription
      {} as never, // pageRepo
    );
    return { controller, aiChatRunService, aiChatRepo, aiChatMessageRepo };
  }

  describe('POST /ai-chat/run (getRun)', () => {
    it('owner-gates: a chat the user does not own throws ForbiddenException', async () => {
      const { controller, aiChatRunService } = makeController({
        chat: { id: 'c1', creatorId: 'someone-else' },
      });
      await expect(
        controller.getRun({ chatId: 'c1' }, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // It must NOT reach the run lookup once the owner-gate fails.
      expect(aiChatRunService.getLatestForChat).not.toHaveBeenCalled();
    });

    it('returns { run: null, message: null } when the chat has never had a run', async () => {
      const { controller, aiChatRunService } = makeController({
        chat: { id: 'c1', creatorId: 'u1' },
        run: undefined,
      });
      const res = await controller.getRun({ chatId: 'c1' }, user, workspace);
      expect(res).toEqual({ run: null, message: null });
      expect(aiChatRunService.getLatestForChat).toHaveBeenCalledWith(
        'c1',
        'ws1',
      );
    });

    it('returns the run and its projected assistant message', async () => {
      const run = { id: 'run-1', chatId: 'c1', assistantMessageId: 'm1' };
      const message = { id: 'm1', role: 'assistant' };
      const { controller, aiChatMessageRepo } = makeController({
        chat: { id: 'c1', creatorId: 'u1' },
        run,
        message,
      });
      const res = await controller.getRun({ chatId: 'c1' }, user, workspace);
      expect(res).toEqual({ run, message });
      expect(aiChatMessageRepo.findById).toHaveBeenCalledWith('m1', 'ws1');
    });

    it('returns message: null when the run has no linked assistant message', async () => {
      const run = { id: 'run-1', chatId: 'c1', assistantMessageId: null };
      const { controller, aiChatMessageRepo } = makeController({
        chat: { id: 'c1', creatorId: 'u1' },
        run,
      });
      const res = await controller.getRun({ chatId: 'c1' }, user, workspace);
      expect(res).toEqual({ run, message: null });
      expect(aiChatMessageRepo.findById).not.toHaveBeenCalled();
    });
  });

  describe('POST /ai-chat/stop (stopRun)', () => {
    it('throws BadRequestException when neither runId nor chatId is given', async () => {
      const { controller } = makeController({});
      await expect(
        controller.stopRun({}, user, workspace),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('stops by runId: owner-gates via the run’s chat, then requests the stop', async () => {
      const { controller, aiChatRunService, aiChatRepo } = makeController({
        run: { id: 'run-1', chatId: 'c1' },
        chat: { id: 'c1', creatorId: 'u1' },
        stopped: true,
      });
      const res = await controller.stopRun({ runId: 'run-1' }, user, workspace);
      expect(res).toEqual({ stopped: true });
      expect(aiChatRunService.getRun).toHaveBeenCalledWith('run-1', 'ws1');
      expect(aiChatRepo.findById).toHaveBeenCalledWith('c1', 'ws1');
      expect(aiChatRunService.requestStop).toHaveBeenCalledWith('run-1', 'ws1');
    });

    it('stops by runId: a foreign run’s chat throws ForbiddenException (no stop)', async () => {
      const { controller, aiChatRunService } = makeController({
        run: { id: 'run-1', chatId: 'c1' },
        chat: { id: 'c1', creatorId: 'someone-else' },
      });
      await expect(
        controller.stopRun({ runId: 'run-1' }, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(aiChatRunService.requestStop).not.toHaveBeenCalled();
    });

    it('stops by runId: an unknown run reports { stopped: false }', async () => {
      const { controller, aiChatRunService } = makeController({
        run: undefined,
      });
      const res = await controller.stopRun({ runId: 'gone' }, user, workspace);
      expect(res).toEqual({ stopped: false });
      expect(aiChatRunService.requestStop).not.toHaveBeenCalled();
    });

    it('stops by chatId: owner-gates, resolves the active run, requests the stop', async () => {
      const { controller, aiChatRunService, aiChatRepo } = makeController({
        chat: { id: 'c1', creatorId: 'u1' },
        activeRun: { id: 'run-9' },
        stopped: true,
      });
      const res = await controller.stopRun({ chatId: 'c1' }, user, workspace);
      expect(res).toEqual({ stopped: true });
      expect(aiChatRepo.findById).toHaveBeenCalledWith('c1', 'ws1');
      expect(aiChatRunService.getActiveForChat).toHaveBeenCalledWith(
        'c1',
        'ws1',
      );
      expect(aiChatRunService.requestStop).toHaveBeenCalledWith('run-9', 'ws1');
    });

    it('stops by chatId: reports { stopped: false } when no run is active', async () => {
      const { controller, aiChatRunService } = makeController({
        chat: { id: 'c1', creatorId: 'u1' },
        activeRun: undefined,
      });
      const res = await controller.stopRun({ chatId: 'c1' }, user, workspace);
      expect(res).toEqual({ stopped: false });
      expect(aiChatRunService.requestStop).not.toHaveBeenCalled();
    });
  });
});
