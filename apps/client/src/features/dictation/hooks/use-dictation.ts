import { useCallback, useEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { transcribeAudio } from "@/features/dictation/services/dictation-service";

export type DictationStatus = "idle" | "recording" | "transcribing" | "error";

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

      // Stop the mic tracks regardless of how we got here.
      stopTracks();
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

    const maxDurationMs = optionsRef.current.maxDurationMs ?? 120000;
    timerRef.current = setTimeout(() => {
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      }
    }, maxDurationMs);
  }, [status, t, clearTimer, stopTracks]);

  const stop = useCallback((): void => {
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
    }
  }, [clearTimer]);

  const cancel = useCallback((): void => {
    clearTimer();
    canceledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      // onstop sees canceledRef and skips transcription; it also stops tracks.
      recorder.stop();
    } else {
      stopTracks();
    }
    setStatus("idle");
  }, [clearTimer, stopTracks]);

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
    };
  }, [clearTimer, stopTracks]);

  return { status, start, stop, cancel };
}
