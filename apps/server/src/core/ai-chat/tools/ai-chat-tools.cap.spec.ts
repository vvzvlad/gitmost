import {
  wrapInAppToolWithCap,
  inAppToolCallCapMs,
  type ToolAbortSignalSink,
} from './ai-chat-tools.service';
import type { Tool, ToolCallOptions } from 'ai';

/**
 * #487 commit 1 — in-app tool race-on-abort + safe-points + per-call cap.
 *
 * Tests assert the HONEST observable property the spec names — "after Stop, NO
 * new HTTP/WS call STARTS; an already-started single call may take either
 * outcome" — against the REAL wrapper mechanism (the composite abort signal it
 * publishes on the client + the RACE it runs), NOT a timing-dependent proxy like
 * "the write didn't land".
 */

// A minimal stand-in for the client's `toolAbortSignal` field. In production the
// wrapper publishes the composite here and the client's paginateAll /
// mutatePageContent safe-points read it; the fake "tool" below reads it the same
// way, so this exercises the real contract without a live DB / collab socket.
class FakeClient implements ToolAbortSignalSink {
  private signal: AbortSignal | null = null;
  setToolAbortSignal(signal: AbortSignal | null): void {
    this.signal = signal;
  }
  getToolAbortSignal(): AbortSignal | null {
    return this.signal;
  }
}

// A ToolCallOptions with just the field the wrapper reads (abortSignal). The AI
// SDK passes a fuller object; the wrapper only spreads it and reads abortSignal.
const opts = (abortSignal?: AbortSignal): ToolCallOptions =>
  ({ toolCallId: 't1', messages: [], abortSignal }) as unknown as ToolCallOptions;

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('#487 wrapInAppToolWithCap — race-on-abort + safe-points', () => {
  it('after Stop, no NEW simulated call starts (multi-call tool)', async () => {
    const client = new FakeClient();
    const started: number[] = [];
    // A multi-call tool that mirrors paginateAll: it consults the client signal
    // at a safe-point BEFORE starting each simulated network call.
    const multiCall: Tool = {
      execute: (async (_args: unknown) => {
        for (let i = 0; i < 6; i++) {
          // Safe-point: exactly what paginateAll / mutatePageContent do.
          client.getToolAbortSignal()?.throwIfAborted();
          started.push(i);
          await tick(10);
        }
        return 'done';
      }) as unknown as Tool['execute'],
    } as Tool;

    const wrapped = wrapInAppToolWithCap(multiCall, client, 10_000);
    const ac = new AbortController();
    const call = (
      wrapped.execute as (a: unknown, o: ToolCallOptions) => Promise<unknown>
    )({}, opts(ac.signal));

    // Let one or two calls start, then Stop.
    await tick(12);
    ac.abort(new Error('user stop'));

    await expect(call).rejects.toThrow(); // wrapper rejects promptly
    const startedAtStop = started.length;

    // Give the abandoned loser ample time; its next safe-point must throw because
    // the (aborted) composite is still published on the client.
    await tick(60);
    expect(started.length).toBe(startedAtStop);
    // It must NOT have run the whole sequence (that would mean Stop did nothing).
    expect(started.length).toBeLessThan(6);
  });

  it('rejects immediately on Stop even if the call never settles (discard loser)', async () => {
    const client = new FakeClient();
    let settled = false;
    const hang: Tool = {
      execute: (async () => {
        await new Promise(() => undefined); // never resolves
        settled = true;
      }) as unknown as Tool['execute'],
    } as Tool;
    const wrapped = wrapInAppToolWithCap(hang, client, 10_000);
    const ac = new AbortController();
    const call = (
      wrapped.execute as (a: unknown, o: ToolCallOptions) => Promise<unknown>
    )({}, opts(ac.signal));
    await tick(5);
    ac.abort();
    await expect(call).rejects.toThrow();
    expect(settled).toBe(false);
  });

  it('per-call cap rejects a hung call with no Stop signal', async () => {
    const client = new FakeClient();
    const hang: Tool = {
      execute: (async () => {
        await new Promise(() => undefined);
      }) as unknown as Tool['execute'],
    } as Tool;
    // Tiny cap; no options.abortSignal at all (composite = cap only).
    const wrapped = wrapInAppToolWithCap(hang, client, 20);
    const start = Date.now();
    await expect(
      (wrapped.execute as (a: unknown, o: ToolCallOptions) => Promise<unknown>)(
        {},
        opts(undefined),
      ),
    ).rejects.toThrow(/per-call cap/);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('publishes a composite signal on the client for the duration of the call', async () => {
    const client = new FakeClient();
    let seenDuringCall: AbortSignal | null = null;
    const probe: Tool = {
      execute: (async () => {
        seenDuringCall = client.getToolAbortSignal();
        return 'ok';
      }) as unknown as Tool['execute'],
    } as Tool;
    const wrapped = wrapInAppToolWithCap(probe, client, 10_000);
    const ac = new AbortController();
    await (
      wrapped.execute as (a: unknown, o: ToolCallOptions) => Promise<unknown>
    )({}, opts(ac.signal));
    expect(seenDuringCall).not.toBeNull();
    // The published composite must reflect the turn's Stop signal.
    ac.abort();
    expect((seenDuringCall as unknown as AbortSignal).aborted).toBe(true);
  });

  it('a completed call returns its raw result unchanged', async () => {
    const client = new FakeClient();
    const ok: Tool = {
      execute: (async () => ({ items: [1, 2, 3] })) as unknown as Tool['execute'],
    } as Tool;
    const wrapped = wrapInAppToolWithCap(ok, client, 10_000);
    const res = await (
      wrapped.execute as (a: unknown, o: ToolCallOptions) => Promise<unknown>
    )({}, opts(new AbortController().signal));
    expect(res).toEqual({ items: [1, 2, 3] });
  });

  it('cap is env-tunable with a 2-minute default', () => {
    const prev = process.env.AI_CHAT_INAPP_TOOL_CALL_CAP_MS;
    delete process.env.AI_CHAT_INAPP_TOOL_CALL_CAP_MS;
    expect(inAppToolCallCapMs()).toBe(120_000);
    process.env.AI_CHAT_INAPP_TOOL_CALL_CAP_MS = '5000';
    expect(inAppToolCallCapMs()).toBe(5000);
    process.env.AI_CHAT_INAPP_TOOL_CALL_CAP_MS = 'not-a-number';
    expect(inAppToolCallCapMs()).toBe(120_000);
    if (prev === undefined) delete process.env.AI_CHAT_INAPP_TOOL_CALL_CAP_MS;
    else process.env.AI_CHAT_INAPP_TOOL_CALL_CAP_MS = prev;
  });
});
