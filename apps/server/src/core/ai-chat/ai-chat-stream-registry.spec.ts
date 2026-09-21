import {
  AiChatStreamRegistryService,
  AI_CHAT_RUN_STREAM_MAX_BUFFER_BYTES,
  RUN_STREAM_RETAIN_FINISHED_MS,
  FINISH_STEP_FRAME_PREFIX,
  RunStreamCallbacks,
} from './ai-chat-stream-registry.service';
import { streamText, JsonToSseTransformStream } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

/**
 * Unit tests for the in-memory run-stream registry (#184 phase 1.5, step-aligned
 * retention #491). The registry is the whole of the resumable-transport contract:
 * step-stamped retention, tail-only attach at the client's frontier N, the
 * confirmed-persist ring rotation (and the anti-inversion rule), the memory bound,
 * the overflow gap, paused -> live hand-off, retention, the anchor check
 * (invariant 6), and the mirror-the-done-path replace semantics (invariant 3).
 */

// Real ai@6 UI-message-stream SSE frames are `data: {json}\n\n`, one part each.
const sse = (part: Record<string, unknown>): string =>
  `data: ${JSON.stringify(part)}\n\n`;
const finishStep = (): string => sse({ type: 'finish-step' });
const textDelta = (id: string, delta: string): string =>
  sse({ type: 'text-delta', id, delta });
const finish = (): string => sse({ type: 'finish' });

// A ReadableStream whose frames the test pushes explicitly, plus close/error.
function makePushStream(): {
  stream: ReadableStream<string>;
  push: (f: string) => void;
  close: () => void;
  error: (e?: unknown) => void;
} {
  let controller!: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (f) => controller.enqueue(f),
    close: () => controller.close(),
    error: (e) => controller.error(e ?? new Error('read error')),
  };
}

// Let the fire-and-forget pump drain queued frames (reader.read() resolves on a
// macrotask boundary for an already-enqueued value).
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function collector(): {
  cb: RunStreamCallbacks;
  frames: string[];
  ended: () => number;
} {
  const frames: string[] = [];
  let ends = 0;
  return {
    frames,
    ended: () => ends,
    cb: {
      onFrame: (f) => frames.push(f),
      onEnd: () => {
        ends += 1;
      },
    },
  };
}

// The tail past the synthetic start frame (replay[0] is always the start frame).
const tail = (replay: string[]): string[] => replay.slice(1);

