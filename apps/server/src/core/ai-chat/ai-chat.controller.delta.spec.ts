import { ForbiddenException } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Wiring spec for the #491 delta-poll endpoint (`POST /ai-chat/messages/delta`).
 * Owner-gated via assertOwnedChat (same gate as the other reads), NOT flag-gated.
 * The run fact rides IN the delta response (no separate /run poll). Hand-rolled
 * mocks — no Nest graph, no DB. Constructor order: (aiChatService,
 * aiChatRunService, aiChatRepo, aiChatMessageRepo, aiTranscription, pageRepo).
 */
describe('AiChatController POST /ai-chat/messages/delta (#491)', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  function makeController(opts: {
    chat?: unknown;
    delta?: { rows: unknown[]; cursor: string };
    run?: unknown;
  }) {
    const aiChatRunService = {
      getLatestForChat: jest.fn().mockResolvedValue(opts.run),
    };
    const aiChatRepo = {
      findById: jest.fn().mockResolvedValue(opts.chat),
    };
    const aiChatMessageRepo = {
      findByChatUpdatedAfter: jest
        .fn()
        .mockResolvedValue(opts.delta ?? { rows: [], cursor: 'C1' }),
    };
    const controller = new AiChatController(
      {} as never,
      aiChatRunService as never,
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never,
      {} as never,
    );
    return { controller, aiChatRunService, aiChatRepo, aiChatMessageRepo };
  }

  it('owner-gates: a chat the user does not own throws, never reaching the repo', async () => {
    const { controller, aiChatMessageRepo, aiChatRunService } = makeController({
      chat: { id: 'c1', creatorId: 'someone-else' },
    });
    await expect(
      controller.getMessagesDelta({ chatId: 'c1' }, user, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(aiChatMessageRepo.findByChatUpdatedAfter).not.toHaveBeenCalled();
    expect(aiChatRunService.getLatestForChat).not.toHaveBeenCalled();
  });

  it('returns { rows, cursor, run:{id,status} } with the run fact inlined', async () => {
    const rows = [{ id: 'm1' }];
    const { controller } = makeController({
      chat: { id: 'c1', creatorId: 'u1' },
      delta: { rows, cursor: 'C2' },
      run: { id: 'r1', status: 'running', error: 'ignored', stepCount: 3 },
    });
    const res = await controller.getMessagesDelta(
      { chatId: 'c1', cursor: 'C1' },
      user,
      workspace,
    );
    expect(res).toEqual({
      rows,
      cursor: 'C2',
      // ONLY id + status — never the whole run row.
      run: { id: 'r1', status: 'running' },
    });
  });

  it('run is null when the chat has never had a run', async () => {
    const { controller } = makeController({
      chat: { id: 'c1', creatorId: 'u1' },
      run: undefined,
    });
    const res = await controller.getMessagesDelta(
      { chatId: 'c1' },
      user,
      workspace,
    );
    expect(res.run).toBeNull();
  });

  it('passes cursor through, defaulting a missing cursor to null (first poll)', async () => {
    const { controller, aiChatMessageRepo } = makeController({
      chat: { id: 'c1', creatorId: 'u1' },
    });
    await controller.getMessagesDelta({ chatId: 'c1' }, user, workspace);
    expect(aiChatMessageRepo.findByChatUpdatedAfter).toHaveBeenCalledWith(
      'c1',
      'ws1',
      null,
    );
    await controller.getMessagesDelta(
      { chatId: 'c1', cursor: 'CX' },
      user,
      workspace,
    );
    expect(aiChatMessageRepo.findByChatUpdatedAfter).toHaveBeenLastCalledWith(
      'c1',
      'ws1',
      'CX',
    );
  });
});
