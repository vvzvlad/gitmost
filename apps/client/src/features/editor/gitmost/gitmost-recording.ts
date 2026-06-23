import { Editor } from "@tiptap/core";
import { getFileUploadSizeLimit } from "@/lib/config.ts";
import { formatBytes } from "@/lib";
import { uploadAudioAction } from "@/features/editor/components/audio/upload-audio-action.tsx";

// --- gitmost native bridge: shared types & helpers ------------------------
// Stable JS-API on `window.gitmost` for the native host (gitmost.app /
// WKWebView). This module holds the parts shared between the open-page bridge
// (insertRecording, in page-editor.tsx) and the global bridge (gitmost-global-
// bridge.tsx): payload decoding/validation and the audio-insert pipeline, so
// both apply identical rules without depending on editor internals.

export interface GitmostInsertRecordingPayload {
  base64: string; // raw file bytes, base64 (no data: prefix)
  filename: string;
  mimeType: string; // must be an audio/* type
}

export interface GitmostInsertRecordingResult {
  ok: boolean;
  attachmentId?: string;
  // Machine-readable code: "no-editor" | "bad-type" | "too-large" | "insert-failed"
  error?: string;
  message?: string; // human-readable, may be surfaced by the host
}

export interface GitmostSpaceSummary {
  id: string;
  name: string;
}

export interface GitmostListSpacesResult {
  ok: boolean;
  spaces?: GitmostSpaceSummary[];
  // v1 lists only the first page of spaces; true when more exist server-side.
  truncated?: boolean;
  error?: string;
  message?: string;
}

export interface GitmostListPagesPayload {
  spaceId: string;
  parentPageId?: string;
}

export interface GitmostPageSummary {
  id: string;
  title: string;
  hasChildren: boolean;
}

export interface GitmostListPagesResult {
  ok: boolean;
  pages?: GitmostPageSummary[];
  // v1 lists only the first page of children; true when more exist server-side.
  truncated?: boolean;
  error?: string;
  message?: string;
}

export interface GitmostCreatePagePayload {
  spaceId: string;
  parentPageId?: string; // omit/null = space root
  title?: string; // default "Recording <timestamp>"
  base64: string;
  filename: string;
  mimeType: string;
}

export interface GitmostCreatePageResult {
  ok: boolean;
  pageId?: string;
  // Machine-readable code: "no-space" | "create-failed" | "editor-timeout" | "insert-failed"
  error?: string;
  message?: string;
}

// Full bridge surface exposed on `window.gitmost`. Writers attach a subset
// (Partial), so readonly/share pages and no-page states are valid.
export interface GitmostBridge {
  ready: boolean;
  version: number;
  insertRecording: (
    payload: GitmostInsertRecordingPayload,
  ) => Promise<GitmostInsertRecordingResult>;
  listSpaces: () => Promise<GitmostListSpacesResult>;
  listPages: (payload: GitmostListPagesPayload) => Promise<GitmostListPagesResult>;
  createPageWithRecording: (
    payload: GitmostCreatePagePayload,
  ) => Promise<GitmostCreatePageResult>;
}

