import { describe, it, expect } from "vitest";
import {
  classifyGetUserMediaError,
  classifyTranscriptionError,
  dictationErrorMessage,
  resolveUnavailableLabel,
  isDictationSupported,
} from "./dictation-status";

// Unit tests for the shared dictation-status resolvers (dictation-status.ts).
// Both dictation hooks and the mic button form their user-facing strings here,
// so a regression in the classification or message mapping would silently swap
// what a user reads when the mic is grey or a recording fails. A fake `t`
// returns its key verbatim so we assert the exact i18n key each branch selects.
const t = (k: string) => k;

describe("classifyGetUserMediaError", () => {
  it("maps NotAllowedError / SecurityError to mic-denied", () => {
    expect(classifyGetUserMediaError({ name: "NotAllowedError" })).toBe(
      "mic-denied",
    );
    expect(classifyGetUserMediaError({ name: "SecurityError" })).toBe(
      "mic-denied",
    );
  });

  it("maps NotFoundError / OverconstrainedError to no-mic", () => {
    expect(classifyGetUserMediaError({ name: "NotFoundError" })).toBe("no-mic");
    expect(classifyGetUserMediaError({ name: "OverconstrainedError" })).toBe(
      "no-mic",
    );
  });

  it("maps NotReadableError / AbortError to mic-in-use", () => {
    expect(classifyGetUserMediaError({ name: "NotReadableError" })).toBe(
      "mic-in-use",
    );
    expect(classifyGetUserMediaError({ name: "AbortError" })).toBe(
      "mic-in-use",
    );
  });

  it("maps anything else / undefined to unknown", () => {
    expect(classifyGetUserMediaError({ name: "WeirdError" })).toBe("unknown");
    expect(classifyGetUserMediaError(undefined)).toBe("unknown");
    expect(classifyGetUserMediaError({})).toBe("unknown");
  });
});

describe("classifyTranscriptionError", () => {
  it("returns the verbatim server message when present", () => {
    const err = { response: { status: 500, data: { message: "provider 404" } } };
    expect(classifyTranscriptionError(err)).toEqual({
      code: "transcription-failed",
      serverMessage: "provider 404",
    });
  });

  it("maps 503 / 403 (no server message) to stt-not-configured", () => {
    expect(classifyTranscriptionError({ response: { status: 503 } })).toEqual({
      code: "stt-not-configured",
    });
    expect(classifyTranscriptionError({ response: { status: 403 } })).toEqual({
      code: "stt-not-configured",
    });
  });

  it("falls back to transcription-failed with no server message otherwise", () => {
    expect(classifyTranscriptionError({ response: { status: 500 } })).toEqual({
      code: "transcription-failed",
    });
    expect(classifyTranscriptionError(new Error("network"))).toEqual({
      code: "transcription-failed",
    });
    // Blank server message is ignored (does not win as verbatim text).
    expect(
      classifyTranscriptionError({ response: { data: { message: "   " } } }),
    ).toEqual({ code: "transcription-failed" });
  });
});

describe("dictationErrorMessage", () => {
  it("maps each code to the expected i18n key", () => {
    expect(dictationErrorMessage("mic-denied", t)).toBe(
      "Microphone access denied",
    );
    expect(dictationErrorMessage("no-mic", t)).toBe("No microphone found");
    expect(dictationErrorMessage("mic-in-use", t)).toBe(
      "Microphone is unavailable or already in use",
    );
    expect(dictationErrorMessage("no-media-devices", t)).toBe(
      "Audio recording is not available in this browser/context",
    );
    expect(dictationErrorMessage("stt-not-configured", t)).toBe(
      "Voice dictation is not configured",
    );
    expect(dictationErrorMessage("transcription-failed", t)).toBe(
      "Transcription failed",
    );
    expect(dictationErrorMessage("recorder-failed", t)).toBe(
      "Could not start recording",
    );
    expect(dictationErrorMessage("vad-init-failed", t)).toBe(
      "Could not start recording",
    );
    expect(dictationErrorMessage("unknown", t)).toBe(
      "Could not start recording",
    );
  });

  it("returns the server message verbatim for transcription-failed (not the t key)", () => {
    expect(
      dictationErrorMessage("transcription-failed", t, {
        serverMessage: "quota exceeded",
      }),
    ).toBe("quota exceeded");
  });

  it("appends the detail to recorder-failed / unknown", () => {
    expect(
      dictationErrorMessage("recorder-failed", t, { detail: "boom" }),
    ).toBe("Could not start recording: boom");
    expect(dictationErrorMessage("unknown", t, { detail: "nope" })).toBe(
      "Could not start recording: nope",
    );
  });

  it("appends the detail to transcription-failed when there is no server message", () => {
    expect(
      dictationErrorMessage("transcription-failed", t, { detail: "timeout" }),
    ).toBe("Transcription failed: timeout");
  });
});

describe("resolveUnavailableLabel", () => {
  it("maps each reason to its expected i18n key", () => {
    expect(resolveUnavailableLabel("connecting", t)).toBe(
      "Dictation becomes available once the page finishes connecting",
    );
    expect(resolveUnavailableLabel("offline", t)).toBe(
      "No connection to the collaboration server — dictation unavailable",
    );
    expect(resolveUnavailableLabel("read-only", t)).toBe(
      "This page is read-only",
    );
    expect(resolveUnavailableLabel("unsupported", t)).toBe(
      "Audio recording is not available in this browser/context",
    );
  });
});

describe("isDictationSupported", () => {
  it("returns a boolean", () => {
    expect(typeof isDictationSupported()).toBe("boolean");
  });
});
