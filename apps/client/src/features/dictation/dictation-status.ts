// Single source of truth for "why dictation is unavailable" and "why it failed".
// Both dictation hooks and the mic button pull their user-facing strings from
// the resolvers here so the wording lives in exactly one place.

export type DictationUnavailableReason =
  | "connecting"
  | "offline"
  | "read-only"
  | "unsupported";

export type DictationErrorCode =
  | "no-media-devices"
  | "mic-denied"
  | "no-mic"
  | "mic-in-use"
  | "recorder-failed"
  | "vad-init-failed"
  | "stt-not-configured"
  | "transcription-failed"
  | "unknown";

// True if this browser/context can record audio.
export function isDictationSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

// getUserMedia / VAD.start rejection -> code, by DOMException .name.
export function classifyGetUserMediaError(err: unknown): DictationErrorCode {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "mic-denied";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "no-mic";
  if (name === "NotReadableError" || name === "AbortError") return "mic-in-use";
  return "unknown";
}

// Transcription HTTP failure -> code (+ verbatim server message when present).
export function classifyTranscriptionError(err: unknown): {
  code: DictationErrorCode;
  serverMessage?: string;
} {
  const resp = (
    err as { response?: { status?: number; data?: { message?: string } } }
  )?.response;
  const serverMessage = resp?.data?.message;
  if (serverMessage && serverMessage.trim().length > 0)
    return { code: "transcription-failed", serverMessage };
  if (resp?.status === 503 || resp?.status === 403)
    return { code: "stt-not-configured" };
  return { code: "transcription-failed" };
}

type TFn = (key: string) => string;

// Code -> user text. The ONE place runtime error strings are formed.
// serverMessage (verbatim) wins for transcription-failed; detail is appended
// to the generic "could not start"/"transcription failed" strings.
export function dictationErrorMessage(
  code: DictationErrorCode,
  t: TFn,
  extra?: { serverMessage?: string; detail?: string },
): string {
  const detail = extra?.detail;
  switch (code) {
    case "mic-denied":
      return t("Microphone access denied");
    case "no-mic":
      return t("No microphone found");
    case "mic-in-use":
      return t("Microphone is unavailable or already in use");
    case "no-media-devices":
      return t("Audio recording is not available in this browser/context");
    case "stt-not-configured":
      return t("Voice dictation is not configured");
    case "transcription-failed":
      if (extra?.serverMessage && extra.serverMessage.trim().length > 0)
        return extra.serverMessage;
      return `${t("Transcription failed")}${detail ? `: ${detail}` : ""}`;
    case "recorder-failed":
    case "vad-init-failed":
    case "unknown":
    default:
      return `${t("Could not start recording")}${detail ? `: ${detail}` : ""}`;
  }
}

// Unavailable reason -> tooltip text (the ONE place these strings are formed).
export function resolveUnavailableLabel(
  r: DictationUnavailableReason,
  t: TFn,
): string {
  switch (r) {
    case "connecting":
      return t("Dictation becomes available once the page finishes connecting");
    case "offline":
      return t(
        "No connection to the collaboration server — dictation unavailable",
      );
    case "read-only":
      return t("This page is read-only");
    case "unsupported":
    default:
      return t("Audio recording is not available in this browser/context");
  }
}
