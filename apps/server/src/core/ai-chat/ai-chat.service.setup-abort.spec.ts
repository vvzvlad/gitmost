import { Logger } from '@nestjs/common';

// Mock the AI SDK: the turn we drive is STOPPED during the pre-streamText setup
// phase, so no provider call must ever be made. convertToModelMessages is reached
// (before toolsFor) so it is stubbed to an empty transcript.
jest.mock('ai', () => ({
  streamText: jest.fn(),
  generateText: jest.fn(),
  convertToModelMessages: jest.fn(async () => []),
  stepCountIs: jest.fn(() => () => false),
}));

import { streamText } from 'ai';
import { AiChatService } from './ai-chat.service';

/**
 * D2 — an explicit Stop DURING the external-MCP toolset build (the pre-streamText
 * setup phase) must:
 *   (a) unwedge the turn (stream() rejects instead of hanging at step 0), and
 *   (b) finalize the run as 'aborted' via the outer catch's onSettled — never leak
 *       the run row as 'running' (which would 409 every later turn in this chat).
 *
 * The setup phase does NOT yet observe streamText's terminal callbacks, so before
 * the fix a hung `toolsFor` ignored the run's abort signal and never finalized.
 * `raceAgainstAbortAndTimeout(toolsFor, effectiveSignal, ...)` now rejects the
 * moment the run's signal aborts; the catch re-throws (signal aborted), and the
 * outer catch settles the run 'aborted'.
 */
