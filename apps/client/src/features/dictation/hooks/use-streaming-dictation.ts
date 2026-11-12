import { useCallback, useEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { transcribeWithRetry } from "@/features/dictation/services/dictation-service";
import { encodeWavPcm16 } from "@/features/dictation/utils/encode-wav";
import type { DictationStatus } from "@/features/dictation/hooks/use-dictation";
import { useScreenWakeLock } from "@/features/dictation/hooks/use-screen-wake-lock";
import {
  classifyGetUserMediaError,
  classifyTranscriptionError,
  dictationErrorMessage,
} from "@/features/dictation/dictation-status";

// Lazily-imported MicVAD type. The runtime import happens inside start() so the
// heavy onnxruntime-web / Silero model is code-split out of the main bundle and
// only fetched when the user actually begins dictation.
type MicVADInstance = {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
};

interface UseStreamingDictationOptions {
  onText: (text: string) => void;
  onStart?: () => void;
}

interface UseStreamingDictationResult {
  status: DictationStatus;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  // Resend every held (failed) segment in segment order.
  retry: () => void;
  // Drop every held segment and emit the later text that waited behind them.
  discard: () => void;
  // Smoothed live speech level in the 0..1 range while recording (0 when idle).
  audioLevel: number;
  // The last error shown to the user (null until one occurs / on a new start).
  errorMessage: string | null;
}

// Sample rate of the audio MicVAD hands to onSpeechEnd (Silero VAD runs at 16k).
const VAD_SAMPLE_RATE = 16000;

// Asset paths for the VAD worklet/Silero model and the onnxruntime-web WASM
// binaries. vad-web 0.0.30's default asset path is "./" (relative to the current
// page URL), NOT a CDN — in this SPA that request hits the client-side catch-all
// route and returns index.html (text/html), so the onnxruntime ESM/wasm backend
// fails to initialize. We instead self-host the four needed files (the vad-web
// worklet + `silero_vad_v5.onnx` model and the onnxruntime-web `*.jsep.mjs`/
// `*.jsep.wasm`) under `apps/client/public/vad/` — populated by
// `scripts/copy-vad-assets.mjs`, which runs before `dev`/`build` — and point both
// paths at the fixed absolute "/vad/".
const VAD_BASE_ASSET_PATH: string | undefined = "/vad/";
const VAD_ONNX_WASM_BASE_PATH: string | undefined = "/vad/";

/**
 * Streaming variant of useDictation. Detects speech with a real (Silero) VAD and,
 * each time the speaker pauses, cuts that speech segment and POSTs it to the same
 * batch transcription endpoint, so text appears progressively as the user speaks.
 *
 * Returns the SAME shape as useDictation ({ status, start, stop, cancel, retry,
 * discard, audioLevel }) so MicButton can use either interchangeably. Refs hold
 * the live VAD instance / counters so component re-renders never lose them, and
 * every exit path destroys the VAD and stops the MediaStream. Recording runs
 * until the user stops it. A segment whose transcription finally fails is held
 * with its audio and blocks the text of later segments until retry() or
 * discard(), so the text always lands in spoken order.
 */
export function useStreamingDictation(
  options: UseStreamingDictationOptions,
): UseStreamingDictationResult {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  // Last error message shown to the user; the mic button reads it for its tooltip.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Keep the latest callbacks in a ref so async VAD/HTTP closures always call the
  // current handlers without re-creating the VAD.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const vadRef = useRef<MicVADInstance | null>(null);
  // AudioContext we create+resume inside the click gesture and inject into
  // MicVAD (see start()). We own it; MicVAD does not close an injected context.
  const audioContextRef = useRef<AudioContext | null>(null);
  const canceledRef = useRef(false);
  const startingRef = useRef(false);
  // True while a recording session is active (VAD listening). Used to ignore late
  // VAD callbacks that fire after stop()/cancel(). stop() keeps it true while the
  // VAD flushes the segment still being spoken.
  const activeRef = useRef(false);
  // True while stop() waits for that flush; a second stop() is ignored.
  const stoppingRef = useRef(false);

  // In-order emission: each segment gets a monotonically increasing seq when its
  // speech ends; completed transcriptions are buffered by seq and flushed in
  // order so out-of-order HTTP responses can't scramble the text.
  const nextSeqRef = useRef(0);
  const nextEmitSeqRef = useRef(0);
  const resultsRef = useRef<Map<number, string>>(new Map());
  // Segments whose transcription finally failed, by seq, with their WAV audio.
  // A held seq has no entry in resultsRef, so it stops the drain there.
  const heldRef = useRef<Map<number, Blob>>(new Map());
  // Number of transcription requests still in flight.
  const inFlightRef = useRef(0);
  // Session epoch: bumped when a NEW session starts (start) or everything is
  // hard-discarded (cancel). Each in-flight request captures the epoch at send
  // time; if the epoch has since changed, the request is stale and its
  // then/catch/finally are skipped so old text can't leak into a new session and
  // the in-flight counter can't be driven negative across sessions.
  const epochRef = useRef(0);

  // Exponentially smoothed speech level, and the last value pushed to React state.
  const smoothedLevelRef = useRef(0);
  const emittedLevelRef = useRef(0);

  const { acquire: acquireWakeLock, release: releaseWakeLock } =
    useScreenWakeLock();

  // Reset the level meter back to zero (refs + React state).
  const resetLevel = useCallback(() => {
    smoothedLevelRef.current = 0;
    emittedLevelRef.current = 0;
    setAudioLevel(0);
  }, []);

  // Destroy the live VAD instance (which also releases the mic stream and audio
  // context it created). Safe to call multiple times and on any exit path;
  // defensive try/catch so teardown never throws.
  const destroyVad = useCallback(() => {
    const vad = vadRef.current;
    vadRef.current = null;
    if (vad) {
      try {
        // destroy() pauses + tears down the worklet/stream/context internally.
        // It returns a promise, so attach a .catch too: the surrounding
        // try/catch only catches synchronous throws, and a rejected destroy()
        // would otherwise surface as an unhandled rejection.
        void vad
          .destroy()
          .catch((err) =>
            console.warn("[dictation] VAD teardown failed", err),
          );
      } catch (err) {
        // Cleanup must never throw; just log for diagnosis.
        console.warn("[dictation] VAD teardown failed", err);
      }
    }
  }, []);

  // Decide the status once recording has ended: stay "transcribing" while
  // requests are in flight, then "failed" while a segment is held, otherwise
  // return to "idle".
  const settleAfterStop = useCallback(() => {
    if (inFlightRef.current > 0) {
      setStatus("transcribing");
    } else if (heldRef.current.size > 0) {
      setStatus("failed");
    } else {
      setStatus("idle");
    }
  }, []);

  // Drain the in-order result buffer: while the next expected seq is ready, trim
  // it, emit it if non-empty, and advance. Called after every resolved request.
  const drainResults = useCallback(() => {
    const results = resultsRef.current;
    while (results.has(nextEmitSeqRef.current)) {
      const text = results.get(nextEmitSeqRef.current)!;
      results.delete(nextEmitSeqRef.current);
      nextEmitSeqRef.current += 1;
      const trimmed = text.trim();
      // Whisper often returns a leading space; emit the trimmed value.
      if (trimmed.length > 0) optionsRef.current.onText(trimmed);
    }
  }, []);

  // Transcribe one segment's WAV audio. Results are buffered by seq and flushed
  // in order. A segment that finally fails does NOT kill the session: log + one
  // notification, then hold its audio in heldRef, which stops the drain at its
  // seq until retry() or discard().
  const sendSegment = useCallback(
    (seq: number, wavBlob: Blob) => {
      inFlightRef.current += 1;
      // Capture the epoch for this request synchronously at send time.
      const epoch = epochRef.current;

      void transcribeWithRetry(
        wavBlob,
        "speech.wav",
        () => epoch !== epochRef.current,
      )
        .then((text) => {
          // Stale request from a previous session: drop it without touching any
          // current-session state.
          if (epoch !== epochRef.current) return;
          // Defend against a non-string server value before drainResults trims.
          resultsRef.current.set(seq, typeof text === "string" ? text : "");
          drainResults();
        })
        .catch((err: unknown) => {
          if (epoch !== epochRef.current) return;
          // Log the full error for diagnosis (status + body + stack).
          console.error("[dictation] segment transcription failed", err);
          const { code, serverMessage } = classifyTranscriptionError(err);
          const detail = (err as { message?: string })?.message ?? String(err);
          const message = dictationErrorMessage(code, t, {
            serverMessage,
            detail,
          });
          notifications.show({
            color: "red",
            message: `${message} — ${t("the recording is kept and can be transcribed again")}`,
          });
          setErrorMessage(message);
          heldRef.current.set(seq, wavBlob);
        })
        .finally(() => {
          if (epoch !== epochRef.current) return;
          inFlightRef.current -= 1;
          // If recording already stopped, settle once nothing is in flight.
          if (!activeRef.current && inFlightRef.current === 0) {
            settleAfterStop();
          }
        });
    },
    [drainResults, settleAfterStop, t],
  );

  // Handle one ended speech segment: give it the next seq, encode it to WAV and
  // transcribe it.
  const handleSegment = useCallback(
    (audio: Float32Array) => {
      const seq = nextSeqRef.current;
      nextSeqRef.current += 1;
      sendSegment(seq, encodeWavPcm16(audio, VAD_SAMPLE_RATE));
    },
    [sendSegment],
  );

  const start = useCallback(async (): Promise<void> => {
    // Synchronous live guard: status is stale between renders, so also block on
    // refs to prevent a double-click from creating two VAD instances (the first
    // would leak its mic stream).
    if (startingRef.current || vadRef.current || activeRef.current) return;
    if (status !== "idle") return;
    startingRef.current = true;
    // Clear any stale error from a previous attempt.
    setErrorMessage(null);
    // Request the wake lock now, inside the click: iOS Safari grants it only
    // to a call made during a user gesture, which the awaits below end.
    acquireWakeLock();

    // Notify the caller right when dictation begins (before any async work) so the
    // editor can snapshot the caret position.
    optionsRef.current.onStart?.();

    // Reset per-session in-order emission state. Bump the epoch so any request
    // still in flight from a previous (stopped) session becomes stale and its
    // then/catch/finally are skipped — it can neither emit old text into this
    // new session nor decrement this session's freshly-zeroed in-flight counter.
    epochRef.current += 1;
    canceledRef.current = false;
    nextSeqRef.current = 0;
    nextEmitSeqRef.current = 0;
    resultsRef.current = new Map();
    heldRef.current = new Map();
    inFlightRef.current = 0;
    resetLevel();

    // Create and resume the AudioContext NOW, inside the click gesture, before
    // the (first-time-slow) model load below: a context first touched outside a
    // user gesture stays "suspended" and the VAD audio worklet never runs. We own
    // this context and inject it into MicVAD (which then will NOT close it); it is
    // reused across start/stop and closed only on unmount.
    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (AudioCtor && !audioContextRef.current) {
      audioContextRef.current = new AudioCtor();
    }
    // Resume within the gesture; swallow rejection (e.g. already running/closed).
    void audioContextRef.current?.resume().catch(() => {});
    // Show immediate feedback while the model loads (see Part B).
    setStatus("loading");

    let vad: MicVADInstance;
    try {
      // Lazy import so the heavy onnx model/worklet are only fetched on first use
      // and code-split out of the main bundle.
      const { MicVAD } = await import("@ricky0123/vad-web");

      vad = await MicVAD.new({
        // Silero v5 model (smaller/faster than the legacy model).
        model: "v5",
        // vad-web 0.0.30 defaults startOnLoad:true, which opens the mic (calls
        // getUserMedia) inside new() and leaves the later vad.start() a no-op —
        // making its mic-permission error handling dead code. Force it off so the
        // mic is opened only by the explicit vad.start() below, where the real
        // getUserMedia errors are caught and mapped.
        startOnLoad: false,
        // Inject the AudioContext we created+resumed inside the click gesture so
        // the VAD worklet runs on a "running" context. When provided, the library
        // uses it and does NOT take ownership/close it.
        ...(audioContextRef.current
          ? { audioContext: audioContextRef.current }
          : {}),
        // Only pass asset paths when defined; otherwise the library uses its
        // bundled CDN defaults.
        ...(VAD_BASE_ASSET_PATH !== undefined
          ? { baseAssetPath: VAD_BASE_ASSET_PATH }
          : {}),
        ...(VAD_ONNX_WASM_BASE_PATH !== undefined
          ? { onnxWASMBasePath: VAD_ONNX_WASM_BASE_PATH }
          : {}),
        // --- VAD tuning (all tunable) ---
        // Probability over which a frame counts as speech.
        positiveSpeechThreshold: 0.5,
        // Probability under which a frame counts as non-speech (~0.15 below the
        // positive threshold, per Silero guidance).
        negativeSpeechThreshold: 0.35,
        // Silence to wait through before ending a segment (the "don't cut
        // immediately" delay). Each ended segment is ONE transcription request, so
        // cutting on short gaps over-fragments normal speech into a flood of tiny
        // requests (and trips the server's per-user rate limit). Wait ~1.5s — a
        // real sentence/thought boundary — so request count tracks actual pauses,
        // not every inter-word gap. Higher = fewer requests but more latency
        // before text appears. NOTE: vad-web 0.0.30 takes this in ms, not frames
        // (one Silero frame is ~32ms at 16k).
        redemptionMs: 1500,
        // Audio kept before speech start (left padding so the first word isn't
        // clipped) — ~0.3s.
        preSpeechPadMs: 320,
        // Ignore sub-100ms blips like clicks.
        minSpeechMs: 96,
        // Make pause() end the segment still being spoken with onSpeechEnd
        // instead of dropping it, so stop() mid-sentence transcribes the tail.
        // destroy() pauses too, which is why cancel() and unmount mark the
        // session inactive first: onSpeechEnd then ignores that tail.
        submitUserSpeechOnPause: true,
        onFrameProcessed: (probabilities: { isSpeech: number }) => {
          // Drive the level meter from the speech probability. Light exponential
          // smoothing + a throttle so React state isn't updated every frame; this
          // powers the existing button halo. Reuses the VAD's own frame
          // probabilities — no second AudioContext/AnalyserNode.
          if (!activeRef.current) return;
          const level = Math.min(1, Math.max(0, probabilities.isSpeech));
          smoothedLevelRef.current = smoothedLevelRef.current * 0.8 + level * 0.2;
          if (Math.abs(smoothedLevelRef.current - emittedLevelRef.current) > 0.01) {
            emittedLevelRef.current = smoothedLevelRef.current;
            setAudioLevel(smoothedLevelRef.current);
          }
        },
        onSpeechStart: () => {
          // No-op: the segment is only handled once it ends.
        },
        onSpeechEnd: (audio: Float32Array) => {
          // A pause was detected — cut this segment and transcribe it. Ignore late
          // callbacks that fire after stop()/cancel().
          if (!activeRef.current || canceledRef.current) return;
          handleSegment(audio);
        },
      });
    } catch (err) {
      // With startOnLoad:false, new() loads the model/worklet/wasm but does NOT
      // open the mic, so a throw here is an asset/init failure (model fetch,
      // worklet, onnxruntime wasm), not a mic-permission error. Map it as a
      // generic "could not start" with the underlying detail. (The mic-permission
      // name checks are kept in the vad.start() catch below, where getUserMedia
      // actually runs.)
      console.error("[dictation] VAD init failed", err);
      const detail = (err as { message?: string })?.message ?? String(err);
      const message = dictationErrorMessage("vad-init-failed", t, { detail });
      notifications.show({ color: "red", message });
      setErrorMessage(message);
      // Defensive: if MicVAD.new partially succeeded before throwing, make sure we
      // don't leak it.
      destroyVad();
      releaseWakeLock();
      setStatus("idle");
      startingRef.current = false;
      return;
    }

    vadRef.current = vad;
    // Accept frames once start() resolves; the VAD callbacks already guard on
    // activeRef, so setting it before start() is safe.
    activeRef.current = true;

    try {
      // With startOnLoad:false this is where getUserMedia actually runs, so map
      // mic-permission errors here the same way the batch hook does; otherwise
      // fall back to a generic "could not start" message.
      await vad.start();
    } catch (err) {
      // Always log the full error for diagnosis (name, message, stack).
      console.error("[dictation] VAD.start failed", err);
      const detail = (err as { message?: string })?.message ?? String(err);
      const code = classifyGetUserMediaError(err);
      const message = dictationErrorMessage(code, t, { detail });
      notifications.show({ color: "red", message });
      setErrorMessage(message);
      activeRef.current = false;
      destroyVad();
      releaseWakeLock();
      setStatus("idle");
      startingRef.current = false;
      return;
    }

    setStatus("recording");
    // Recording has truly begun; release the synchronous start guard.
    startingRef.current = false;
  }, [
    status,
    t,
    resetLevel,
    destroyVad,
    handleSegment,
    acquireWakeLock,
    releaseWakeLock,
  ]);

  const stop = useCallback(async (): Promise<void> => {
    if (stoppingRef.current) return;
    if (!activeRef.current && !vadRef.current) {
      // Nothing is running; make sure the UI is idle.
      setStatus("idle");
      return;
    }
    // Flush the segment still being spoken: with submitUserSpeechOnPause,
    // pause() hands it to onSpeechEnd, which still accepts it because the
    // session stays active until the pause has finished.
    stoppingRef.current = true;
    const vad = vadRef.current;
    try {
      await vad?.pause();
    } catch (err) {
      console.warn("[dictation] VAD pause failed", err);
    }
    stoppingRef.current = false;
    // cancel(), unmount or a new session took over during the flush and owns
    // the teardown.
    if (vadRef.current !== vad) return;
    // Mark inactive so late onSpeechEnd/onFrameProcessed callbacks are ignored.
    activeRef.current = false;
    destroyVad();
    releaseWakeLock();
    resetLevel();
    settleAfterStop();
  }, [destroyVad, releaseWakeLock, resetLevel, settleAfterStop]);

  const cancel = useCallback((): void => {
    canceledRef.current = true;
    activeRef.current = false;
    // Hard discard: bump the epoch so any in-flight request becomes stale and is
    // ignored the moment it resolves (no emit, no counter touch).
    epochRef.current += 1;
    // Drop pending results / queue / held segments; in-flight requests will
    // resolve into a now-empty buffer and be ignored.
    resultsRef.current = new Map();
    heldRef.current = new Map();
    nextSeqRef.current = 0;
    nextEmitSeqRef.current = 0;
    inFlightRef.current = 0;
    destroyVad();
    releaseWakeLock();
    resetLevel();
    setStatus("idle");
  }, [destroyVad, releaseWakeLock, resetLevel]);

  const retry = useCallback((): void => {
    const held = [...heldRef.current.entries()].sort((a, b) => a[0] - b[0]);
    if (held.length === 0) return;
    heldRef.current = new Map();
    for (const [seq, wavBlob] of held) sendSegment(seq, wavBlob);
    if (!activeRef.current) settleAfterStop();
  }, [sendSegment, settleAfterStop]);

  const discard = useCallback((): void => {
    if (heldRef.current.size === 0) return;
    // An empty result lets the drain step over each dropped seq.
    for (const seq of heldRef.current.keys()) resultsRef.current.set(seq, "");
    heldRef.current = new Map();
    drainResults();
    if (!activeRef.current) settleAfterStop();
  }, [drainResults, settleAfterStop]);

  // Clean up on unmount: destroy the VAD and stop the mic stream; the wake lock
  // hook releases its lock on its own unmount. Defensive try/catch lives inside
  // destroyVad so teardown never throws.
  useEffect(() => {
    return () => {
      activeRef.current = false;
      canceledRef.current = true;
      // Stale every in-flight request: no more retries, no text, no toast.
      epochRef.current += 1;
      destroyVad();
      // Close the AudioContext we own (MicVAD never closes an injected one).
      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        void audioContextRef.current.close().catch(() => {});
      }
      audioContextRef.current = null;
    };
  }, [destroyVad]);

  return {
    status,
    start,
    stop,
    cancel,
    retry,
    discard,
    audioLevel,
    errorMessage,
  };
}
