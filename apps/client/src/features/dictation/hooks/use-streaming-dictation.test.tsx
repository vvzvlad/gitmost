import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Shared, hoisted test state the module mocks write into. `onSpeechEnd` is the
// VAD callback the hook registers on MicVAD.new — capturing it lets us drive
// "a speech segment ended" deterministically. `speaking` marks a segment that
// is still being spoken. `pending` collects the deferred transcription promises
// (with the audio sent) so the test controls their resolution order, which is
// the whole point: out-of-order HTTP responses must NOT scramble the emitted
// text (the in-order emitter under test).
const h = vi.hoisted(() => {
  return {
    onSpeechEnd: null as null | ((audio: Float32Array) => void),
    speaking: false,
    vad: null as null | { pause: () => Promise<void> },
    pending: [] as {
      blob: Blob;
      resolve: (s: string) => void;
      reject: (e: unknown) => void;
    }[],
  };
});

// Lazy-imported VAD: capture the onSpeechEnd handler. Like vad-web 0.0.30,
// pause() hands the open segment to onSpeechEnd only with
// submitUserSpeechOnPause, and destroy() pauses a listening VAD.
vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: {
    new: vi.fn(
      async (opts: {
        onSpeechEnd: (a: Float32Array) => void;
        submitUserSpeechOnPause?: boolean;
      }) => {
        h.onSpeechEnd = opts.onSpeechEnd;
        let listening = false;
        const pause = vi.fn(async () => {
          if (!listening) return;
          listening = false;
          if (opts.submitUserSpeechOnPause && h.speaking) {
            h.speaking = false;
            opts.onSpeechEnd(new Float32Array(8));
          }
        });
        const vad = {
          start: vi.fn(async () => {
            listening = true;
          }),
          pause,
          destroy: vi.fn(async () => {
            if (listening) await pause();
          }),
        };
        h.vad = vad;
        return vad;
      },
    ),
  },
}));

