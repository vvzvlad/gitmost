import { useCallback, useEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { transcribeAudio } from "@/features/dictation/services/dictation-service";
import { encodeWavPcm16 } from "@/features/dictation/utils/encode-wav";
import type { DictationStatus } from "@/features/dictation/hooks/use-dictation";

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
  maxDurationMs?: number;
}

interface UseStreamingDictationResult {
  status: DictationStatus;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  // Smoothed live speech level in the 0..1 range while recording (0 when idle).
  audioLevel: number;
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
 * Returns the SAME shape as useDictation ({ status, start, stop, cancel,
 * audioLevel }) so MicButton can use either interchangeably. Refs hold the live
 * VAD instance / counters / timer so component re-renders never lose them, and
 * every exit path destroys the VAD and stops the MediaStream.
 */
export function useStreamingDictation(
  options: UseStreamingDictationOptions,
): UseStreamingDictationResult {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [audioLevel, setAudioLevel] = useState(0);

  // Keep the latest callbacks in a ref so async VAD/HTTP closures always call the
  // current handlers without re-creating the VAD.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const vadRef = useRef<MicVADInstance | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canceledRef = useRef(false);
  const startingRef = useRef(false);
  // True while a recording session is active (VAD listening). Used to ignore late
  // VAD callbacks that fire after stop()/cancel().
  const activeRef = useRef(false);

  // In-order emission: each segment gets a monotonically increasing seq when its
  // speech ends; completed transcriptions are buffered by seq and flushed in
  // order so out-of-order HTTP responses can't scramble the text.
  const nextSeqRef = useRef(0);
  const nextEmitSeqRef = useRef(0);
  const resultsRef = useRef<Map<number, string>>(new Map());
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

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

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
  // requests are in flight, otherwise return to "idle".
  const settleAfterStop = useCallback(() => {
    if (inFlightRef.current > 0) {
      setStatus("transcribing");
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

  // Map a transcription error to a user-facing message, mirroring the batch hook.
  const transcriptionErrorMessage = useCallback(
    (err: unknown): string => {
      const resp = (
        err as { response?: { status?: number; data?: { message?: string } } }
      )?.response;
      const serverMsg = resp?.data?.message;
      if (serverMsg && serverMsg.trim().length > 0) {
        // The server already explains the cause (e.g. provider 404, bad format,
        // STT not configured) — show it verbatim.
        return serverMsg;
      }
      if (resp?.status === 503 || resp?.status === 403) {
        return t("Voice dictation is not configured");
      }
      return `${t("Transcription failed")}: ${(err as { message?: string })?.message ?? String(err)}`;
    },
    [t],
  );

  // Handle one ended speech segment: encode to WAV and transcribe. Results are
  // buffered by seq and flushed in order. A single failed segment does NOT kill
  // the session: log + one notification, then advance past that seq so later
  // segments still flush.
  const handleSegment = useCallback(
    (audio: Float32Array) => {
      const seq = nextSeqRef.current;
      nextSeqRef.current += 1;
      inFlightRef.current += 1;
      // Capture the epoch for this request synchronously at send time.
      const epoch = epochRef.current;

      const wavBlob = encodeWavPcm16(audio, VAD_SAMPLE_RATE);
      void transcribeAudio(wavBlob, "speech.wav")
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
          notifications.show({
            color: "red",
            message: transcriptionErrorMessage(err),
          });
          // Skip this seq so later segments can still flush in order.
          if (nextEmitSeqRef.current === seq) {
            nextEmitSeqRef.current += 1;
            drainResults();
          } else {
            resultsRef.current.set(seq, "");
            drainResults();
          }
        })
        .finally(() => {
          if (epoch !== epochRef.current) return;
          inFlightRef.current -= 1;
          // If recording already stopped, flip to idle once everything drained.
          if (!activeRef.current && inFlightRef.current === 0) {
            setStatus("idle");
          }
        });
    },
    [drainResults, transcriptionErrorMessage],
  );

  const start = useCallback(async (): Promise<void> => {
    // Synchronous live guard: status is stale between renders, so also block on
    // refs to prevent a double-click from creating two VAD instances (the first
    // would leak its mic stream).
    if (startingRef.current || vadRef.current || activeRef.current) return;
    if (status !== "idle") return;
    startingRef.current = true;

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
    inFlightRef.current = 0;
    resetLevel();

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
      notifications.show({
        color: "red",
        message: `${t("Could not start recording")}: ${detail}`,
      });
      // Defensive: if MicVAD.new partially succeeded before throwing, make sure we
      // don't leak it.
      destroyVad();
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
      const name = (err as { name?: string })?.name;
      const detail = (err as { message?: string })?.message ?? String(err);
      let message: string;
      if (name === "NotAllowedError" || name === "SecurityError") {
        message = t("Microphone access denied");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        message = t("No microphone found");
      } else if (name === "NotReadableError" || name === "AbortError") {
        message = t("Microphone is unavailable or already in use");
      } else {
        message = `${t("Could not start recording")}: ${detail}`;
      }
      notifications.show({ color: "red", message });
      activeRef.current = false;
      destroyVad();
      setStatus("idle");
      startingRef.current = false;
      return;
    }

    setStatus("recording");
    // Recording has truly begun; release the synchronous start guard.
    startingRef.current = false;

    // Optional overall safety cap: auto-stop after maxDurationMs like the batch
    // hook does.
    const maxDurationMs = optionsRef.current.maxDurationMs ?? 120000;
    timerRef.current = setTimeout(() => {
      if (activeRef.current) stopRef.current();
    }, maxDurationMs);
  }, [status, t, resetLevel, destroyVad, handleSegment]);

  const stop = useCallback((): void => {
    clearTimer();
    if (!activeRef.current && !vadRef.current) {
      // Nothing is running; make sure the UI is idle.
      setStatus("idle");
      return;
    }
    // Mark inactive first so late onSpeechEnd/onFrameProcessed callbacks are
    // ignored. Any speech segment that has NOT yet ended (user clicks Stop
    // mid-utterance) is dropped — acceptable for v1; users normally pause before
    // stopping.
    activeRef.current = false;
    destroyVad();
    resetLevel();
    settleAfterStop();
  }, [clearTimer, destroyVad, resetLevel, settleAfterStop]);

  // Keep stop() reachable from the maxDuration timer closure (which is created
  // before stop is defined) without re-creating the VAD.
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const cancel = useCallback((): void => {
    clearTimer();
    canceledRef.current = true;
    activeRef.current = false;
    // Hard discard: bump the epoch so any in-flight request becomes stale and is
    // ignored the moment it resolves (no emit, no counter touch).
    epochRef.current += 1;
    // Drop pending results / queue; in-flight requests will resolve into a now-
    // empty buffer and be ignored.
    resultsRef.current = new Map();
    nextSeqRef.current = 0;
    nextEmitSeqRef.current = 0;
    inFlightRef.current = 0;
    destroyVad();
    resetLevel();
    setStatus("idle");
  }, [clearTimer, destroyVad, resetLevel]);

  // Clean up on unmount: destroy the VAD, stop the mic stream, clear the timer.
  // Defensive try/catch lives inside destroyVad so teardown never throws.
  useEffect(() => {
    return () => {
      clearTimer();
      activeRef.current = false;
      canceledRef.current = true;
      destroyVad();
    };
  }, [clearTimer, destroyVad]);

  return { status, start, stop, cancel, audioLevel };
}