describe('AiChatStreamRegistryService', () => {
  const CHAT = 'chat-1';
  let registry: AiChatStreamRegistryService;

  beforeEach(() => {
    registry = new AiChatStreamRegistryService();
    jest.spyOn((registry as any).logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    registry.onModuleDestroy();
  });

  it('prepends a synthetic start frame carrying { runId, chatId }', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    await flush();

    const c = collector();
    const att = (await registry.attach(CHAT, 'assist-1', 0, c.cb))!;
    const start = JSON.parse(att.replay[0].replace(/^data: /, '').trim());
    expect(start.type).toBe('start');
    expect(start.messageMetadata).toEqual({ runId: 'run-1', chatId: CHAT });
  });

  it('replays the buffered tail (from frontier 0) in arrival order (live attach)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    src.push('b');
    src.push('c');
    await flush();

    const c = collector();
    const att = await registry.attach(CHAT, 'assist-1', 0, c.cb);
    expect(att).not.toBeNull();
    expect(tail(att!.replay)).toEqual(['a', 'b', 'c']);
    expect(att!.finished).toBe(false);
  });

  it('late attach gets the buffered prefix as tail plus the live tail', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    src.push('b');
    await flush();

    const c = collector();
    const att = (await registry.attach(CHAT, 'assist-1', 0, c.cb))!;
    expect(tail(att.replay)).toEqual(['a', 'b']);
    att.start();
    src.push('c');
    src.push('d');
    await flush();
    expect(c.frames).toEqual(['c', 'd']);
  });

  it('a paused subscriber receives frames buffered during pause in order, then live', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    await flush();

    const c = collector();
    const att = (await registry.attach(CHAT, 'assist-1', 0, c.cb))!;
    expect(tail(att.replay)).toEqual(['a']);
    src.push('b'); // arrives while paused -> pending
    src.push('c');
    await flush();
    expect(c.frames).toEqual([]); // nothing delivered yet (paused)
    att.start();
    expect(c.frames).toEqual(['b', 'c']);
    src.push('d');
    await flush();
    expect(c.frames).toEqual(['b', 'c', 'd']);
  });

  it('a run that finishes while a subscriber is paused ends it on start()', async () => {
    registry.open(CHAT, 'run-1');
    registry.bind(CHAT, 'run-1', 'assist-1', makePushStream().stream);
    const c = collector();
    const att = (await registry.attach(CHAT, 'assist-1', 0, c.cb))!;
    registry.abortEntry(CHAT, 'run-1');
    expect(c.ended()).toBe(0); // paused: not ended yet
    att.start();
    expect(c.ended()).toBe(1); // start() drains + ends
  });

  it('anchor mismatch returns null (and null before bind sets assistantMessageId)', async () => {
    registry.open(CHAT, 'run-1');
    const c = collector();
    // Before bind: assistantMessageId is undefined -> mismatches any anchor.
    expect(await registry.attach(CHAT, 'assist-1', 0, c.cb)).toBeNull();

    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    await flush();
    // Wrong anchor -> null (cross-run replay forbidden, invariant 6).
    expect(await registry.attach(CHAT, 'other-id', 0, c.cb)).toBeNull();
  });

  it('matching anchor attaches', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    await flush();

    const c = collector();
    const att = await registry.attach(CHAT, 'assist-1', 0, c.cb);
    expect(att).not.toBeNull();
    expect(tail(att!.replay)).toEqual(['a']);
  });

  it('a throwing onFrame ejects only that subscriber; the ingest loop stays alive', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);

    const bad = collector();
    const badAtt = (await registry.attach(CHAT, 'assist-1', 0, {
      onFrame: () => {
        throw new Error('boom');
      },
      onEnd: bad.cb.onEnd,
    }))!;
    badAtt.start();

    const good = collector();
    const goodAtt = (await registry.attach(CHAT, 'assist-1', 0, good.cb))!;
    goodAtt.start();

    src.push('a'); // bad throws on this frame -> ejected
    src.push('b'); // good still receives both
    await flush();

    const entry = (registry as any).entries.get(CHAT);
    expect(entry.subscribers.size).toBe(1);
    expect(good.frames).toEqual(['a', 'b']);
  });

  it('open() over a LIVE entry ends started subscribers once; a late done never touches the new entry (invariant 3)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    await flush();

    const c = collector();
    const att = (await registry.attach(CHAT, 'assist-1', 0, c.cb))!;
    att.start();

    registry.open(CHAT, 'run-2');
    expect(c.ended()).toBe(1);

    const newEntry = (registry as any).entries.get(CHAT);
    expect(newEntry.runId).toBe('run-2');
    expect(newEntry.finished).toBe(false);

    src.push('b');
    src.close();
    await flush();
    expect(c.ended()).toBe(1);
    const still = (registry as any).entries.get(CHAT);
    expect(still).toBe(newEntry);
    expect(still.runId).toBe('run-2');
  });

  it('bind with a foreign runId is a no-op (invariant 1)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'WRONG-run', 'assist-x', src.stream);
    src.push('a');
    await flush();
    const entry = (registry as any).entries.get(CHAT);
    expect(entry.frames).toEqual([]);
    expect(entry.assistantMessageId).toBeUndefined();
  });

  it('abortEntry with a foreign runId is a no-op (invariant 1)', async () => {
    registry.open(CHAT, 'run-1');
    registry.abortEntry(CHAT, 'WRONG-run');
    const entry = (registry as any).entries.get(CHAT);
    expect(entry.finished).toBe(false);
  });
});

/**
 * #491 step-stamped retention: the boundary detector, tail-only slicing at the
 * client's frontier N, the confirmed-persist rotation (+ anti-inversion), the
 * overflow gap, the memory bound, and the finished-retained tail. All observable
 * against the REAL registry driven through open/bind/ingest.
 */
