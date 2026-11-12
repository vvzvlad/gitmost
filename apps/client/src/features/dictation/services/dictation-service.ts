import api from "@/lib/api-client";

// POST the recorded audio as multipart/form-data; the server transcribes it with
// the workspace STT model and returns { text } (wrapped in the standard envelope,
// so the value is at req.data.text). `filename` only sets the part name; the
// server keys off the blob's MIME type.
export async function transcribeAudio(
  blob: Blob,
  filename = "speech.webm",
): Promise<string> {
  const form = new FormData();
  form.append("file", blob, filename);
  const req = await api.post<{ text: string }>("/ai-chat/transcribe", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return req.data.text;
}

// Waits before the second and the third attempt of transcribeWithRetry.
const RETRY_DELAYS_MS = [2000, 5000];

// A failure worth another attempt: no HTTP response at all (network error,
// timeout) or a server-side error (5xx). A 429 is not retried: the server
// blocks the user for a whole minute, longer than all retries together.
function isRetryableTranscriptionError(err: unknown): boolean {
  const response = (err as { response?: { status?: number } })?.response;
  if (!response) return true;
  const status = response.status ?? 0;
  return status >= 500 && status < 600;
}

// transcribeAudio with up to three attempts. Only retryable failures are
// retried; any other failure rejects at once. `isStale` is checked before each
// retry: once it returns true the caller no longer wants the result, so no
// further request is sent and the last error is rethrown for the caller to
// ignore.
export async function transcribeWithRetry(
  blob: Blob,
  filename: string,
  isStale: () => boolean,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transcribeAudio(blob, filename);
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryableTranscriptionError(err)) throw err;
      console.warn(
        `[dictation] transcription attempt ${attempt + 1} failed, retrying in ${delay} ms`,
        err,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (isStale()) throw err;
    }
  }
}
