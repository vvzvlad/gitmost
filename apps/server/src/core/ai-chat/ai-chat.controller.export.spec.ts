import { ForbiddenException } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import {
  planFinalizeAssistant,
  applyFinalize,
  flushAssistant,
  type AssistantFlush,
} from './ai-chat.service';
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

/**
 * The terminal-finalize dispatch (#183): the assistant row is INSERTed upfront
 * as 'streaming' and finalized once on the terminal callback. When the upfront
 * insert SUCCEEDED (we hold an id) finalize UPDATEs that row; when it FAILED
 * (assistantId is undefined) finalize falls back to INSERTing the terminal row
 * so the turn is not lost — the only safety against losing the turn entirely.
 *
 * `planFinalizeAssistant` is the pure decision; `applyFinalize` is the REAL
 * dispatch the service uses, exercised here over a mock repo (not a copy of the
 * logic) so a production drift would fail the test (#186 review).
 */
describe('finalizeAssistant dispatch (planFinalizeAssistant + applyFinalize)', () => {
  const workspaceId = 'ws1';

  // Drive the SAME applyFinalize the service calls (no duplicated logic).
  async function dispatchFinalize(
    repo: { insert: jest.Mock; update: jest.Mock },
    assistantId: string | undefined,
    flushed: AssistantFlush,
  ): Promise<void> {
    await applyFinalize(
      repo,
      planFinalizeAssistant(assistantId),
      { chatId: 'c1', workspaceId, userId: 'u1' },
      flushed,
    );
  }

  it('plan: update when the upfront insert returned an id', () => {
    expect(planFinalizeAssistant('a1')).toEqual({ kind: 'update', id: 'a1' });
  });

  it('plan: insert (fallback) when there is no upfront id', () => {
    expect(planFinalizeAssistant(undefined)).toEqual({ kind: 'insert' });
  });

  it('(a) upfront insert succeeded -> finalize UPDATEs the row by id', async () => {
    const repo = { insert: jest.fn(), update: jest.fn() };
    const flushed = flushAssistant([], 'final answer', 'completed', {
      finishReason: 'stop',
    });
    await dispatchFinalize(repo, 'a1', flushed);
    expect(repo.update).toHaveBeenCalledWith('a1', workspaceId, flushed);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('(b) upfront insert failed -> finalize INSERTs the terminal payload', async () => {
    const repo = { insert: jest.fn(), update: jest.fn() };
    const flushed = flushAssistant([], 'partial', 'error', { error: 'boom' });
    await dispatchFinalize(repo, undefined, flushed);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.insert).toHaveBeenCalledTimes(1);
    const arg = repo.insert.mock.calls[0][0];
    // The fallback insert carries the terminal content/status/metadata.
    expect(arg.role).toBe('assistant');
    expect(arg.content).toBe('partial');
    expect(arg.status).toBe('error');
    expect((arg.metadata as { error?: string }).error).toBe('boom');
  });
});