describe('AiChatService.stream — abort during external-MCP setup finalizes the run (D2)', () => {
  const streamTextMock = streamText as unknown as jest.Mock;

  function makeService(mcpClients: { toolsFor: jest.Mock }) {
    const aiChatRepo = {
      findById: jest.fn(async () => ({ id: 'chat-1', workspaceId: 'ws-1' })),
      insert: jest.fn(),
    };
    const aiChatMessageRepo = {
      insert: jest.fn(async () => ({ id: 'msg-1' })),
      findAllByChat: jest.fn(async () => []),
      update: jest.fn(async () => ({ id: 'msg-1' })),
    };
    const aiSettings = { resolve: jest.fn(async () => ({})) };
    const tools = { forUser: jest.fn(async () => ({})) };
    const svc = new AiChatService(
      {} as never, // ai
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      aiSettings as never,
      tools as never,
      mcpClients as never,
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo (openPage undefined -> never touched)
      {} as never, // pageAccess
      { isAiChatDeferredToolsEnabled: () => false, isAiChatFinalStepLockdownEnabled: () => false, isAiChatViewImageEnabled: () => false } as never, // environment
    );
    return { svc, tools };
  }

  const body = {
    chatId: 'chat-1',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ],
  };

  // A minimal raw ServerResponse stand-in for the turns that PROCEED past setup
  // and reach streamText (the deadline + legacy paths). The setup-only abort test
  // never wires the stream, so it keeps using `{ raw: {} }`.
  function makeRawRes() {
    return {
      raw: {
        writeHead: jest.fn(function writeHead(this: unknown) {
          return this;
        }),
        write: jest.fn(),
        once: jest.fn(),
        flushHeaders: jest.fn(),
      },
    };
  }

  // A fake streamText result: the service only calls consumeStream() and
  // pipeUIMessageStreamToResponse() on it (both fire-and-forget). Its terminal
  // callbacks are never invoked, so the run is not finalized through them.
  function makeStreamResult() {
    return {
      consumeStream: jest.fn(),
      pipeUIMessageStreamToResponse: jest.fn(),
    };
  }

  beforeEach(() => {
    streamTextMock.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined as never);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as never);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('stops the hung toolset build, rejects, and settles the run "aborted" — never reaching streamText', async () => {
    const runController = new AbortController();
    // The build hangs (never resolves); the run is STOPPED mid-build. Aborting on a
    // macrotask exercises the abort-listener path (a real user Stop during setup).
    const toolsFor = jest.fn(() => {
      setTimeout(() => runController.abort(new Error('user stop')), 0);
      return new Promise(() => {}); // never settles — models a hung MCP build
    });
    const { svc } = makeService({ toolsFor });

    const onSettled = jest.fn();
    const begin = jest.fn(async () => ({
      runId: 'run-1',
      signal: runController.signal,
    }));

    const promise = svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: { raw: {} } as never,
      signal: new AbortController().signal, // socket signal (distinct from the run)
      model: {} as never,
      role: null,
      runHooks: {
        begin,
        onAssistantSeeded: jest.fn(),
        onStep: jest.fn(),
        onSettled,
      } as never,
    });

    // (a) The turn is UNWEDGED: it rejects (with the stop reason) instead of hanging.
    await expect(promise).rejects.toThrow('user stop');

    // (b) The run is finalized as 'aborted' with NO error message (a Stop, not a
    // failure) — so the run row never leaks 'running'.
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith('run-1', 'aborted', undefined);

    // The build was reached, but the provider call was NEVER made (stopped at setup).
    expect(toolsFor).toHaveBeenCalledTimes(1);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  // Item 1 — the onLateResolve leg of raceAgainstAbortAndTimeout. When `toolsFor`
  // loses the race (abort) but RESOLVES LATER with a leased toolset, the setup site
  // must release that abandoned toolset's leases (call close() on its client
  // handles) so their lease refcount is not pinned forever by a toolset nobody
  // consumes. Nothing else exercises this path.
  it('releases the leases of a toolset that resolves AFTER the race was already lost (onLateResolve)', async () => {
    const runController = new AbortController();
    // A controllable build: it hangs until we resolve it by hand, and the run is
    // stopped mid-build so the race rejects BEFORE the build settles.
    let resolveTools: (v: unknown) => void = () => undefined;
    const toolsForPromise = new Promise((resolve) => {
      resolveTools = resolve;
    });
    const toolsFor = jest.fn(() => {
      setTimeout(() => runController.abort(new Error('user stop')), 0);
      return toolsForPromise;
    });
    const { svc } = makeService({ toolsFor });

    const begin = jest.fn(async () => ({
      runId: 'run-1',
      signal: runController.signal,
    }));

    const promise = svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: { raw: {} } as never,
      signal: new AbortController().signal,
      model: {} as never,
      role: null,
      runHooks: {
        begin,
        onAssistantSeeded: jest.fn(),
        onStep: jest.fn(),
        onSettled: jest.fn(),
      } as never,
    });

    // The race is lost to the abort: the turn rejects with the stop reason.
    await expect(promise).rejects.toThrow('user stop');

    // NOW the abandoned build resolves late with a leased client. onLateResolve must
    // release it (call close on the lease handle).
    const close = jest.fn().mockResolvedValue(undefined);
    resolveTools({
      tools: {},
      clients: [{ close }],
      outcomes: [],
      instructions: [],
    });
    // Flush the microtasks so work.then -> onLateResolve -> Promise.all(close) runs.
    await new Promise((r) => setImmediate(r));

    expect(close).toHaveBeenCalledTimes(1);
  });

  // Item 2 — the PURE DEADLINE branch (MCP_TOOLSET_BUILD_DEADLINE_MS). `toolsFor`
  // never settles and the run's signal is NOT aborted: the race rejects with a
  // "setup timed out" error, the catch does NOT re-throw (runId set but signal not
  // aborted), and the turn PROCEEDS Docmost-only. It must reach streamText (the turn
  // continues, not wedged) and must NOT be finalized 'aborted'.
  it('proceeds Docmost-only (reaches streamText) when the build hits the deadline without an abort', async () => {
    jest.useFakeTimers();

    // The build hangs forever; the run's signal is never aborted.
    const toolsFor = jest.fn(() => new Promise(() => {}));
    const { svc } = makeService({ toolsFor });

    streamTextMock.mockReturnValue(makeStreamResult() as never);

    const onSettled = jest.fn();
    const runSignal = new AbortController().signal; // never aborts
    const begin = jest.fn(async () => ({ runId: 'run-1', signal: runSignal }));

    const promise = svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: makeRawRes() as never,
      signal: new AbortController().signal,
      model: {} as never,
      role: null,
      runHooks: {
        begin,
        onAssistantSeeded: jest.fn(),
        onStep: jest.fn(),
        onSettled,
      } as never,
    });

    // Advance past the 60s build deadline; advanceTimersByTimeAsync flushes the
    // promise microtasks between timer fires so the whole setup chain runs.
    await jest.advanceTimersByTimeAsync(60_001);
    // The turn does not throw out of setup — it continues to stream.
    await expect(promise).resolves.toBeUndefined();

    // The turn CONTINUED: streamText was reached (Docmost-only), not wedged.
    expect(toolsFor).toHaveBeenCalledTimes(1);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    // The run was NOT finalized as aborted (the deadline is not a Stop) — the setup
    // catch settle path never ran, so onSettled is left to streamText's callbacks.
    expect(onSettled).not.toHaveBeenCalled();
  });

  // Item 3 — the LEGACY no-runId path. The catch's re-throw is gated on
  // `runId && effectiveSignal.aborted`. With NO runId (no runHooks) an abort during
  // setup must NOT re-throw (runId falsy) — the turn warns + proceeds Docmost-only
  // and streams, and is never finalized 'aborted' via the re-throw. Locks the
  // `runId &&` half of the guard.
  it('does NOT re-throw on a setup abort when there is no runId (legacy path proceeds Docmost-only)', async () => {
    const socketController = new AbortController();
    // The build hangs; the SOCKET signal (legacy effectiveSignal) aborts mid-build.
    const toolsFor = jest.fn(() => {
      setTimeout(() => socketController.abort(new Error('socket closed')), 0);
      return new Promise(() => {});
    });
    const { svc } = makeService({ toolsFor });

    streamTextMock.mockReturnValue(makeStreamResult() as never);

    // No runHooks => runId undefined, effectiveSignal === the socket signal.
    const promise = svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: makeRawRes() as never,
      signal: socketController.signal,
      model: {} as never,
      role: null,
    });

    // The turn does NOT reject out of setup (no re-throw on the legacy path).
    await expect(promise).resolves.toBeUndefined();

    // It proceeded Docmost-only and reached streamText — streamText then observes
    // the already-aborted socket signal via its own abortSignal.
    expect(toolsFor).toHaveBeenCalledTimes(1);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });
});