// Each transcription call returns a promise we resolve/reject by index.
vi.mock("@/features/dictation/services/dictation-service", () => ({
  transcribeWithRetry: vi.fn(
    (blob: Blob) =>
      new Promise<string>((resolve, reject) => {
        h.pending.push({ blob, resolve, reject });
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
import { useDictation } from "./use-dictation";

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
    h.speaking = false;
    h.vad = null;
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

  it("a failed segment is held and blocks later text; retry() resends its audio and flushes in order", async () => {
    const emitted: string[] = [];
    const hook = await startRecording((t) => emitted.push(t));
    await emitSegments(3);

    // seq 0 fails for good while seq 1 and 2 succeed: one notification, and the
    // later text waits behind the held segment instead of skipping it.
    await act(async () => {
      h.pending[0].reject({ message: "boom" });
      h.pending[1].resolve("second");
      h.pending[2].resolve("third");
    });
    expect(emitted).toEqual([]);
    expect(notifyShow).toHaveBeenCalledTimes(1);
    expect(notifyShow.mock.calls[0][0].message).toContain(
      "the recording is kept and can be transcribed again",
    );
    expect(hook.result.current.status).toBe("recording");

    // Stopping with a held segment and nothing in flight ends in "failed".
    await act(async () => {
      hook.result.current.stop();
    });
    expect(hook.result.current.status).toBe("failed");

    // retry() resends the held WAV; its text lands first, then the waiting text.
    act(() => {
      hook.result.current.retry();
    });
    expect(h.pending).toHaveLength(4);
    expect(h.pending[3].blob).toBe(h.pending[0].blob);
    expect(hook.result.current.status).toBe("transcribing");
    await act(async () => {
      h.pending[3].resolve("first");
    });
    expect(emitted).toEqual(["first", "second", "third"]);
    expect(hook.result.current.status).toBe("idle");
  });

  it("discard() drops held segments and emits the later text that waited behind them", async () => {
    const emitted: string[] = [];
    const hook = await startRecording((t) => emitted.push(t));
    await emitSegments(3);

    // seq 1 (NOT next-to-emit) fails; only seq 0 may land, seq 2 waits.
    await act(async () => {
      h.pending[1].reject({ message: "boom" });
      h.pending[0].resolve("alpha");
      h.pending[2].resolve("gamma");
    });
    expect(emitted).toEqual(["alpha"]);

    await act(async () => {
      hook.result.current.stop();
    });
    expect(hook.result.current.status).toBe("failed");

    act(() => {
      hook.result.current.discard();
    });
    expect(emitted).toEqual(["alpha", "gamma"]);
    expect(hook.result.current.status).toBe("idle");
    expect(h.pending).toHaveLength(3);
  });

  it("stop() mid-speech transcribes the segment still being spoken; cancel() drops it", async () => {
    const emitted: string[] = [];
    const hook = await startRecording((t) => emitted.push(t));

    h.speaking = true;
    await act(async () => {
      hook.result.current.stop();
    });
    expect(h.pending).toHaveLength(1);
    expect(hook.result.current.status).toBe("transcribing");
    await act(async () => {
      h.pending[0].resolve("tail");
    });
    expect(emitted).toEqual(["tail"]);
    expect(hook.result.current.status).toBe("idle");

    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe("recording");
    h.speaking = true;
    await act(async () => {
      hook.result.current.cancel();
    });
    expect(h.pending).toHaveLength(1);
    expect(hook.result.current.status).toBe("idle");
  });

  it("keeps recording past two minutes (no duration cap)", async () => {
    vi.useFakeTimers();
    try {
      const hook = await startRecording(() => {});
      await act(async () => {
        vi.advanceTimersByTime(10 * 60 * 1000);
      });
      expect(hook.result.current.status).toBe("recording");
      expect(h.vad!.pause).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

// Minimal MediaRecorder: stop() delivers one chunk and fires onstop, as the
// browser does.
class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  static last: FakeMediaRecorder | null = null;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  });
  constructor() {
    FakeMediaRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
}

describe("useDictation (batch)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.pending = [];
    notifyShow.mockClear();
    FakeMediaRecorder.last = null;
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      FakeMediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
    });
  });

  async function startBatch(onText: (t: string) => void) {
    const hook = renderHook(() => useDictation({ onText }));
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe("recording");
    return hook;
  }

  it("a failed transcription ends in 'failed' and retry() resends the same audio", async () => {
    const emitted: string[] = [];
    const hook = await startBatch((t) => emitted.push(t));
    act(() => {
      hook.result.current.stop();
    });
    expect(hook.result.current.status).toBe("transcribing");

    await act(async () => {
      h.pending[0].reject({ message: "boom" });
    });
    expect(hook.result.current.status).toBe("failed");
    expect(notifyShow).toHaveBeenCalledTimes(1);

    // start() is a no-op while the recording waits for retry or discard.
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe("failed");

    act(() => {
      hook.result.current.retry();
    });
    expect(h.pending).toHaveLength(2);
    expect(h.pending[1].blob).toBe(h.pending[0].blob);
    await act(async () => {
      h.pending[1].resolve(" hello ");
    });
    expect(emitted).toEqual(["hello"]);
    expect(hook.result.current.status).toBe("idle");
  });

  it("keeps recording past two minutes (no duration cap)", async () => {
    vi.useFakeTimers();
    try {
      const hook = await startBatch(() => {});
      await act(async () => {
        vi.advanceTimersByTime(10 * 60 * 1000);
      });
      expect(hook.result.current.status).toBe("recording");
      expect(FakeMediaRecorder.last!.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops and transcribes a recording at the 20-minute size budget", async () => {
    vi.useFakeTimers();
    try {
      const hook = await startBatch(() => {});
      await act(async () => {
        vi.advanceTimersByTime(20 * 60 * 1000);
      });
      expect(FakeMediaRecorder.last!.stop).toHaveBeenCalledTimes(1);
      expect(h.pending).toHaveLength(1);
      expect(hook.result.current.status).toBe("transcribing");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useStreamingDictation — unmount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.onSpeechEnd = null;
    h.speaking = false;
    h.vad = null;
    h.pending = [];
    notifyShow.mockClear();
    (window as unknown as { AudioContext: unknown }).AudioContext =
      FakeAudioContext;
  });

  it("drops a segment that fails after unmount: no notification, no text", async () => {
    const emitted: string[] = [];
    const hook = await startRecording((t) => emitted.push(t));
    await emitSegments(2);
    hook.unmount();

    await act(async () => {
      h.pending[0].reject({ message: "boom" });
      h.pending[1].resolve("late");
    });
    expect(notifyShow).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
});
