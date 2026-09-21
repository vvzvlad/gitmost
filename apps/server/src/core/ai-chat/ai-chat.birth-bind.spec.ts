import { ServiceUnavailableException } from '@nestjs/common';
import { AiChatService } from './ai-chat.service';
import * as metricsRegistry from '../../integrations/metrics/metrics.registry';

/**
 * #665 birth page-binding gate (acceptance criteria 11 & 12).
 *
 * The server is the BIRTH writer of the page->chat binding: right after the
 * FIRST persisted user message of a chat sent FROM a page, it upserts that
 * page's binding to point at the chat. The gate that decides "is this the
 * birth message?" is a FACT — `oldHistory.length === 0` (the history loaded
 * BEFORE the new row) — deliberately NOT `isNewChat`. That distinction is the
 * whole point of criteria 11/12 and is otherwise unprotected, so these tests
 * pin it down:
 *
 *  - Criterion 11: a chat with isNewChat === false (an existing row, e.g. an
 *    orphan created when a prior turn's runHooks.begin failed) but
 *    oldHistory.length === 0 MUST bind on its retry — to the VALIDATED
 *    openPageContext.id, never to ai_chats.page_id.
 *  - Criterion 12: when the chat "dies" before the user-message insert
 *    (runHooks.begin throws), execution never reaches the gate, so NO
 *    bind/unbind happens and any existing binding is untouched.
 *  - The bind is best-effort / fail-soft: a bind throw must not fail the user
 *    message or the turn.
 *
 * Non-vacuity: criterion 11 drives an existing chat (isNewChat === false).
 * Flipping the source gate back to `isNewChat` makes the gate false here, so
 * the upsert is not called and this suite goes RED — proven by hand.
 *
 * Method: drive the REAL stream() on a bare prototype instance (Object.create,
 * bypassing the heavy DI constructor) wired with only the collaborators reached
 * before/at the gate, and cut the turn off IMMEDIATELY after the gate by making
 * the next call — detectPageChange() — throw a sentinel. With no runHooks the
 * outer catch (runId undefined) just rethrows the sentinel, so the assertion is
 * on the REAL control flow through the gate, not a reimplementation of it.
 */