// Estimate decoded byte length from a base64 string WITHOUT decoding it, so an
// oversized payload can be rejected before the buffer is allocated.
export function gitmostEstimateBase64Bytes(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

// Decode a base64 string into bytes in fixed-size chunks. Call recordings can
// be tens of MB; slicing on 4-char boundaries (each slice decodes to whole
// bytes, no carry) keeps each atob() call bounded. Assumes unwrapped base64
// with no embedded whitespace (per the native-host contract). Throws
// InvalidCharacterError on malformed input.
export function gitmostBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const CHUNK = 0x8000 * 4; // multiple of 4 base64 chars
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < base64.length; i += CHUNK) {
    const binary = atob(base64.slice(i, i + CHUNK));
    const bytes = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j++) {
      bytes[j] = binary.charCodeAt(j);
    }
    parts.push(bytes);
    total += bytes.length;
  }
  // Back the result with an explicit ArrayBuffer so the view is typed
  // Uint8Array<ArrayBuffer> (not ArrayBufferLike), which `new File([...])`
  // accepts as a BlobPart under the lib.dom typings.
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Decode + validate a recording payload into a File, or return an error result.
// Shared so insertRecording (open page) and createPageWithRecording (no page
// open) apply identical validation. Error codes: "bad-type" | "too-large" |
// "insert-failed".
export function gitmostDecodePayloadToFile(
  payload: GitmostInsertRecordingPayload,
): { file: File } | { error: GitmostInsertRecordingResult } {
  const { filename, mimeType } =
    payload || ({} as GitmostInsertRecordingPayload);
  let base64 = payload?.base64;

  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/")) {
    return {
      error: { ok: false, error: "bad-type", message: "Not an audio file" },
    };
  }
  if (typeof base64 !== "string" || base64.length === 0) {
    return {
      error: { ok: false, error: "insert-failed", message: "Empty payload" },
    };
  }

  // Defensively strip an accidental data:*;base64, prefix.
  const marker = base64.indexOf("base64,");
  if (base64.startsWith("data:") && marker !== -1) {
    base64 = base64.slice(marker + "base64,".length);
  }

  const sizeLimit = getFileUploadSizeLimit();
  // Reject oversized payloads before allocating the decode buffer.
  if (gitmostEstimateBase64Bytes(base64) > sizeLimit) {
    return {
      error: {
        ok: false,
        error: "too-large",
        message: `File exceeds the ${formatBytes(sizeLimit)} attachment limit`,
      },
    };
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = gitmostBase64ToBytes(base64);
  } catch (decodeErr: any) {
    return {
      error: {
        ok: false,
        error: "insert-failed",
        message: decodeErr?.message ?? "Invalid base64 payload",
      },
    };
  }

  const file = new File([bytes], filename || "recording", { type: mimeType });

  // Exact size check (the pre-decode estimate is approximate).
  if (file.size > sizeLimit) {
    return {
      error: {
        ok: false,
        error: "too-large",
        message: `File exceeds the ${formatBytes(sizeLimit)} attachment limit`,
      },
    };
  }

  return { file };
}

// Insert an already-decoded recording File into a live editor via the existing
// audio pipeline (placeholder -> POST /api/files/upload -> `audio` node,
// Yjs-synced). Returns the attachment id on success.
export async function gitmostUploadFileToEditor(
  editor: Editor,
  pageId: string,
  file: File,
): Promise<GitmostInsertRecordingResult> {
  try {
    // Insert at the cursor, falling back to the end of the document.
    const pos = editor.state.selection?.to ?? editor.state.doc.content.size;

    // uploadAudioAction returns the attachment on success and undefined when
    // the upload failed (the pipeline swallows the upload error and shows its
    // own notification).
    const attachment = (await (uploadAudioAction(
      file,
      editor,
      pos,
      pageId,
    ) as unknown as Promise<{ id?: string } | undefined>));

    if (attachment?.id) {
      return { ok: true, attachmentId: attachment.id };
    }
    return { ok: false, error: "insert-failed", message: "Upload failed" };
  } catch (err: any) {
    // Never swallow: log the raw error and surface the real reason.
    console.error("[gitmost] audio upload into editor failed", err);
    return {
      ok: false,
      error: "insert-failed",
      message: err?.response?.data?.message ?? err?.message ?? "Insert failed",
    };
  }
}

// Full insert path used by the open-page bridge (insertRecording): guard the
// editor, validate/decode the payload, then upload. Never throws — resolves to
// a result code.
export async function gitmostInsertRecordingIntoEditor(
  editor: Editor | null,
  pageId: string,
  payload: GitmostInsertRecordingPayload,
): Promise<GitmostInsertRecordingResult> {
  try {
    // Only a live, editable editor may receive a recording.
    if (!editor || editor.isDestroyed || !editor.isEditable) {
      return { ok: false, error: "no-editor", message: "No editable page open" };
    }
    const decoded = gitmostDecodePayloadToFile(payload);
    if ("error" in decoded) return decoded.error;
    return await gitmostUploadFileToEditor(editor, pageId, decoded.file);
  } catch (err: any) {
    // The bridge must never throw — surface any unexpected failure as a code.
    console.error("[gitmost] insertRecording failed", err);
    return {
      ok: false,
      error: "insert-failed",
      message: err?.response?.data?.message ?? err?.message ?? "Insert failed",
    };
  }
}
