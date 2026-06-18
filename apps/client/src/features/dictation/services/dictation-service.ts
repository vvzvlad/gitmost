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
