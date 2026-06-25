import { ForbiddenException } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Wiring spec for the #183 `POST /ai-chat/export` endpoint. It must: own-gate via
 * the chat lookup (workspace-scoped + creator-owned), load the FULL transcript
 * via findAllByChat, render server-side, and return `{ markdown }`. Exercised by
 * instantiating the controller with hand-rolled mocks — no Nest graph, no DB.
 */
describe('AiChatController.export', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  function makeController(
    over: {
      chat?: unknown;
      rows?: unknown[];
    } = {},
  ) {
    const chat =
      'chat' in over
        ? over.chat
        : { id: 'c1', creatorId: 'u1', title: 'My chat' };
    const aiChatRepo = {
      findById: jest.fn().mockResolvedValue(chat),
    };
    const aiChatMessageRepo = {
      findAllByChat: jest.fn().mockResolvedValue(
        over.rows ?? [
          {
            id: 'm1',
            role: 'user',
            content: 'hi',
            metadata: null,
            status: null,
          },
          {
            id: 'm2',
            role: 'assistant',
            content: 'hello',
            metadata: null,
            status: 'completed',
          },
        ],
      ),
    };
    const controller = new AiChatController(
      {} as never,
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never,
    );
    return { controller, aiChatRepo, aiChatMessageRepo };
  }

  it('renders the full transcript and returns { markdown }', async () => {
    const { controller, aiChatMessageRepo } = makeController();
    const res = await controller.export({ chatId: 'c1' }, user, workspace);
    expect(aiChatMessageRepo.findAllByChat).toHaveBeenCalledWith('c1', 'ws1');
    expect(res.markdown).toContain('# My chat');
    expect(res.markdown).toContain('## 1. You');
    expect(res.markdown).toContain('## 2. AI agent');
  });

  it('forbids a chat the user does not own', async () => {
    const { controller } = makeController({
      chat: { id: 'c1', creatorId: 'someone-else', title: 'X' },
    });
    await expect(
      controller.export({ chatId: 'c1' }, user, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids a missing / foreign-workspace chat', async () => {
    const { controller } = makeController({ chat: null });
    await expect(
      controller.export({ chatId: 'c1' }, user, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('localizes labels when lang=ru is passed', async () => {
    const { controller } = makeController();
    const res = await controller.export(
      { chatId: 'c1', lang: 'ru' },
      user,
      workspace,
    );
    expect(res.markdown).toContain('## 1. Вы');
    expect(res.markdown).toContain('## 2. ИИ-агент');
  });
});