describe('AiChatService #665 birth page-binding gate (criteria 11 & 12)', () => {
  const SENTINEL = 'STOP_AFTER_BIRTH_BIND';
  const openPage = {
    id: 'pageX',
    title: 'X',
    updatedAt: new Date('2026-07-02T10:00:00Z'),
    selection: null,
  };

  function makeService(opts: {
    existingChat: unknown;
    oldHistory: unknown[];
    openPage: unknown;
    bindingRepo?: { upsert: jest.Mock; clear: jest.Mock };
  }) {
    const svc = Object.create(AiChatService.prototype) as any;
    svc.logger = {
      warn: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    svc.aiChatRepo = {
      findById: jest.fn().mockResolvedValue(opts.existingChat),
    };
    svc.aiChatMessageRepo = {
      findAllByChat: jest.fn().mockResolvedValue(opts.oldHistory),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    // Absent step repo -> skip the #492 hydration branch (degrades, no crash).
    svc.aiChatRunStepRepo = undefined;
    svc.aiChatPageBindingRepo = opts.bindingRepo;
    // reconcileChat is best-effort (its own try/catch) — stub to a no-op.
    svc.reconcileChat = jest.fn().mockResolvedValue(undefined);
    // openPageContext is resolved against the DB; override the (separately
    // unit-tested) validator so the gate sees a validated page or null.
    svc.resolveOpenPageContext = jest.fn().mockResolvedValue(opts.openPage);
    // Cut point: the first call AFTER the birth-bind gate. A rejection here
    // proves the turn reached (and passed) the gate.
    svc.detectPageChange = jest.fn().mockRejectedValue(new Error(SENTINEL));
    return svc as AiChatService;
  }

  const baseArgs = (overrides?: Record<string, unknown>) => ({
    user: { id: 'u1' } as never,
    workspace: { id: 'w1' } as never,
    sessionId: 's1',
    body: {
      chatId: 'chat1',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      openPage: { id: 'pageX' },
    } as never,
    res: {
      raw: { write: jest.fn(), writableEnded: false, headersSent: false },
    } as never,
    signal: new AbortController().signal,
    model: {} as never,
    role: null,
    ...overrides,
  });

  async function drive(svc: AiChatService, args: object): Promise<unknown> {
    let caught: unknown;
    try {
      await (svc as any).stream(args);
    } catch (e) {
      caught = e;
    }
    return caught;
  }

  // Criterion 11: retry of an ORPHANED (existing, empty) chat MUST bind.
  it('criterion 11: an existing chat (isNewChat=false) with empty history binds on retry — to openPageContext.id, NOT ai_chats.page_id', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const clear = jest.fn().mockResolvedValue(undefined);
    const svc = makeService({
      // isNewChat === false (findById returns a row). Its birth page_id is a
      // DIFFERENT page — the orphan was born on X but is being retried on pageX.
      existingChat: { id: 'chat1', pageId: 'pageBIRTH', metadata: null },
      oldHistory: [], // orphan: no persisted messages yet
      openPage,
      bindingRepo: { upsert, clear },
    });

    const caught = await drive(svc, baseArgs());

    // The turn ran past the gate (sentinel), i.e. the gate fired on isNewChat=false.
    expect((caught as Error).message).toBe(SENTINEL);
    // Bound EXACTLY ONCE, to the validated open page — never the birth page_id.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith('u1', 'pageX', 'chat1');
    expect(upsert).not.toHaveBeenCalledWith('u1', 'pageBIRTH', 'chat1');
    // Birth writer never clears.
    expect(clear).not.toHaveBeenCalled();
  });

  // Criterion 12: a stillborn chat (dies before the user-message insert) must
  // NOT touch the binding.
  it('criterion 12: runHooks.begin throwing kills the turn BEFORE the gate — no bind/unbind, existing binding untouched', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const clear = jest.fn().mockResolvedValue(undefined);
    const svc = makeService({
      existingChat: { id: 'chat1', pageId: 'pageBIRTH', metadata: null },
      oldHistory: [],
      openPage, // a page IS open — so if the gate were reached it WOULD bind
      bindingRepo: { upsert, clear },
    });
    const insert = (svc as any).aiChatMessageRepo.insert as jest.Mock;

    const runHooks = {
      begin: jest.fn().mockRejectedValue(new Error('DB pool exhausted')),
    } as never;

    const caught = await drive(svc, baseArgs({ runHooks }));

    // The turn 503s at begin, before the message insert and the gate.
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as ServiceUnavailableException).getStatus()).toBe(503);
    // No user row persisted, and the binding is never written OR cleared.
    expect(insert).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  // Fail-soft: a bind throw must not fail the user message / the turn.
  it('is fail-soft: an upsert throw is swallowed (turn continues past the gate), logged, and counted', async () => {
    const incSpy = jest
      .spyOn(metricsRegistry, 'incAiChatBindSkipped')
      .mockImplementation(() => undefined);
    const upsert = jest.fn().mockRejectedValue(new Error('unique violation'));
    const clear = jest.fn().mockResolvedValue(undefined);
    const svc = makeService({
      existingChat: { id: 'chat1', pageId: 'pageBIRTH', metadata: null },
      oldHistory: [],
      openPage,
      bindingRepo: { upsert, clear },
    });

    const caught = await drive(svc, baseArgs());

    // Execution reached the cut point AFTER the bind => the bind error was
    // swallowed and the turn was NOT failed by it.
    expect((caught as Error).message).toBe(SENTINEL);
    expect(upsert).toHaveBeenCalledTimes(1);
    // Observability: WARN with the reason + the skip counter incremented.
    const warn = (svc as any).logger.warn as jest.Mock;
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('birth_bind_failed'),
    );
    expect(incSpy).toHaveBeenCalledWith('birth_bind_failed');
    incSpy.mockRestore();
  });

  // Guards the "only the birth message binds" half of the FACT gate: a LATER
  // turn (oldHistory > 0) must never rebind, even on a page (criterion 6).
  it('a later turn (oldHistory.length > 0) does NOT rebind', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const clear = jest.fn().mockResolvedValue(undefined);
    const svc = makeService({
      existingChat: { id: 'chat1', pageId: 'pageBIRTH', metadata: null },
      oldHistory: [
        { id: 'm0', role: 'user', status: null, metadata: null },
      ],
      openPage,
      bindingRepo: { upsert, clear },
    });

    const caught = await drive(svc, baseArgs());

    expect((caught as Error).message).toBe(SENTINEL);
    expect(upsert).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  // Off a document (openPageContext === null) => no write, even on a birth msg.
  it('binds nothing when no page is open (openPageContext === null)', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const clear = jest.fn().mockResolvedValue(undefined);
    const svc = makeService({
      existingChat: { id: 'chat1', pageId: 'pageBIRTH', metadata: null },
      oldHistory: [],
      openPage: null, // resolveOpenPageContext returned null
      bindingRepo: { upsert, clear },
    });

    const caught = await drive(svc, baseArgs());

    expect((caught as Error).message).toBe(SENTINEL);
    expect(upsert).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});
