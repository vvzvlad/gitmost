// Spy on the module-level bounded skip-counter so criterion 15 can assert it fires.
jest.mock('../../integrations/metrics/metrics.registry', () => ({
  incAiChatBindSkipped: jest.fn(),
}));
import { incAiChatBindSkipped } from '../../integrations/metrics/metrics.registry';
import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Wiring spec for POST /ai-chat/bind-page (#665): the conscious-open writer. It
 * re-binds (history select) or clears ("New chat") the page->chat pointer, fail-
 * SOFT (every "not applied" outcome is 200 { chatId: null } with NO write) and
 * fail-CLOSED on a chat the caller does not own — with a WARN + a bounded skip
 * counter on each skip (criterion 15). slugId in `pageId` is resolved before the
 * uuid column (#312, criterion 17). Hand-rolled mocks, no Nest graph, no DB.
 */
describe('AiChatController.bindPage', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  function makeController(opts: {
    page: unknown;
    ownership?: unknown;
  }) {
    const bindingRepo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    const aiChatRepo = {
      findOwnershipById: jest.fn().mockResolvedValue(opts.ownership),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(opts.page),
    };
    const controller = new AiChatController(
      {} as never,
      {} as never, // aiChatRunService
      aiChatRepo as never,
      {} as never, // aiChatMessageRepo
      {} as never, // aiTranscription
      pageRepo as never,
      undefined, // streamRegistry
      undefined, // environment
      undefined, // aiChatRunStepRepo
      bindingRepo as never,
    );
    return { controller, bindingRepo, aiChatRepo, pageRepo };
  }

  beforeEach(() => {
    (incAiChatBindSkipped as jest.Mock).mockClear();
  });

  it('re-binds an owned live chat, resolving a slugId to the page uuid (#312)', async () => {
    const { controller, bindingRepo, pageRepo } = makeController({
      page: { id: 'page-uuid-1', workspaceId: 'ws1' },
      ownership: { creatorId: 'u1', workspaceId: 'ws1', deletedAt: null },
    });
    const res = await controller.bindPage(
      { pageId: 'i82qXsivsx', chatId: 'c1' },
      user,
      workspace,
    );
    expect(pageRepo.findById).toHaveBeenCalledWith('i82qXsivsx');
    // The upsert must receive the RESOLVED uuid, never the raw slugId.
    expect(bindingRepo.upsert).toHaveBeenCalledWith('u1', 'page-uuid-1', 'c1');
    expect(res).toEqual({ chatId: 'c1' });
    expect(incAiChatBindSkipped).not.toHaveBeenCalled();
  });

  it('clears the binding when chatId is null ("New chat")', async () => {
    const { controller, bindingRepo, aiChatRepo } = makeController({
      page: { id: 'page-uuid-1', workspaceId: 'ws1' },
    });
    const res = await controller.bindPage(
      { pageId: 'page-uuid-1', chatId: null },
      user,
      workspace,
    );
    expect(bindingRepo.clear).toHaveBeenCalledWith('u1', 'page-uuid-1');
    expect(aiChatRepo.findOwnershipById).not.toHaveBeenCalled();
    expect(res).toEqual({ chatId: null });
  });

  it('fail-soft on an unresolved page: no write, WARN + counter (page_unresolved)', async () => {
    const { controller, bindingRepo } = makeController({ page: undefined });
    const res = await controller.bindPage(
      { pageId: 'nope', chatId: 'c1' },
      user,
      workspace,
    );
    expect(res).toEqual({ chatId: null });
    expect(bindingRepo.upsert).not.toHaveBeenCalled();
    expect(bindingRepo.clear).not.toHaveBeenCalled();
    expect(incAiChatBindSkipped).toHaveBeenCalledWith('page_unresolved');
  });

  it('criterion 15: a foreign chat is NOT bound, and it is visible (chat_not_owned)', async () => {
    const { controller, bindingRepo } = makeController({
      page: { id: 'page-uuid-1', workspaceId: 'ws1' },
      ownership: { creatorId: 'someone-else', workspaceId: 'ws1', deletedAt: null },
    });
    const res = await controller.bindPage(
      { pageId: 'page-uuid-1', chatId: 'foreign-chat' },
      user,
      workspace,
    );
    expect(res).toEqual({ chatId: null });
    expect(bindingRepo.upsert).not.toHaveBeenCalled();
    expect(incAiChatBindSkipped).toHaveBeenCalledWith('chat_not_owned');
  });

  it('a soft-deleted chat is NOT bound and is distinguished (chat_deleted)', async () => {
    const { controller, bindingRepo } = makeController({
      page: { id: 'page-uuid-1', workspaceId: 'ws1' },
      ownership: {
        creatorId: 'u1',
        workspaceId: 'ws1',
        deletedAt: new Date(),
      },
    });
    const res = await controller.bindPage(
      { pageId: 'page-uuid-1', chatId: 'c1' },
      user,
      workspace,
    );
    expect(res).toEqual({ chatId: null });
    expect(bindingRepo.upsert).not.toHaveBeenCalled();
    expect(incAiChatBindSkipped).toHaveBeenCalledWith('chat_deleted');
  });

  it('a chat in a different workspace is NOT bound (chat_not_owned)', async () => {
    const { controller, bindingRepo } = makeController({
      page: { id: 'page-uuid-1', workspaceId: 'ws1' },
      ownership: { creatorId: 'u1', workspaceId: 'other-ws', deletedAt: null },
    });
    const res = await controller.bindPage(
      { pageId: 'page-uuid-1', chatId: 'c1' },
      user,
      workspace,
    );
    expect(res).toEqual({ chatId: null });
    expect(bindingRepo.upsert).not.toHaveBeenCalled();
    expect(incAiChatBindSkipped).toHaveBeenCalledWith('chat_not_owned');
  });
});