describe('AiChatStreamRegistryService step-aligned retention (#491)', () => {
  const CHAT = 'chat-s';
  let registry: AiChatStreamRegistryService;

  beforeEach(() => {
    registry = new AiChatStreamRegistryService();
    jest.spyOn((registry as any).logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => registry.onModuleDestroy());

  const entryOf = () => (registry as any).entries.get(CHAT);

  it('stamps frames by finish-step count, aligned with stepsPersisted', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    // step 0 content, its finish-step, step 1 content, its finish-step, finish.
    src.push(textDelta('t0', 'a')); // stamp 0
    src.push(finishStep()); // stamp 0 (the finish-step frame carries the pre value)
    src.push(textDelta('t1', 'b')); // stamp 1
    src.push(finishStep()); // stamp 1
    src.push(finish()); // stamp 2
    await flush();
    const e = entryOf();
    expect(e.stamps).toEqual([0, 0, 1, 1, 2]);
    expect(e.currentStamp).toBe(2);
  });

  it('does NOT treat a text delta that merely quotes "finish-step" as a boundary', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    // A model that literally types "type":"finish-step" — JSON-escaped in the frame.
    src.push(textDelta('t0', '"type":"finish-step"'));
    await flush();
    expect(entryOf().currentStamp).toBe(0); // no false boundary
  });

  it('tail-only: attach at N slices frames with stamp >= N', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push(textDelta('t0', 'a')); // 0
    src.push(finishStep()); // 0
    src.push(textDelta('t1', 'b')); // 1
    src.push(finishStep()); // 1
    src.push(textDelta('t2', 'c')); // 2 (in-progress)
    await flush();

    const c = collector();
    // Client persisted 2 steps -> wants the tail from step 2.
    const att = (await registry.attach(CHAT, 'assist-1', 2, c.cb))!;
    expect(tail(att.replay)).toEqual([textDelta('t2', 'c')]);
  });

  it('attach in the MIDDLE of a step (N between finish-steps) slices from that step', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push(textDelta('t0', 'a')); // 0
    src.push(finishStep()); // 0
    src.push(textDelta('t1', 'b1')); // 1
    src.push(textDelta('t1', 'b2')); // 1 (still step 1, no finish-step yet)
    await flush();

    const c = collector();
    const att = (await registry.attach(CHAT, 'assist-1', 1, c.cb))!;
    // Step 0's frames are dropped from the tail; the whole in-progress step 1 is kept.
    expect(tail(att.replay)).toEqual([textDelta('t1', 'b1'), textDelta('t1', 'b2')]);
  });

  it('rotates the ring ONLY on a confirmed persist (drops stamp < N)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push(textDelta('t0', 'a')); // 0
    src.push(finishStep()); // 0
    src.push(textDelta('t1', 'b')); // 1
    await flush();
    expect(entryOf().stamps).toEqual([0, 0, 1]);

    // Confirm step 0 persisted (stepsPersisted = 1) -> drop stamp < 1.
    registry.confirmPersistedStep(CHAT, 'run-1', 1);
    expect(entryOf().stamps).toEqual([1]);
    expect(entryOf().persistedFloor).toBe(1);
  });

  it('persist FAILED but the ring still fits -> attach SUCCEEDS and the tail includes step N', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push(textDelta('t0', 'a')); // 0
    src.push(finishStep()); // 0
    src.push(textDelta('t1', 'b')); // 1 (step 1's persist FAILED -> no confirm)
    await flush();
    // No confirmPersistedStep for step 1: the ring still holds step 1.

    const c = collector();
    // Client's last successful persist was step 0 -> stepsPersisted = 1.
    const att = await registry.attach(CHAT, 'assist-1', 1, c.cb);
    expect(att).not.toBeNull();
    expect(tail(att!.replay)).toEqual([textDelta('t1', 'b')]); // includes step 1
  });

  it('persist failed AND the ring overflowed past N -> 204 (coverage gap)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    // Step 0: a fat step that blows past the cap with NO persist confirmation.
    const big = 'x'.repeat(Math.floor(AI_CHAT_RUN_STREAM_MAX_BUFFER_BYTES / 2));
    src.push(textDelta('t0', big)); // 0
    src.push(textDelta('t0', big)); // 0
    src.push(textDelta('t0', big)); // 0 -> overflow evicts stamp-0 frames
    await flush();
    const e = entryOf();
    expect(e.overflowed).toBe(true);
    expect(e.bytes).toBeLessThanOrEqual(registry.maxBufferBytes);

    // A client at frontier 0 falls at/below an evicted step -> gap -> null.
    const c = collector();
    expect(await registry.attach(CHAT, 'assist-1', 0, c.cb)).toBeNull();
  });

  it('stale N (client seed lagged behind a rotation) -> 204; after a refetch (larger N) -> success', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push(textDelta('t0', 'a')); // 0
    src.push(finishStep()); // 0
    src.push(textDelta('t1', 'b')); // 1
    src.push(finishStep()); // 1
    src.push(textDelta('t2', 'c')); // 2
    await flush();
    // Server confirmed steps 0 and 1 -> rotate away stamp < 2.
    registry.confirmPersistedStep(CHAT, 'run-1', 2);
    expect(entryOf().stamps).toEqual([2]);

    // A client whose seed still says stepsPersisted = 1 -> below minStamp -> 204.
    const stale = collector();
    expect(await registry.attach(CHAT, 'assist-1', 1, stale.cb)).toBeNull();

    // It refetches (now stepsPersisted = 2) and re-attaches -> success.
    const fresh = collector();
    const att = await registry.attach(CHAT, 'assist-1', 2, fresh.cb);
    expect(att).not.toBeNull();
    expect(tail(att!.replay)).toEqual([textDelta('t2', 'c')]);
  });

  it('overflow gap CLEARS once a later persist rotates out the holey steps', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    const big = 'x'.repeat(Math.floor(AI_CHAT_RUN_STREAM_MAX_BUFFER_BYTES / 2));
    src.push(textDelta('t0', big)); // 0
    src.push(textDelta('t0', big)); // 0
    src.push(finishStep()); // 0 (still stamp 0)
    src.push(textDelta('t1', 'small')); // 1
    src.push(finishStep()); // 1
    src.push(textDelta('t2', 'c')); // 2
    await flush();
    expect(entryOf().overflowed).toBe(true);

    // Late persist confirms steps 0..1 -> rotates out the holey step-0 frames.
    registry.confirmPersistedStep(CHAT, 'run-1', 2);
    // A client at frontier 2 is now cleanly covered (the hole was below it).
    const c = collector();
    const att = await registry.attach(CHAT, 'assist-1', 2, c.cb);
    expect(att).not.toBeNull();
    expect(tail(att!.replay)).toEqual([textDelta('t2', 'c')]);
  });

  it('finished-retained + N = N_final -> empty tail plus the finish frame', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push(textDelta('t0', 'a')); // 0
    src.push(finishStep()); // 0
    src.push(finish()); // 1  (N_final = 1)
    src.close();
    await flush();
    // The last step's per-step persist confirmed stepsPersisted = 1.
    registry.confirmPersistedStep(CHAT, 'run-1', 1);

    const c = collector();
    const att = (await registry.attach(CHAT, 'assist-1', 1, c.cb))!;
    expect(att.finished).toBe(true);
    // Empty step tail; just the finish frame so the client's SDK closes the stream.
    expect(tail(att.replay)).toEqual([finish()]);
    // No subscriber registered for a finished run.
    expect(entryOf().subscribers.size).toBe(0);
  });

  it('#491 regression (#137/#161 dup): a PARAMETERLESS attach (n=null) to a finished NON-rotated run -> 204, but n=0 still gets the tail', async () => {
    // A finished, non-rotated run: frames present, coverageFloor 0. A missing `n`
    // (null — a legacy/parameterless tab that never stripped its transcript) must
    // 204 -> poll, NOT receive the whole tail it would append (duplicate). A
    // tail-aware client (n=0 present) still resumes.
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push(textDelta('t0', 'a')); // 0
    src.push(finishStep()); // 0
    src.push(finish()); // 1
    src.close();
    await flush();
    // NOT rotated (no confirmPersistedStep) -> stamps[0]=0, coverageFloor=0.
    // MUTATION-VERIFY: revert the `finished && n === null -> null` gate (default n
    // to 0) and the parameterless attach below serves the full tail instead of 204.
    expect(await registry.attach(CHAT, 'assist-1', null, collector().cb)).toBeNull();
    // A tail-aware client at frontier 0 IS served (the distinction: null != 0).
    const tailAware = await registry.attach(CHAT, 'assist-1', 0, collector().cb);
    expect(tailAware).not.toBeNull();
    expect(tailAware!.finished).toBe(true);
  });

  it('confirmPersistedStep is monotonic and identity-checked', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push(textDelta('t0', 'a'));
    src.push(finishStep());
    src.push(textDelta('t1', 'b'));
    await flush();
    registry.confirmPersistedStep(CHAT, 'run-1', 1);
    expect(entryOf().persistedFloor).toBe(1);
    // A stale lower count is ignored.
    registry.confirmPersistedStep(CHAT, 'run-1', 0);
    expect(entryOf().persistedFloor).toBe(1);
    // A foreign runId is ignored.
    registry.confirmPersistedStep(CHAT, 'WRONG', 5);
    expect(entryOf().persistedFloor).toBe(1);
  });

  it('MEMORY BOUND: 5 parallel marathon runs each stream well past 32MB; each ring stays <= the cap', async () => {
    const cap = registry.maxBufferBytes;
    const chats = ['m0', 'm1', 'm2', 'm3', 'm4'];
    const srcs = chats.map((chat) => {
      registry.open(chat, `run-${chat}`);
      const s = makePushStream();
      registry.bind(chat, `run-${chat}`, `assist-${chat}`, s.stream);
      return s;
    });
    // ~256KB frames; 160 per chat = 40MB streamed each, well past the old 32MB.
    // Interleave a finish-step every 8 frames so steps advance realistically. No
    // persist confirmation -> the ONLY thing keeping memory bounded is the cap.
    const frame = 'y'.repeat(256 * 1024);
    for (let batch = 0; batch < 20; batch++) {
      for (let i = 0; i < 8; i++) {
        for (const s of srcs) s.push(textDelta('t', frame));
      }
      for (const s of srcs) s.push(finishStep());
      await flush(); // drain the pump so queues never hold a whole run
    }
    let total = 0;
    for (const chat of chats) {
      const e = (registry as any).entries.get(chat);
      expect(e.bytes).toBeLessThanOrEqual(cap);
      total += e.bytes;
    }
    // Total retained across all 5 runs is bounded by 5x the per-run cap — the old
    // registry would have retained ~5x40MB = 200MB here.
    expect(total).toBeLessThanOrEqual(cap * chats.length);
  });
});

