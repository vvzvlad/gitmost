import { useCallback, useEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { transcribeAudio } from "@/features/dictation/services/dictation-service";

// "loading" is set only by the streaming hook while it lazily loads the VAD
// model on first use; the batch hook never sets it. It exists so the streaming
// hook and the mic button can show immediate feedback during that load.
export type DictationStatus =
  | "idle"
  | "recording"
  | "transcribing"
  | "error"
  | "loading";

interface UseDictationOptions {
  onText: (text: string) => void;
  onStart?: () => void;
  maxDurationMs?: number;
}

interface UseDictationResult {
  status: DictationStatus;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  // Smoothed live microphone level in the 0..1 range while recording (0 when idle).
  audioLevel: number;
}

// Candidate container/codec combinations in preference order. The first one the
// browser supports wins; if none do we let MediaRecorder pick its own default.
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

// Derive a sensible upload filename from the recorded MIME type. The server keys
// off the blob's MIME, so this only affects the part name, but a matching
// extension keeps things tidy.
function filenameForMime(mime: string): string {
  if (mime.includes("mp4")) return "speech.mp4";
  if (mime.includes("ogg")) return "speech.ogg";
  return "speech.webm";
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Encapsulates the browser audio-capture state machine: request the mic, record
 * with MediaRecorder, then POST the blob for transcription. Refs hold the live
 * recorder/stream/chunks/timer/cancel flag so component re-renders never lose
 * them, and every exit path stops the MediaStream tracks.
 */
export function useDictation(
  options: UseDictationOptions,
): UseDictationResult {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [audioLevel, setAudioLevel] = useState(0);

  // Keep the latest callbacks in a ref so the recorder's onstop closure always
  // calls the current handlers without re-creating the recorder.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canceledRef = useRef(false);
  const startingRef = useRef(false);

  // Web Audio metering: derives a live input level from the captured stream.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  // Exponentially smoothed level, and the last value pushed to React state.
  const smoothedLevelRef = useRef(0);
  const emittedLevelRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // Tear the audio meter down fully. Safe to call multiple times and on any exit
  // path; defensive try/catch so cleanup never throws.
  const stopMeter = useCallback(() => {
    // Cancel the rAF first so getByteTimeDomainData can't run on a closed context.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      sourceRef.current?.disconnect();
      sourceRef.current = null;
      analyserRef.current = null;
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        void audioContextRef.current.close();
      }
      audioContextRef.current = null;
    } catch (err) {
      // Cleanup must never throw; just log for diagnosis.
      console.warn("[dictation] audio meter teardown failed", err);
    }
    smoothedLevelRef.current = 0;
    emittedLevelRef.current = 0;
    setAudioLevel(0);
  }, []);

  // Set up Web Audio metering on the already-captured stream. Reuses the existing
  // MediaStream — never requests a second mic. Failure here must not break
  // recording: on any error we warn and return, leaving the recorder running.
  const startMeter = useCallback((stream: MediaStream) => {
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;

      const audioContext = new Ctor();
      // Some browsers start the context suspended; resume so the loop produces
      // data. Swallow rejection (e.g. context already closed by a fast
      // start/stop race) to avoid an unhandled promise rejection.
      audioContext.resume().catch(() => {});
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      // Connect ONLY to the analyser — never to destination, which would echo the
      // mic back to the speakers.
      source.connect(analyser);

      audioContextRef.current = audioContext;
      sourceRef.current = source;
      analyserRef.current = analyser;

      // Allocate the time-domain buffer once and reuse it on every tick.
      const data = new Uint8Array(analyser.fftSize);

      const tick = () => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteTimeDomainData(data);
        // RMS of the centered waveform (samples are 0..255, midpoint 128).
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        // Boost + clamp so normal speech maps to a visible 0..1 range.
        const level = Math.min(1, rms * 3);
        // Exponential smoothing to avoid jitter.
        smoothedLevelRef.current = smoothedLevelRef.current * 0.8 + level * 0.2;
        // Throttle React re-renders: only push when it changed meaningfully.
        if (Math.abs(smoothedLevelRef.current - emittedLevelRef.current) > 0.01) {
          emittedLevelRef.current = smoothedLevelRef.current;
          setAudioLevel(smoothedLevelRef.current);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      // Web Audio unavailable or threw: recording continues without the meter.
      console.warn("[dictation] audio meter unavailable", err);
    }
  }, []);

  const start = useCallback(async (): Promise<void> => {
    // Synchronous live guard: status is stale between renders, so also block on
    // refs to prevent a double-click from opening two MediaStreams (the first
    // would leak).
    if (startingRef.current || recorderRef.current || streamRef.current) return;
    if (status !== "idle") return;
    startingRef.current = true;

    if (!navigator.mediaDevices?.getUserMedia) {
      const reason =
        "navigator.mediaDevices.getUserMedia is unavailable in this context";
      console.error("[dictation] " + reason);
      notifications.show({
        color: "red",
        message: t("Audio recording is not available in this browser/context"),
      });
      setStatus("idle");
      startingRef.current = false;
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Always log the full error for diagnosis (name, message, stack).
      console.error("[dictation] getUserMedia failed", err);
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
        // Unknown failure: show the real reason instead of a generic string.
        message = `${t("Could not start recording")}: ${name ? `${name}: ` : ""}${detail}`;
      }
      notifications.show({ color: "red", message });
      setStatus("idle");
      startingRef.current = false;
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    canceledRef.current = false;

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
    } catch (err) {
      console.error("[dictation] MediaRecorder failed", err);
      // The stream was acquired but the recorder failed to construct; stop the
      // tracks so the MediaStream does not leak before bailing out.
      stopTracks();
      notifications.show({
        color: "red",
        message: `${t("Could not start recording")}: ${(err as { message?: string })?.message ?? String(err)}`,
      });
      setStatus("idle");
      startingRef.current = false;
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      clearTimer();
      const recordedMime = recorder.mimeType || mimeType || "audio/webm";
      const wasCanceled = canceledRef.current;

      // Stop the mic tracks and the audio meter regardless of how we got here.
      stopTracks();
      stopMeter();
      recorderRef.current = null;

      if (wasCanceled) {
        chunksRef.current = [];
        setStatus("idle");
        return;
      }

      const blob = new Blob(chunksRef.current, { type: recordedMime });
      chunksRef.current = [];

      setStatus("transcribing");
      void transcribeAudio(blob, filenameForMime(recordedMime))
        .then((text) => {
          // Whisper often returns a leading space; insert the trimmed value.
          const trimmed = text.trim();
          if (trimmed.length > 0) optionsRef.current.onText(trimmed);
          setStatus("idle");
        })
        .catch((err: unknown) => {
          // Log the full error for diagnosis (status + body + stack).
          console.error("[dictation] transcription failed", err);
          const resp = (
            err as { response?: { status?: number; data?: { message?: string } } }
          )?.response;
          const serverMsg = resp?.data?.message;
          let message: string;
          if (serverMsg && serverMsg.trim().length > 0) {
            // The server already explains the cause (e.g. provider 404, bad
            // format, STT not configured) — show it verbatim.
            message = serverMsg;
          } else if (resp?.status === 503 || resp?.status === 403) {
            message = t("Voice dictation is not configured");
          } else {
            message = `${t("Transcription failed")}: ${(err as { message?: string })?.message ?? String(err)}`;
          }
          notifications.show({ color: "red", message });
          setStatus("error");
          if (errorTimerRef.current !== null) {
            clearTimeout(errorTimerRef.current);
          }
          errorTimerRef.current = setTimeout(() => {
            errorTimerRef.current = null;
            setStatus("idle");
          }, 1500);
        });
    };

    // Notify the caller right when recording begins (before any async work) so
    // the editor can snapshot the caret position.
    try {
      optionsRef.current.onStart?.();
      recorder.start();
    } catch (err) {
      console.error("[dictation] MediaRecorder.start failed", err);
      // recorder.start() can synchronously throw (InvalidStateError /
      // NotSupportedError); clean up so the button is not left stuck and the
      // MediaStream does not leak.
      stopTracks();
      recorderRef.current = null;
      startingRef.current = false;
      notifications.show({
        color: "red",
        message: `${t("Could not start recording")}: ${(err as { message?: string })?.message ?? String(err)}`,
      });
      setStatus("idle");
      return;
    }
    setStatus("recording");
    // Recording has truly begun; release the synchronous start guard.
    startingRef.current = false;

    // Start the live audio meter on the stream we already acquired.
    startMeter(stream);

    const maxDurationMs = optionsRef.current.maxDurationMs ?? 120000;
    timerRef.current = setTimeout(() => {
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      }
    }, maxDurationMs);
  }, [status, t, clearTimer, stopTracks, startMeter, stopMeter]);

  const stop = useCallback((): void => {
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      // Normal path: onstop tears down tracks + meter and runs transcription.
      recorder.stop();
    } else {
      // No live recorder (e.g. the track ended on its own): tear everything
      // down directly so the meter/AudioContext and stream don't leak, and
      // recover the UI to idle.
      stopTracks();
      stopMeter();
      recorderRef.current = null;
      chunksRef.current = [];
      setStatus("idle");
    }
  }, [clearTimer, stopTracks, stopMeter]);

  const cancel = useCallback((): void => {
    clearTimer();
    canceledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      // onstop sees canceledRef and skips transcription; it also stops tracks
      // and the meter.
      recorder.stop();
    } else {
      stopTracks();
      stopMeter();
    }
    setStatus("idle");
  }, [clearTimer, stopTracks, stopMeter]);

  // Clean up on unmount: stop any live recorder/stream and clear the timers.
  useEffect(() => {
    return () => {
      clearTimer();
      if (errorTimerRef.current !== null) {
        clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state === "recording") {
        canceledRef.current = true;
        recorder.stop();
      }
      stopTracks();
      stopMeter();
    };
  }, [clearTimer, stopTracks, stopMeter]);

  return { status, start, stop, cancel, audioLevel };
}
