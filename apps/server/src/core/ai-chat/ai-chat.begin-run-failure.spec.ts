import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiChatService } from './ai-chat.service';
import { RunAlreadyActiveError } from './ai-chat-run.service';

/**
 * Fail-fast guard for beginRun failures (#486, commit 4).
 *
 * When runHooks.begin() rejects for a reason OTHER than RunAlreadyActiveError
 * (e.g. a DB-pool blip), the turn must NOT continue untracked. The old code
 * logged and streamed anyway, leaving a run with NO run-row: in autonomous mode
 * nobody could abort it (/stop can't see it, disconnect doesn't abort it, and the
 * one-run gate would admit a SECOND run) — an unstoppable invisible run until
 * restart. The fix throws A_RUN_BEGIN_FAILED (503) BEFORE the first byte and
 * before the user row is persisted.
 *
 * We drive `stream()` directly on a prototype instance wired with only the
 * collaborators it touches before the throw, so the assertion is on the REAL
 * control flow, not a mock of it.
 */
describe('AiChatService beginRun failure (#486)', () => {
  function makeService(insertSpy: jest.Mock): AiChatService {
    // Bypass the (heavy) DI constructor: exercise the real stream() method on a
    // bare prototype instance with just the fields reached before the throw.
    // `any` because the private `logger` field makes a typed intersection collapse.
    const svc = Object.create(AiChatService.prototype);
    svc.aiChatRepo = {
      // Existing chat -> no insert path; chatId is kept as-is.
      findById: jest.fn().mockResolvedValue({ id: 'chat1' }),
    };
    svc.aiChatMessageRepo = { insert: insertSpy };
    svc.logger = new Logger('test');
    return svc as AiChatService;
  }

  const baseArgs = () => {
    const write = jest.fn();
    const res = {
      raw: { write, writableEnded: false, headersSent: false },
    };
    return {
      user: { id: 'u1' } as never,
      workspace: { id: 'w1' } as never,
      sessionId: 's1',
      // openPage undefined -> resolveOpenPageContext returns null without any DB
      // call; chatId present -> the existing-chat path.
      body: { chatId: 'chat1', messages: [] } as never,
      res: res as never,
      signal: new AbortController().signal,
      model: {} as never,
      role: null,
      write,
    };
  };

  it('throws A_RUN_BEGIN_FAILED (503) before the first byte and before persisting the user turn', async () => {
    const insertSpy = jest.fn();
    const svc = makeService(insertSpy);
    const { write, ...args } = baseArgs();

    const runHooks = {
      begin: jest.fn().mockRejectedValue(new Error('DB pool exhausted')),
    } as never;

    let caught: unknown;
    try {
      await svc.stream({ ...args, runHooks });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    const http = caught as ServiceUnavailableException;
    expect(http.getStatus()).toBe(503);
    expect(http.getResponse()).toMatchObject({ code: 'A_RUN_BEGIN_FAILED' });

    // Fail-fast: nothing was written to the socket and NO user message row was
    // persisted, so the turn left no orphan state to clean up.
    expect(write).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('still maps a lost-the-race RunAlreadyActiveError to a 409, not A_RUN_BEGIN_FAILED', async () => {
    const insertSpy = jest.fn();
    const svc = makeService(insertSpy);
    const { write, ...args } = baseArgs();

    const runHooks = {
      begin: jest.fn().mockRejectedValue(new RunAlreadyActiveError('chat1')),
    } as never;

    let caught: unknown;
    try {
      await svc.stream({ ...args, runHooks });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'A_RUN_ALREADY_ACTIVE',
    });
    expect(write).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
