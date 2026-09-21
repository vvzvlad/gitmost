import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Wiring spec for POST /ai-chat/bound-chat after #665: the resolver now reads the
 * mutable `ai_chat_page_bindings` pointer (AiChatPageBindingRepo.findChatIdByPage),
 * NOT the retired findLatestByPage heuristic. #312 is still honoured: `dto.pageId`
 * carries a slugId OR a uuid, so the controller FIRST resolves it via
 * PageRepo.findById (which accepts both) and a page in a different workspace (or an
 * unknown id) yields { chatId: null } without ever touching the binding lookup.
 * Hand-rolled mocks, no Nest graph and no DB.
 */
describe('AiChatController.boundChat', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  function makeController(opts: { page: unknown; chatId?: string | null }) {
    const bindingRepo = {
      findChatIdByPage: jest.fn().mockResolvedValue(opts.chatId ?? null),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(opts.page),
    };
    // Positional: aiChatService, aiChatRunService, aiChatRepo, aiChatMessageRepo,
    // aiTranscription, pageRepo, streamRegistry?, environment?, aiChatRunStepRepo?,
    // aiChatPageBindingRepo?
    const controller = new AiChatController(
      {} as never,
      {} as never, // aiChatRunService
      {} as never, // aiChatRepo
      {} as never, // aiChatMessageRepo
      {} as never, // aiTranscription
      pageRepo as never,
      undefined, // streamRegistry
      undefined, // environment
      undefined, // aiChatRunStepRepo
      bindingRepo as never,
    );
    return { controller, bindingRepo, pageRepo };
  }

  it('resolves a slugId to the page uuid and returns the bound chat id', async () => {
    const { controller, bindingRepo, pageRepo } = makeController({
      // findById accepts a slugId and returns the page with its real uuid.
      page: { id: 'page-uuid-1', workspaceId: 'ws1' },
      chatId: 'c1',
    });
    // The client sends a 10-char nanoid slugId, NOT a uuid.
    const res = await controller.boundChat(
      { pageId: 'i82qXsivsx' },
      user,
      workspace,
    );
    expect(pageRepo.findById).toHaveBeenCalledWith('i82qXsivsx');
    // findChatIdByPage must receive the RESOLVED uuid, never the raw slugId.
    expect(bindingRepo.findChatIdByPage).toHaveBeenCalledWith(
      'u1',
      'ws1',
      'page-uuid-1',
    );
    expect(res).toEqual({ chatId: 'c1' });
  });

  it('returns { chatId: null } for a page in a DIFFERENT workspace without a binding lookup', async () => {
    const { controller, bindingRepo, pageRepo } = makeController({
      page: { id: 'page-uuid-2', workspaceId: 'other-ws' },
    });
    const res = await controller.boundChat(
      { pageId: 'foreignSlug' },
      user,
      workspace,
    );
    expect(pageRepo.findById).toHaveBeenCalledWith('foreignSlug');
    // No cross-workspace leak: the binding lookup must never run.
    expect(bindingRepo.findChatIdByPage).not.toHaveBeenCalled();
    expect(res).toEqual({ chatId: null });
  });

  it('returns { chatId: null } for an unknown id without throwing or looking up a binding', async () => {
    const { controller, bindingRepo } = makeController({ page: undefined });
    const res = await controller.boundChat(
      { pageId: 'does-not-exist' },
      user,
      workspace,
    );
    expect(bindingRepo.findChatIdByPage).not.toHaveBeenCalled();
    expect(res).toEqual({ chatId: null });
  });

  it('returns { chatId: null } when the page has no binding', async () => {
    const { controller } = makeController({
      page: { id: 'page-uuid-3', workspaceId: 'ws1' },
      chatId: null,
    });
    const res = await controller.boundChat({ pageId: 'p3' }, user, workspace);
    expect(res).toEqual({ chatId: null });
  });
});
