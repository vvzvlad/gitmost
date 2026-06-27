import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Wiring spec for the #191 `POST /ai-chat/bound-chat` endpoint. It must forward
 * the requesting user + workspace + pageId to findLatestByPage and return the
 * matched chat's id, or `{ chatId: null }` when there is none. The repo already
 * scopes to the caller's OWN chats, so a foreign pageId simply yields no match
 * (null) — no extra page-access check is needed. Exercised with hand-rolled
 * mocks, no Nest graph and no DB.
 */
describe('AiChatController.boundChat', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  function makeController(chat: unknown) {
    const aiChatRepo = {
      findLatestByPage: jest.fn().mockResolvedValue(chat),
    };
    const controller = new AiChatController(
      {} as never,
      aiChatRepo as never,
      {} as never,
      {} as never,
    );
    return { controller, aiChatRepo };
  }

  it('returns the owned chat id and scopes the lookup to user + workspace + page', async () => {
    const { controller, aiChatRepo } = makeController({
      id: 'c1',
      creatorId: 'u1',
    });
    const res = await controller.boundChat({ pageId: 'p1' }, user, workspace);
    expect(aiChatRepo.findLatestByPage).toHaveBeenCalledWith('u1', 'ws1', 'p1');
    expect(res).toEqual({ chatId: 'c1' });
  });

  it('returns { chatId: null } for a page with no owned chat (incl. foreign pageId)', async () => {
    const { controller } = makeController(undefined);
    const res = await controller.boundChat({ pageId: 'foreign' }, user, workspace);
    expect(res).toEqual({ chatId: null });
  });
});