/**
 * Retention + replace timer behavior. Fake timers, and entries are finalized via
 * the synchronous abortEntry() path so no stream pump / microtask juggling is
 * needed.
 */
describe('AiChatStreamRegistryService retention timers', () => {
  const CHAT = 'chat-r';
  let registry: AiChatStreamRegistryService;

  beforeEach(() => {
    jest.useFakeTimers();
    registry = new AiChatStreamRegistryService();
    jest.spyOn((registry as any).logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    registry.onModuleDestroy();
    jest.useRealTimers();
  });

  it('a finished entry is removed after the retention window', () => {
    registry.open(CHAT, 'run-1');
    registry.abortEntry(CHAT, 'run-1');
    expect((registry as any).entries.get(CHAT)).toBeDefined();
    jest.advanceTimersByTime(RUN_STREAM_RETAIN_FINISHED_MS + 1);
    expect((registry as any).entries.get(CHAT)).toBeUndefined();
  });

  it('retention deletes ONLY its own entry (invariant 2)', () => {
    registry.open(CHAT, 'run-1');
    registry.abortEntry(CHAT, 'run-1');
    const sentinel = { marker: true };
    (registry as any).entries.set(CHAT, sentinel);
    jest.advanceTimersByTime(RUN_STREAM_RETAIN_FINISHED_MS + 1);
    expect((registry as any).entries.get(CHAT)).toBe(sentinel);
  });

  it('open() over a retained entry clears its timer and the successor survives', () => {
    registry.open(CHAT, 'run-1');
    registry.abortEntry(CHAT, 'run-1');
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    registry.open(CHAT, 'run-2');
    expect(clearSpy).toHaveBeenCalled();
    jest.advanceTimersByTime(RUN_STREAM_RETAIN_FINISHED_MS + 1);
    const entry = (registry as any).entries.get(CHAT);
    expect(entry).toBeDefined();
    expect(entry.runId).toBe('run-2');
  });
});

/**
 * #555 item 3 — CANARY for the `finish-step` SSE framing the registry depends on.
 *
 * The registry stamps each buffered frame by counting `finish-step` boundaries via
 * a cheap PREFIX match (`FINISH_STEP_FRAME_PREFIX = 'data: {"type":"finish-step"'`),
 * deliberately avoiding a JSON.parse per frame. That prefix is pinned to the wire
 * shape ai@6.0.207 emits: every UI-message-stream part is a single
 * `data: {json}\n\n` SSE event (never split across `data:` lines) and `type` is the
 * FIRST key. If a future `ai` SDK bump changes that framing — renames the part,
 * reorders keys so `type` is no longer first, or reshapes the SSE envelope — the
 * prefix silently stops matching: steps never advance, and the resumable transport
 * degrades to the 204/poll fallback WITHOUT any test failing. This canary drives a
 * REAL streamText through the SDK's own UI-message-stream -> SSE serializer and
 * asserts the finish-step boundary still matches the exact prefix the code keys on,
 * so such a bump FAILS LOUDLY here instead of degrading in production.
 */
describe('finish-step framing canary (#555 item 3 — detects ai-SDK framing drift)', () => {
  // Collect every SSE frame the SDK emits for a one-step text generation, using the
  // SAME path production uses (toUIMessageStream -> JsonToSseTransformStream, which
  // is what pipeUIMessageStreamToResponse serializes with).
  async function realSdkFrames(): Promise<string[]> {
    // The provider-level stream parts a one-step text generation emits. Typed as
    // `any[]` on purpose: this canary asserts the SDK's OUTPUT wire framing, not the
    // provider-protocol input types (which are an internal SDK concern and noisy to
    // satisfy exactly). The runtime shapes are the real ones the SDK consumes.
    const providerStreamParts: any[] = [
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'hello' },
      { type: 'text-end', id: '0' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ];
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream(providerStreamParts),
      }),
    });
    const result = streamText({ model, prompt: 'hi' });
    const sse = result
      .toUIMessageStream()
      .pipeThrough(new JsonToSseTransformStream());
    const reader = sse.getReader();
    const frames: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      frames.push(value);
    }
    return frames;
  }

  it('a single generation step emits EXACTLY ONE finish-step frame matching FINISH_STEP_FRAME_PREFIX', async () => {
    const frames = await realSdkFrames();
    const finishStepFrames = frames.filter((f) =>
      f.startsWith(FINISH_STEP_FRAME_PREFIX),
    );
    // The registry counts one boundary per finished step; a single step -> one.
    expect(finishStepFrames).toHaveLength(1);
  });

  it('the finish-step frame is a self-contained SSE event with `type` as the FIRST key (the two facts the prefix match relies on)', async () => {
    const frames = await realSdkFrames();
    const frame = frames.find((f) => f.startsWith(FINISH_STEP_FRAME_PREFIX))!;
    expect(frame).toBeDefined();

    // FACT 1: one part per `data:` event, terminated by a blank line — never split
    // across multiple `data:` lines (a prefix match would break otherwise).
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(frame.match(/\bdata:/g)).toHaveLength(1);

    // FACT 2: the JSON payload's FIRST key is `type` with value `finish-step`
    // (the prefix pins the leading `{"type":"finish-step"`), and the part carries
    // no other leading key that would push `type` out of first position.
    const payload = frame.slice('data: '.length).trimEnd();
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe('type');
    expect(parsed.type).toBe('finish-step');
  });
});
