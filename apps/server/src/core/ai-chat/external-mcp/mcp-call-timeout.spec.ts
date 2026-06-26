import { type Tool, type ToolCallOptions } from 'ai';
import {
  wrapToolWithCallTimeout,
  wrapToolsWithCallTimeout,
} from './mcp-clients.service';
import {
  mcpStreamTimeoutMs,
  mcpCallTimeoutMs,
} from '../../../integrations/ai/ai-streaming-fetch';

/**
 * Per-call total-timeout guard for external MCP tools (mcp-clients.service).
 *
 * `@ai-sdk/mcp`'s tool execute has NO built-in per-call timeout — a tool that
 * keeps the connection warm but never returns is otherwise unbounded. The
 * wrapper attaches a fresh AbortController + timer per CALL and composes it with
 * the turn's abortSignal via AbortSignal.any, so EITHER the per-call timeout OR a
 * client disconnect aborts the in-flight call.
 *
 * Fake timers prove the timeout fires WITHOUT real waiting; no leaked timer keeps
 * the process alive after a fast resolve.
 */
const CALL_TIMEOUT_MS = 900_000;

/** Build a Tool around an `execute` impl, mirroring the SDK's minimal shape. */
function toolWith(
  execute: (args: unknown, options: ToolCallOptions) => unknown,
): Tool {
  return { description: 'x', inputSchema: undefined, execute } as unknown as Tool;
}

/** Invoke a (possibly wrapped) tool's execute with an optional turn signal. */
function callExecute(
  tool: Tool,
  args: unknown,
  abortSignal?: AbortSignal,
): unknown {
  const execute = tool.execute as (
    args: unknown,
    options: ToolCallOptions,
  ) => unknown;
  return execute(args, { abortSignal } as ToolCallOptions);
}

describe('wrapToolWithCallTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('aborts a tool that only rejects when its abortSignal fires, after ms elapses', async () => {
    // The tool resolves NEVER on its own — it only settles when the abortSignal
    // it is handed aborts. So a resolution proves the per-call timer fired and
    // aborted the call (not the tool finishing by itself).
    let received: AbortSignal | undefined;
    const tool = toolWith((_args, options) => {
      received = options.abortSignal;
      return new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => {
          reject(options.abortSignal?.reason ?? new Error('aborted'));
        });
      });
    });

    const wrapped = wrapToolWithCallTimeout(tool, CALL_TIMEOUT_MS);
    const promise = callExecute(wrapped, { q: 'x' }) as Promise<unknown>;
    // Attach the rejection handler synchronously so advancing timers cannot mark
    // it an unhandled rejection.
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );

    // Nothing fired yet.
    jest.advanceTimersByTime(CALL_TIMEOUT_MS - 1);
    // Past the cap -> the per-call timer aborts the composed signal.
    jest.advanceTimersByTime(2);

    const result = await settled;
    expect(result.ok).toBe(false);
    expect(received).toBeInstanceOf(AbortSignal);
    // The abort reason / rejection mentions the timeout.
    const message =
      (result as { err: unknown }).err instanceof Error
        ? ((result as { err: Error }).err.message)
        : String((result as { err: unknown }).err);
    expect(message).toMatch(/timed out after 900000ms/);
  });

  it('aborts a REAL-client-style tool that never settles and ignores abort (race fix)', async () => {
    // Models the ACTUAL @ai-sdk/mcp semantics: its in-flight promise does NOT
    // reject on abort (it only checks the signal when a response arrives), so a
    // warm-but-stuck call NEVER settles on its own and does NOT listen to the
    // abort signal. The wrapper must still reject after `ms` via the race — an
    // implementation that merely `await original(...)` would hang here forever.
    // This test FAILS against the old await-only code and PASSES with the race.
    const tool = toolWith(() => new Promise(() => {})); // never settles, no abort
    const wrapped = wrapToolWithCallTimeout(tool, CALL_TIMEOUT_MS);
    const promise = callExecute(wrapped, { q: 'x' }) as Promise<unknown>;
    // Assert the rejection without hanging: drive fake time async so the timer's
    // abort -> race rejection microtasks flush, then await the rejection.
    const expectation = expect(promise).rejects.toThrow(/timed out after 900000ms/);
    await jest.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + 1);
    await expectation;
  });

  it('passes a fast tool through and leaks no timer (advancing later does not throw)', async () => {
    const tool = toolWith(() => Promise.resolve('fast-result'));
    const wrapped = wrapToolWithCallTimeout(tool, CALL_TIMEOUT_MS);

    const value = await (callExecute(wrapped, {}) as Promise<unknown>);
    expect(value).toBe('fast-result');

    // The timer was cleared in the finally — advancing past the cap aborts
    // nothing and throws nothing.
    expect(() => jest.advanceTimersByTime(CALL_TIMEOUT_MS * 2)).not.toThrow();
  });

  it('aborts when the caller turn signal aborts before the timeout (disconnect path)', async () => {
    // Real-client semantics: the tool never settles and does NOT listen to abort,
    // so the wrapper must reject via the race when the caller's turn signal (a
    // client disconnect) aborts BEFORE the per-call cap. The race propagates the
    // caller's abort reason.
    const tool = toolWith(() => new Promise(() => {})); // never settles, no abort
    const wrapped = wrapToolWithCallTimeout(tool, CALL_TIMEOUT_MS);
    const turn = new AbortController();
    const promise = callExecute(wrapped, {}, turn.signal) as Promise<unknown>;
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );

    // Disconnect well before the cap; the per-call timer never fires here.
    turn.abort(new Error('client disconnected'));
    const result = await settled;
    expect(result.ok).toBe(false);
    const message =
      (result as { err: unknown }).err instanceof Error
        ? (result as { err: Error }).err.message
        : String((result as { err: unknown }).err);
    // The caller's abort reason propagates through the race.
    expect(message).toMatch(/client disconnected/);
  });

  it('passes a tool with no execute through unchanged', () => {
    const noExecute = { description: 'x', inputSchema: undefined } as unknown as Tool;
    const wrapped = wrapToolWithCallTimeout(noExecute, CALL_TIMEOUT_MS);
    // Same object back, execute still absent.
    expect(wrapped).toBe(noExecute);
    expect((wrapped as { execute?: unknown }).execute).toBeUndefined();
  });
});

