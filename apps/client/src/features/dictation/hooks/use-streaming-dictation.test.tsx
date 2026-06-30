import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Shared, hoisted test state the module mocks write into. `onSpeechEnd` is the
// VAD callback the hook registers on MicVAD.new — capturing it lets us drive
// "a speech segment ended" deterministically. `pending` collects the deferred
// transcription promises so the test controls their resolution order, which is
// the whole point: out-of-order HTTP responses must NOT scramble the emitted
// text (the in-order emitter under test).
const h = vi.hoisted(() => {
  return {
    onSpeechEnd: null as null | ((audio: Float32Array) => void),
    pending: [] as { resolve: (s: string) => void; reject: (e: unknown) => void }[],
    notify: null as null | ReturnType<typeof Object>,
  };
});

// Lazy-imported VAD: capture the onSpeechEnd handler and hand back a no-op
// instance (start/pause/destroy all resolve).
vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: {
    new: vi.fn(async (opts: { onSpeechEnd: (a: Float32Array) => void }) => {
      h.onSpeechEnd = opts.onSpeechEnd;
      return {
        start: vi.fn(async () => {}),
        pause: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
      };
    }),
  },
}));

// Each transcribeAudio call returns a promise we resolve/reject by index.
vi.mock("@/features/dictation/services/dictation-service", () => ({
  transcribeAudio: vi.fn(
    () =>
      new Promise<string>((resolve, reject) => {
        h.pending.push({ resolve, reject });
      }),
  ),
}));

// Avoid real WAV encoding; the segment payload is irrelevant to ordering.
vi.mock("@/features/dictation/utils/encode-wav", () => ({
  encodeWavPcm16: vi.fn(() => new Blob()),
}));

const notifyShow = vi.fn();
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...args: unknown[]) => notifyShow(...args) },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));

import { useStreamingDictation } from "./use-streaming-dictation";

// jsdom has no AudioContext; the hook constructs one and calls resume(). A
// trivial stub is enough — the real audio path is irrelevant to ordering.
class FakeAudioContext {
  state = "running";
  resume() {
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

async function startRecording(onText: (t: string) => void) {
  const hook = renderHook(() => useStreamingDictation({ onText }));
  await act(async () => {
    await hook.result.current.start();
  });
  // The VAD registered its onSpeechEnd and start() resolved into "recording".
  expect(h.onSpeechEnd).toBeTypeOf("function");
  expect(hook.result.current.status).toBe("recording");
  return hook;
}

// Fire N ended speech segments (seq 0..N-1), each kicking off one transcription.
async function emitSegments(n: number) {
  await act(async () => {
    for (let i = 0; i < n; i++) h.onSpeechEnd!(new Float32Array(8));
  });
}

describe("useStreamingDictation — in-order segment emitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.onSpeechEnd = null;
    h.pending = [];
    notifyShow.mockClear();
    (window as unknown as { AudioContext: unknown }).AudioContext =
      FakeAudioContext;
  });

  it("emits transcriptions in segment order even when responses resolve out of order", async () => {
    const emitted: string[] = [];
    await startRecording((t) => emitted.push(t));
    await emitSegments(3);
    expect(h.pending).toHaveLength(3);

    // Resolve seq 1 FIRST: it must be buffered, not emitted, because seq 0 is
    // still outstanding (nextEmit == 0).
    await act(async () => {
      h.pending[1].resolve("second");
    });
    expect(emitted).toEqual([]);

    // Resolve seq 0: this unblocks the buffer and flushes 0 then 1 in order.
    await act(async () => {
      h.pending[0].resolve("first");
    });
    expect(emitted).toEqual(["first", "second"]);

    // seq 2 resolves last and flushes immediately (it is now next).
    await act(async () => {
      h.pending[2].resolve("third");
    });
    expect(emitted).toEqual(["first", "second", "third"]);
  });

  it("trims whitespace and drops empty/whitespace-only transcriptions while still advancing", async () => {
    const emitted: string[] = [];
    await startRecording((t) => emitted.push(t));
    await emitSegments(3);

    await act(async () => {
      h.pending[0].resolve("  hello  "); // leading/trailing space trimmed
      h.pending[1].resolve("   "); // whitespace-only -> not emitted, but seq advances
      h.pending[2].resolve("world");
    });

    expect(emitted).toEqual(["hello", "world"]);
  });

  it("a failed segment shows one notification and is skipped so later segments still flush in order", async () => {
    const emitted: string[] = [];
    await startRecording((t) => emitted.push(t));
    await emitSegments(2);

    // seq 0 fails: the user sees a notification and the emitter advances past it.
    await act(async () => {
      h.pending[0].reject({ message: "boom" });
    });
    expect(notifyShow).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);

    // seq 1 still flushes (it is now next), proving one failure did not stall.
    await act(async () => {
      h.pending[1].resolve("survivor");
    });
    expect(emitted).toEqual(["survivor"]);
  });

  it("ignores a transcription that resolves AFTER cancel() (stale epoch — no emit)", async () => {
    const emitted: string[] = [];
    const hook = await startRecording((t) => emitted.push(t));
    await emitSegments(1);

    // Hard discard the session: the in-flight request is now stale.
    act(() => {
      hook.result.current.cancel();
    });
    expect(hook.result.current.status).toBe("idle");

    // Its late resolution must be dropped (no emit into the new/empty session).
    await act(async () => {
      h.pending[0].resolve("late");
    });
    expect(emitted).toEqual([]);
  });
});
