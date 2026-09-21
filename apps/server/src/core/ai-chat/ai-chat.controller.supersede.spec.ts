import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * #487 commit 3 — the single concurrency GATE (both modes) + the server supersede
 * CAS, at the controller boundary. The gate + CAS run BEFORE res.hijack(), so a
 * rejected concurrent start / a CAS branch returns clean JSON (an HttpException
 * the controller's post-hijack catch re-serializes). These assert the OBSERVABLE
 * HTTP contract against the real controller + a stubbed run service.
 */
describe('#487 AiChatController.stream — gate + supersede', () => {
  const user = { id: 'u1' } as User;

  function wsWith(autonomousRuns: boolean): Workspace {
    return {
      id: 'ws1',
      settings: { ai: { chat: true, autonomousRuns } },
    } as unknown as Workspace;
  }

  function makeReqRes(body: Record<string, unknown>) {
    const req = {
      raw: { sessionId: 'sess', once: jest.fn(), destroyed: false },
      body,
    };
    const res = {
      raw: {
        writableEnded: false,
        headersSent: false,
        on: jest.fn(),
        once: jest.fn(),
        setHeader: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
        flushHeaders: jest.fn(),
      },
      hijack: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    return { req, res };
  }

  function makeController(
    runServiceOverrides: Record<string, jest.Mock>,
    // The chat assertOwnedChat resolves. Default: a chat OWNED by `user` (u1), so
    // the ownership gate is transparent to the gate/CAS assertions below. Pass a
    // foreign-owner (or undefined) chat to exercise the #487 owner rejection.
    chat: { creatorId: string } | undefined = { creatorId: 'u1' },
  ) {
    const aiChatService = {
      resolveRoleForRequest: jest.fn().mockResolvedValue(null),
      getChatModel: jest.fn().mockResolvedValue({}),
      stream: jest.fn().mockResolvedValue(undefined),
    };
    const aiChatRunService = {
      getActiveForChat: jest.fn().mockResolvedValue(undefined),
      supersede: jest.fn(),
      beginRun: jest.fn().mockResolvedValue({
        runId: 'run-new',
        signal: new AbortController().signal,
      }),
      linkAssistantMessage: jest.fn(),
      recordStep: jest.fn(),
      finalizeRun: jest.fn(),
      requestStop: jest.fn(),
      ...runServiceOverrides,
    };
    const aiChatRepo = { findById: jest.fn().mockResolvedValue(chat) };
    const controller = new AiChatController(
      aiChatService as never,
      aiChatRunService as never,
      aiChatRepo as never, // aiChatRepo
      {} as never, // aiChatMessageRepo
      {} as never, // aiTranscription
      {} as never, // pageRepo
    );
    return { controller, aiChatService, aiChatRunService, aiChatRepo };
  }

  const codeOf = (err: unknown) =>
    (((err as HttpException).getResponse() as Record<string, unknown>) ?? {})
      .code;

  describe('single concurrency gate — BOTH modes reject the second tab with 409', () => {
    for (const autonomousRuns of [true, false]) {
      it(`rejects a concurrent start with 409 A_RUN_ALREADY_ACTIVE (autonomousRuns=${autonomousRuns})`, async () => {
        const { controller, aiChatRunService } = makeController({
          getActiveForChat: jest
            .fn()
            .mockResolvedValue({ id: 'run-live', chatId: 'c1' }),
        });
        const { req, res } = makeReqRes({ chatId: 'c1' });
        let thrown: unknown;
        try {
          await controller.stream(
            req as never,
            res as never,
            user,
            wsWith(autonomousRuns),
          );
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(ConflictException);
        expect((thrown as HttpException).getStatus()).toBe(409);
        expect(codeOf(thrown)).toBe('A_RUN_ALREADY_ACTIVE');
        // Rejected BEFORE committing to the stream (no hijack, no service.stream).
        expect(res.hijack).not.toHaveBeenCalled();
        expect(aiChatRunService.getActiveForChat).toHaveBeenCalledWith(
          'c1',
          'ws1',
        );
      });
    }
  });

  // #487 [security, F1]: stream() MUST owner-gate an existing chat exactly like its
  // six sibling endpoints, BEFORE the supersede CAS. Otherwise a same-workspace
  // non-owner could POST a supersede against another user's chat and (a) harvest
  // that user's active runId from the 409 SUPERSEDE_TARGET_MISMATCH body, then (b)
  // requestStop the foreign run. The gate must reject FIRST — no run lookup, no
  // supersede, no stop, no runId leak.
  describe('cross-user ownership gate (F1)', () => {
    it('a non-owner streaming against someone else\'s chat is rejected (403) with NO runId leak and NO foreign requestStop', async () => {
      // A live run exists on the victim's chat. Without the gate the supersede CAS
      // would run and (faithful to the run service) return a MISMATCH carrying the
      // victim's runId — the exact leak. With the gate it must never be reached.
      const getActiveForChat = jest
        .fn()
        .mockResolvedValue({ id: 'run-victim', chatId: 'c-other' });
      const supersede = jest
        .fn()
        .mockResolvedValue({ kind: 'mismatch', activeRunId: 'run-victim' });
      const requestStop = jest.fn();
      const { controller, aiChatService } = makeController(
        { getActiveForChat, supersede, requestStop },
        { creatorId: 'someone-else' }, // the chat is NOT owned by u1
      );
      const { req, res } = makeReqRes({
        chatId: 'c-other',
        supersede: { runId: 'guessed-uuid' },
      });
      let thrown: unknown;
      try {
        await controller.stream(req as never, res as never, user, wsWith(true));
      } catch (e) {
        thrown = e;
      }
      // Rejected by the ownership gate (403), the SAME shape the neighbors use.
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as HttpException).getStatus()).toBe(403);
      // Crucially NOT a 409 that would carry activeRunId — no runId is leaked.
      const payload = JSON.stringify(
        (thrown as HttpException).getResponse() ?? {},
      );
      expect(payload).not.toContain('run-victim');
      expect(codeOf(thrown)).not.toBe('SUPERSEDE_TARGET_MISMATCH');
      // The gate short-circuits BEFORE any run machinery runs.
      expect(getActiveForChat).not.toHaveBeenCalled();
      expect(supersede).not.toHaveBeenCalled();
      expect(requestStop).not.toHaveBeenCalled();
      expect(aiChatService.stream).not.toHaveBeenCalled();
      expect(res.hijack).not.toHaveBeenCalled();
    });
  });

  it('supersede MISMATCH -> 409 SUPERSEDE_TARGET_MISMATCH carrying the current runId', async () => {
    const { controller } = makeController({
      supersede: jest
        .fn()
        .mockResolvedValue({ kind: 'mismatch', activeRunId: 'run-other' }),
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    let thrown: unknown;
    try {
      await controller.stream(req as never, res as never, user, wsWith(true));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(codeOf(thrown)).toBe('SUPERSEDE_TARGET_MISMATCH');
    expect(
      ((thrown as HttpException).getResponse() as Record<string, unknown>)
        .activeRunId,
    ).toBe('run-other');
    expect(res.hijack).not.toHaveBeenCalled();
  });

  it('supersede TIMEOUT -> 409 SUPERSEDE_TIMEOUT, nothing streamed', async () => {
    const { controller } = makeController({
      supersede: jest.fn().mockResolvedValue({ kind: 'timeout' }),
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    let thrown: unknown;
    try {
      await controller.stream(req as never, res as never, user, wsWith(false));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(codeOf(thrown)).toBe('SUPERSEDE_TIMEOUT');
    expect(res.hijack).not.toHaveBeenCalled();
  });

  it('supersede INVALID (target on another chat) -> 400 SUPERSEDE_INVALID', async () => {
    const { controller } = makeController({
      supersede: jest.fn().mockResolvedValue({ kind: 'invalid' }),
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    let thrown: unknown;
    try {
      await controller.stream(req as never, res as never, user, wsWith(true));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(codeOf(thrown)).toBe('SUPERSEDE_INVALID');
  });

  it('supersede without chatId -> 400 SUPERSEDE_INVALID', async () => {
    const { controller, aiChatRunService } = makeController({});
    const { req, res } = makeReqRes({ supersede: { runId: 'run-x' } });
    let thrown: unknown;
    try {
      await controller.stream(req as never, res as never, user, wsWith(true));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(codeOf(thrown)).toBe('SUPERSEDE_INVALID');
    expect(aiChatRunService.supersede).not.toHaveBeenCalled();
  });

  it('supersede READY -> proceeds to stream with superseded=true', async () => {
    const { controller, aiChatService } = makeController({
      supersede: jest.fn().mockResolvedValue({ kind: 'ready' }),
      getActiveForChat: jest.fn().mockResolvedValue(undefined), // slot free after CAS
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    await controller.stream(req as never, res as never, user, wsWith(true));
    expect(res.hijack).toHaveBeenCalled();
    expect(aiChatService.stream).toHaveBeenCalledTimes(1);
    expect(aiChatService.stream.mock.calls[0][0].superseded).toBe(true);
    // The run hooks are always present now (both modes).
    expect(aiChatService.stream.mock.calls[0][0].runHooks).toBeDefined();
  });

  it('supersede DEGRADE -> proceeds to a normal send (superseded=false)', async () => {
    const { controller, aiChatService } = makeController({
      supersede: jest.fn().mockResolvedValue({ kind: 'degrade' }),
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    await controller.stream(req as never, res as never, user, wsWith(false));
    expect(aiChatService.stream).toHaveBeenCalledTimes(1);
    expect(aiChatService.stream.mock.calls[0][0].superseded).toBe(false);
  });
});