describe('wrapToolsWithCallTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('wraps every tool in the map (each call gets its own guard)', async () => {
    const tools: Record<string, Tool> = {
      a: toolWith(() => Promise.resolve('A')),
      b: toolWith(() => Promise.resolve('B')),
    };
    const out = wrapToolsWithCallTimeout(tools, CALL_TIMEOUT_MS);
    expect(Object.keys(out)).toEqual(['a', 'b']);
    expect(await (callExecute(out.a, {}) as Promise<unknown>)).toBe('A');
    expect(await (callExecute(out.b, {}) as Promise<unknown>)).toBe('B');
  });
});

describe('mcp timeout env helpers', () => {
  const ORIG_SILENCE = process.env.AI_MCP_STREAM_TIMEOUT_MS;
  const ORIG_CALL = process.env.AI_MCP_CALL_TIMEOUT_MS;
  afterEach(() => {
    if (ORIG_SILENCE === undefined) delete process.env.AI_MCP_STREAM_TIMEOUT_MS;
    else process.env.AI_MCP_STREAM_TIMEOUT_MS = ORIG_SILENCE;
    if (ORIG_CALL === undefined) delete process.env.AI_MCP_CALL_TIMEOUT_MS;
    else process.env.AI_MCP_CALL_TIMEOUT_MS = ORIG_CALL;
  });

  it('mcpStreamTimeoutMs defaults to 5 min and honors a positive override', () => {
    delete process.env.AI_MCP_STREAM_TIMEOUT_MS;
    expect(mcpStreamTimeoutMs()).toBe(300_000);
    process.env.AI_MCP_STREAM_TIMEOUT_MS = '60000';
    expect(mcpStreamTimeoutMs()).toBe(60_000);
    for (const bad of ['0', '-1', 'x', '']) {
      process.env.AI_MCP_STREAM_TIMEOUT_MS = bad;
      expect(mcpStreamTimeoutMs()).toBe(300_000);
    }
  });

  it('mcpCallTimeoutMs defaults to 15 min and honors a positive override', () => {
    delete process.env.AI_MCP_CALL_TIMEOUT_MS;
    expect(mcpCallTimeoutMs()).toBe(900_000);
    process.env.AI_MCP_CALL_TIMEOUT_MS = '120000';
    expect(mcpCallTimeoutMs()).toBe(120_000);
    for (const bad of ['0', '-1', 'x', '']) {
      process.env.AI_MCP_CALL_TIMEOUT_MS = bad;
      expect(mcpCallTimeoutMs()).toBe(900_000);
    }
  });
});
