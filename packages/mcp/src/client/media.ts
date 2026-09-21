// Auto-split from client.ts (issue #450). Mixin over the shared client context.
// Bodies are VERBATIM from the original DocmostClient; only the enclosing class
// changed to a mixin factory. See client/context.ts for the shared base.
import type { GConstructor, DocmostClientContext } from "./context.js";
import FormData from "form-data";
import axios, { AxiosInstance } from "axios";
import { basename, extname } from "path";
import * as mime from "mime-types";
import {
  updatePageContentRealtime,
  replacePageContent,
  markdownToProseMirror,
  markdownToProseMirrorCanonical,
  mutatePageContent,
  assertYjsEncodable,
  MutationResult,
} from "../lib/collaboration.js";
import { withPageLock, isUuid } from "../lib/page-lock.js";
import { diffDocs, summarizeChange } from "../lib/diff.js";
import {
  blockText,
  walk,
  getList,
  insertMarkerAfter,
  setCalloutRange,
  noteItem,
  mdToInlineNodes,
  commentsToFootnotes,
  canonicalizeFootnotes,
  insertInlineFootnote,
  mergeFootnoteDefinitions,
} from "../lib/transforms.js";

// Supported image types, kept as two lookup tables so both a local file
// extension and a remote Content-Type can be mapped to the same canonical set.
const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

// The MIME types that render as an INLINE image node in the Docmost editor.
// Anything else uploaded via uploadFile becomes a generic `attachment` block
// (a download card). Defined explicitly (not derived from MIME_TO_EXT) so the
// image-vs-attachment decision is a stable, auditable allowlist independent of
// the extension<->mime maps above (issue #608).
const RENDERABLE_IMAGE_MIMES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

// Default upload byte ceiling for uploadFile (issue #608). The /mcp POST body is
// bounded by the server's global Fastify `HTTP_JSON_BODY_LIMIT` (default 25 MiB,
// main.ts) and base64 inflates the payload ~1.333×, so the effective on-disk file
// ceiling is ≈ HTTP_JSON_BODY_LIMIT × 0.74 ≈ 18 MiB. Overridable (but never
// disable-able) via MCP_MAX_UPLOAD_BYTES — see resolveMaxUploadBytes.
const DEFAULT_MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

/**
 * Resolve the uploadFile byte ceiling from the environment, falling back to the
 * shared default. Parsed exactly like resolveCommentSignalDebounceMs
 * (index.ts): a non-finite / non-positive value keeps the default, so a bad env
 * var can never DISABLE the size limit (there is no "unlimited" setting). Read
 * fresh on each call so a test/rollback can change it without reloading.
 */
function resolveMaxUploadBytes(): number {
  const parsed = parseInt(process.env.MCP_MAX_UPLOAD_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_UPLOAD_BYTES;
}

// Public method surface of MediaMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements IMediaMixin` fails to compile on drift.
export interface IMediaMixin {
  uploadImage(pageId: string, url: string): any;
  insertImage(pageId: string, url: string, opts?: { align?: "left" | "center" | "right"; alt?: string; replaceText?: string; afterText?: string; }): any;
  replaceImage(pageId: string, oldAttachmentId: string, url: string, opts?: { align?: "left" | "center" | "right"; alt?: string }): any;
  uploadFile(pageId: string, content: string, fileName: string, opts?: {
    mime?: string;
    insert?: boolean;
    as?: "image" | "file";
    align?: "left" | "center" | "right";
    alt?: string;
    position?: "before" | "after" | "append";
    anchorText?: string;
    anchorNodeId?: string;
  }): Promise<{
    uploaded: true;
    attachmentId: string;
    fileName: string;
    fileSize: number;
    mime: string;
    src: string;
    node: any;
    inserted: boolean;
    placement?: "before" | "after" | "append";
    verify?: any;
    insertError?: string;
  }>;
  fetchAttachmentBytes(src: string): Promise<{ buffer: Buffer; mime: string }>;
}

export function MediaMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & IMediaMixin> & TBase {
  abstract class MediaMixin extends Base implements IMediaMixin {
  // --- Image upload / embedding ---

  /** Map a Content-Type string to a supported MIME type, or null if unsupported. */
  protected supportedImageMime(ct: string): string | null {
    return MIME_TO_EXT[ct] ? ct : null;
  }

  /**
   * Download a remote image from a caller-supplied URL and resolve its bytes,
   * MIME and a filename.
   *
   * SSRF / RESOURCE TRUST BOUNDARY: the URL comes from the MCP caller and is
   * fetched BY THE SERVER, so it must be guarded before and after the request.
   * The guards mirror the local-file trust boundary in uploadImage:
   *   - scheme allowlist (http/https only) — rejects file:, data:, ftp:, etc.,
   *     so the caller cannot use this path to read local files or other schemes;
   *   - a size cap enforced both via axios maxContentLength/maxBodyLength AND a
   *     post-download buffer.length re-check (defends against a missing/lying
   *     Content-Length), so a huge response cannot exhaust memory;
   *   - a 30s timeout. The timeout matters because replaceImage holds the
   *     per-page lock across this upload, so a hung download would wedge the
   *     lock for that page.
   * We deliberately do NOT block private IP ranges: the MCP caller is already
   * trusted to read arbitrary host files via the filePath path, so the marginal
   * trust granted by fetching internal URLs is comparable, and blocking would
   * break legitimate internal-image use.
   */
  protected async fetchRemoteImage(
    url: string,
    maxBytes: number,
  ): Promise<{ buffer: Buffer; mime: string; fileName: string }> {
    // Scheme allowlist first — cheapest guard, and rejects non-http(s) schemes
    // (file:, data:, ftp:, ...) before any network request is made.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e: any) {
      throw new Error(`Invalid image URL "${url}": ${e.message}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `unsupported image URL scheme "${parsed.protocol}"; only http and https are allowed`,
      );
    }

    let response;
    try {
      response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 30000,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        headers: { Accept: "image/*" },
      });
    } catch (error) {
      // Keep the thrown message free of the raw response body (it may echo
      // server internals); surface only status/statusText. The full body is
      // logged under DEBUG for diagnostics.
      if (axios.isAxiosError(error)) {
        if (process.env.DEBUG) {
          console.error(
            "Image download failed; response body:",
            JSON.stringify(error.response?.data),
          );
        }
        throw new Error(
          `Image download failed for "${url}": ${error.response?.status ?? ""} ${error.response?.statusText ?? error.message}`.trim(),
        );
      }
      throw error;
    }

    // axios returns an ArrayBuffer for responseType: "arraybuffer".
    const buffer = Buffer.from(response.data);
    // Re-check the size: maxContentLength relies on Content-Length, which may be
    // absent or lie, so guard against the actual byte count too.
    if (buffer.length === 0) {
      throw new Error(`Empty image response from "${url}"`);
    }
    if (buffer.length > maxBytes) {
      throw new Error(
        `Image too large: ${buffer.length} bytes exceeds the ${maxBytes}-byte cap`,
      );
    }

    // Resolve MIME: prefer the response Content-Type (strip any "; charset=..."
    // parameter, lowercase, trim) mapped through the supported set; if the
    // header is generic/missing/unsupported, fall back to the URL path
    // extension via the existing extension->MIME logic.
    const rawCt = response.headers?.["content-type"];
    let mime: string | null = null;
    if (typeof rawCt === "string" && rawCt.length > 0) {
      const ct = rawCt.split(";")[0].trim().toLowerCase();
      mime = this.supportedImageMime(ct);
    }
    if (!mime) {
      // Fall back to the URL path extension. Use the pathname so the query
      // string never contaminates the extension lookup.
      const ext = extname(parsed.pathname).toLowerCase();
      mime = EXT_TO_MIME[ext] ?? null;
    }
    if (!mime) {
      throw new Error(
        `cannot determine supported image type for "${url}"; supported: png, jpg, jpeg, gif, webp, svg`,
      );
    }

    // Build a filename from the URL path basename (ignore the query string),
    // defaulting to "image" when empty, and ensure it ends with the canonical
    // extension for the resolved MIME (append it when missing/mismatched).
    const canonicalExt = MIME_TO_EXT[mime];
    let fileName = basename(parsed.pathname) || "image";
    if (extname(fileName).toLowerCase() !== canonicalExt) {
      fileName += canonicalExt;
    }

    return { buffer, mime, fileName };
  }

  /** Build a Docmost ProseMirror image node from an uploaded attachment. */
  protected buildImageNode(
    att: { id: string; fileName: string; fileSize?: number },
    align?: "left" | "center" | "right",
    alt?: string,
  ): any {
    // Clean file URL, matching Docmost's native behaviour. No cache-busting
    // query: the server serves the bare URL correctly, and replacement creates
    // a new attachment id (a new URL) which busts caches naturally.
    const src = `/api/files/${att.id}/${att.fileName}`;
    const node: any = {
      type: "image",
      attrs: {
        src,
        attachmentId: att.id,
        // Default to null when the server omits fileSize so the attr is never
        // undefined (undefined would be dropped on serialization / break the
        // ProseMirror image schema which expects size present).
        size: att.fileSize ?? null,
        align: align || "center",
        width: null,
      },
    };
    if (alt) node.attrs.alt = alt;
    return node;
  }

  /**
   * Upload an arbitrary file from caller-supplied base64 BYTES as a page
   * attachment (any type), returning the attachment metadata plus a
   * ready-to-insert ProseMirror node; optionally insert that node into the page
   * in one step. This is the byte-fed counterpart to uploadImage/insertImage
   * (which only accept an http(s) URL the SERVER must fetch): here the caller
   * ships the bytes, so no public URL is required and non-image types are
   * supported. MCP-only (issue #608).
   *
   * Ordering is load-bearing (orphan avoidance + validate-before-upload):
   *  - pageId is resolved to its canonical UUID FIRST — a slugId sent to
   *    /files/upload lands raw in the DB `uuid` column, the DB error is
   *    swallowed, and the file is already on disk = an orphan. Resolving first
   *    also catches a non-existent page before anything is uploaded.
   *  - insert-anchor options and the base64 payload are fully validated BEFORE
   *    the multipart POST, so a bad request never leaves an unreferenced file.
   */
  async uploadFile(
    pageId: string,
    content: string,
    fileName: string,
    opts: {
      mime?: string;
      insert?: boolean;
      as?: "image" | "file";
      align?: "left" | "center" | "right";
      alt?: string;
      position?: "before" | "after" | "append";
      anchorText?: string;
      anchorNodeId?: string;
    } = {},
  ) {
    // STEP 1: auth.
    await this.ensureAuthenticated();

    // STEP 2: resolve pageId -> canonical UUID BEFORE upload. Use the UUID for
    // BOTH the upload and the insert. A slugId in /files/upload -> raw slug in
    // the uuid column -> swallowed DB error -> orphan file on disk (#260/#608).
    const pageUuid = await this.resolvePageId(pageId);

    // STEP 3: validate insert-anchor options BEFORE upload. before/after require
    // EXACTLY ONE of anchorText / anchorNodeId (insertNode enforces the same, but
    // checking here means a bad anchor request never leaves an orphan file).
    const insert = opts.insert ?? false;
    const position = opts.position ?? "append";
    if (insert && (position === "before" || position === "after")) {
      const hasText =
        typeof opts.anchorText === "string" && opts.anchorText.length > 0;
      const hasId =
        typeof opts.anchorNodeId === "string" && opts.anchorNodeId.length > 0;
      if (hasText === hasId) {
        throw new Error(
          `uploadFile: position "${position}" requires exactly one of anchorText or anchorNodeId`,
        );
      }
    }

    // STEP 4: normalize + validate the base64 payload.
    // 4a. Strip a `data:<mediatype>;base64,` prefix ONLY when it fully matches
    //     (and capture the embedded mime hint from the bare media type). A valid
    //     data URI may carry media-type PARAMETERS before `;base64` (e.g.
    //     `data:text/plain;charset=utf-8;base64,...`), so allow zero or more
    //     `;param` segments and take only the media type (before the first `;`)
    //     as the hint. If a `data:` URI is present but NOT base64-encoded, reject
    //     it: otherwise its non-base64 tail would decode silently to garbage bytes.
    let payload = content;
    let dataUriMimeHint: string | null = null;
    const dataUriMatch = /^data:([^;,]*)(?:;[^;,]*)*;base64,/.exec(content);
    if (dataUriMatch) {
      dataUriMimeHint = dataUriMatch[1] ? dataUriMatch[1].trim() : null;
      payload = content.slice(dataUriMatch[0].length);
    } else if (/^data:/.test(content)) {
      throw new Error(
        "uploadFile: `content` is a data: URI that is not base64-encoded; " +
          "expected data:<mime>;base64,<base64> or a bare base64 string",
      );
    }
    // 4b. Strip ALL whitespace BEFORE the charset check so line-wrapped base64
    //     (valid) is accepted.
    const clean = payload.replace(/\s/g, "");
    // 4c. Validate the base64 charset AND 4-byte alignment. Node's decoder
    //     silently TRUNCATES a misaligned / non-base64 string to garbage, so
    //     both guards are required.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
      throw new Error(
        "uploadFile: `content` is not valid base64 (unexpected characters)",
      );
    }
    if (clean.length % 4 !== 0) {
      throw new Error(
        "uploadFile: `content` is not valid base64 (length is not a multiple of 4)",
      );
    }
    const buffer = Buffer.from(clean, "base64");
    if (buffer.length === 0) {
      throw new Error("uploadFile: `content` is empty (no bytes to upload)");
    }

    // STEP 5: enforce the size ceiling BEFORE calling the server. The /mcp POST
    // body is bounded by the server's HTTP_JSON_BODY_LIMIT and base64 inflates
    // the payload ~1.333×, so name that knob and the math in the error.
    const MAX = resolveMaxUploadBytes();
    if (buffer.length > MAX) {
      throw new Error(
        `uploadFile: file is ${buffer.length} bytes, over the ${MAX}-byte limit. ` +
          `The /mcp POST body is bounded by the server's HTTP_JSON_BODY_LIMIT ` +
          `(default 25 MiB); base64 inflates the payload ~1.333×, so the ` +
          `effective file ceiling is ≈ HTTP_JSON_BODY_LIMIT × 0.74 (~18 MiB).`,
      );
    }

    // STEP 6: sanitize the file name: non-empty after trim, and basename only
    // (strip any path separators the caller may have included).
    const trimmedName = fileName.trim();
    if (!trimmedName) {
      throw new Error("uploadFile: `fileName` must be a non-empty string");
    }
    let finalFileName = basename(trimmedName);

    // STEP 7: resolve the effective MIME. The SERVER derives the served
    // Content-Type from the file-name EXTENSION (getMimeType = mime.contentType
    // (extname), file.helper.ts), IGNORING the multipart contentType — so the
    // extension is what actually matters. Mirror uploadImage's canonical-ext
    // append: if a desired mime has a canonical extension the name lacks, append
    // it, so the server serves the intended type. Effective mime is then derived
    // FROM the (possibly extended) name for exact parity with the server, with
    // the desired mime and octet-stream as fallbacks.
    const desiredMime = opts.mime || dataUriMimeHint || null;
    if (desiredMime) {
      const canonicalExt = mime.extension(desiredMime); // e.g. "pdf" (no dot)
      if (canonicalExt) {
        const dotted = "." + canonicalExt;
        if (extname(finalFileName).toLowerCase() !== dotted) {
          finalFileName += dotted;
        }
      }
    }
    const mimeFromExt = mime.contentType(extname(finalFileName)); // string|false
    const effMime = mimeFromExt || desiredMime || "application/octet-stream";

    // STEP 8: upload the bytes. uploadAttachmentBuffer reuses uploadImage's
    // fresh-FormData + one-shot 401/403 re-auth handling.
    const att = await this.uploadAttachmentBuffer(
      pageUuid,
      buffer,
      finalFileName,
      effMime,
    );

    // STEP 9: build src + node from the SERVER-RETURNED file name (never the raw
    // input: a `/` in the name would break the /files/:fileId/:fileName route ->
    // 404). Image mimes render inline; everything else becomes an attachment card.
    const src = `/api/files/${att.id}/${att.fileName}`;
    const nodeKind =
      opts.as ?? (RENDERABLE_IMAGE_MIMES.has(effMime) ? "image" : "file");
    const node: any =
      nodeKind === "image"
        ? this.buildImageNode(
            { id: att.id, fileName: att.fileName, fileSize: att.fileSize },
            opts.align,
            opts.alt,
          )
        : {
            type: "attachment",
            attrs: {
              url: src,
              name: att.fileName,
              mime: effMime,
              size: att.fileSize ?? null,
              attachmentId: att.id,
            },
          };

    const base = {
      uploaded: true as const,
      attachmentId: att.id,
      fileName: att.fileName,
      fileSize: att.fileSize,
      mime: effMime,
      src,
      node,
    };

    // STEP 10: upload-only — return the node for the caller to insert later.
    if (!insert) {
      return { ...base, inserted: false };
    }

    // STEP 11: insert the node in the SAME call. Never lose the upload: if the
    // insert throws (e.g. anchor not found), report inserted:false + insertError
    // while still returning the attachment id / src / node. insertNode returns
    // `position` (not `placement`) — map it.
    try {
      const r = await this.insertNode(
        pageUuid,
        { node },
        {
          position,
          anchorText: opts.anchorText,
          anchorNodeId: opts.anchorNodeId,
        },
      );
      return {
        ...base,
        inserted: true,
        placement: (r?.position ?? position) as "before" | "after" | "append",
        verify: r?.verify,
      };
    } catch (e: any) {
      return { ...base, inserted: false, insertError: e?.message ?? String(e) };
    }
  }

  /**
   * Download a remote image from an http(s) URL and upload it as an attachment
   * of a page, returning the attachment metadata plus a ready-to-insert
   * ProseMirror image node. Local file paths are intentionally not supported:
   * the MCP caller is a remote AI with no access to this server's filesystem.
   */
  async uploadImage(pageId: string, url: string) {
    await this.ensureAuthenticated();

    const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB

    // Fetch + validate the remote image (scheme allowlist, size cap, timeout).
    // See fetchRemoteImage for the SSRF / resource trust boundary.
    const fetched = await this.fetchRemoteImage(url, MAX_IMAGE_BYTES);
    const fileBuffer = fetched.buffer;
    const mime = fetched.mime;
    const fileName = fetched.fileName;

    // Build a FRESH FormData for every send attempt. A FormData body is a
    // single-use stream that is CONSUMED on the first send, so it cannot be
    // replayed by this.client's response interceptor (replaying a consumed
    // stream fails with 'socket hang up'). Multipart re-auth is therefore done
    // here with bare axios and an explicit one-shot 401/403 retry that rebuilds
    // the body. Field order matters: text fields must precede the file part so
    // the server reads them; the server always generates a fresh attachment id.
    const buildForm = () => {
      const form = new FormData();
      form.append("pageId", pageId);
      form.append("file", fileBuffer, {
        filename: fileName,
        contentType: mime,
      });
      return form;
    };

    // Local name distinct from the `url` parameter (the source image URL): this
    // is the /files/upload endpoint we POST the multipart body to.
    const uploadUrl = `${this.apiUrl}/files/upload`;
    let response;
    try {
      // Call buildForm() ONCE per attempt and reuse the instance for both
      // getHeaders() and the body so the Content-Type boundary matches the body.
      const form = buildForm();
      // Read the Authorization header from this.client's defaults (set by
      // login(), only ever deleted — never set to null) instead of building
      // `Bearer ${this.token}`: a concurrent JSON 401 can null this.token
      // mid-flight, which would otherwise produce a literal "Bearer null".
      // ensureAuthenticated() above guarantees login() ran, so the default
      // header exists here. A 60s timeout keeps a hung upload from wedging the
      // per-page lock (replaceImage holds withPageLock across this call).
      response = await axios.post(uploadUrl, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: this.client.defaults.headers.common["Authorization"],
        },
        timeout: 60000,
      });
    } catch (error) {
      // On an expired-token auth error, re-login and retry exactly once with a
      // freshly-rebuilt FormData (the previous one was already consumed).
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        await this.login();
        const form2 = buildForm();
        response = await axios.post(uploadUrl, form2, {
          headers: {
            ...form2.getHeaders(),
            Authorization: this.client.defaults.headers.common["Authorization"],
          },
          timeout: 60000,
        });
      } else if (axios.isAxiosError(error)) {
        // Keep the thrown message free of the raw response body (it may echo
        // request data or server internals); surface only status/statusText.
        // The full body is logged under DEBUG for diagnostics.
        if (process.env.DEBUG) {
          console.error(
            "Image upload failed; response body:",
            JSON.stringify(error.response?.data),
          );
        }
        throw new Error(
          `Image upload failed: ${error.response?.status} ${error.response?.statusText}`,
        );
      } else {
        throw error;
      }
    }
    // The attachment may arrive bare or wrapped in a { data } envelope.
    const att = response.data?.data ?? response.data;
    if (!att?.id || !att?.fileName) {
      throw new Error(
        "Unexpected /files/upload response: " + JSON.stringify(response.data),
      );
    }

    // Some Docmost versions omit fileSize from the upload response. Fall back
    // to the fetched byte length (the bytes we just uploaded) so callers never
    // get an undefined size.
    const resolvedSize = att.fileSize ?? fileBuffer.length;

    return {
      attachmentId: att.id,
      fileName: att.fileName,
      fileSize: resolvedSize,
      src: `/api/files/${att.id}/${att.fileName}`,
      imageNode: this.buildImageNode({ ...att, fileSize: resolvedSize }),
    };
  }

  /**
   * Upload an image from a web (http/https) URL and insert it into a page in
   * one step.
   * By default the image is appended at the end. With replaceText, the first
   * top-level block whose text contains the string is replaced; with afterText,
   * the image is inserted right after the first matching block. All other
   * block ids are preserved (only one top-level block is added or swapped).
   */
  async insertImage(
    pageId: string,
    url: string,
    opts: {
      align?: "left" | "center" | "right";
      alt?: string;
      replaceText?: string;
      afterText?: string;
    } = {},
  ) {
    const up = await this.uploadImage(pageId, url);
    // Reuse the node from uploadImage (clean /api/files/<id>/<file> src), then
    // apply align/alt onto a shallow attrs copy.
    const node: any = { ...up.imageNode, attrs: { ...up.imageNode.attrs } };
    if (opts.align) node.attrs.align = opts.align;
    if (opts.alt) node.attrs.alt = opts.alt;

    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260). The
    // uploadImage /files/upload call above keeps the agent-supplied id.
    const pageUuid = await this.resolvePageId(pageId);

    // Recursively collect the plain text of a top-level block.
    const blockText = (n: any): string => {
      let out = "";
      if (n.type === "text") out += n.text || "";
      for (const child of n.content || []) out += blockText(child);
      return out;
    };

    // Insert into the LIVE synced document, not the debounced REST snapshot, so
    // concurrent edits/comments/images are preserved and parallel insertImage
    // calls (serialized by the per-page lock) each see the previous insertion.
    let placement: "replaced" | "after" | "appended" | undefined;
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        const doc =
          liveDoc && liveDoc.type === "doc"
            ? liveDoc
            : { type: "doc", content: [] };
        if (!Array.isArray(doc.content)) doc.content = [];

        if (opts.replaceText) {
          // Ambiguity guard (mirrors editPageText): count matching top-level
          // blocks first, so a non-unique fragment cannot silently replace the
          // wrong block (e.g. text that also appears inside a callout/table).
          const matches = doc.content.filter((b: any) =>
            blockText(b).includes(opts.replaceText!),
          );
          if (matches.length === 0) {
            throw new Error(`replaceText not found: "${opts.replaceText}"`);
          }
          if (matches.length > 1) {
            throw new Error(
              `replaceText "${opts.replaceText}" matches ${matches.length} blocks; use a longer unique fragment`,
            );
          }
          const idx = doc.content.findIndex((b: any) =>
            blockText(b).includes(opts.replaceText!),
          );
          // Data-loss guard: replaceText swaps the WHOLE top-level block, so if
          // the fragment only appears nested inside a container (table, callout,
          // list, blockquote) the entire structure would be destroyed. Refuse
          // when the matched block is a container rather than a leaf
          // paragraph/heading and point the caller at a safer tool.
          const CONTAINER_TYPES = new Set([
            "table",
            "callout",
            "bulletList",
            "orderedList",
            "taskList",
            "blockquote",
          ]);
          const matchedBlock = doc.content[idx];
          if (matchedBlock && CONTAINER_TYPES.has(matchedBlock.type)) {
            throw new Error(
              `replaceText matched a ${matchedBlock.type} container block; replacing it would destroy the whole structure. ` +
                `Use afterText to insert near it, or updatePageJson for surgical edits.`,
            );
          }
          doc.content.splice(idx, 1, node);
          placement = "replaced";
        } else if (opts.afterText) {
          // Ambiguity guard (mirrors editPageText): refuse a non-unique fragment.
          const matches = doc.content.filter((b: any) =>
            blockText(b).includes(opts.afterText!),
          );
          if (matches.length === 0) {
            throw new Error(`afterText not found: "${opts.afterText}"`);
          }
          if (matches.length > 1) {
            throw new Error(
              `afterText "${opts.afterText}" matches ${matches.length} blocks; use a longer unique fragment`,
            );
          }
          const idx = doc.content.findIndex((b: any) =>
            blockText(b).includes(opts.afterText!),
          );
          doc.content.splice(idx + 1, 0, node);
          placement = "after";
        } else {
          doc.content.push(node);
          placement = "appended";
        }

        return doc;
      },
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    return {
      success: true,
      pageId,
      attachmentId: up.attachmentId,
      src: up.src,
      placement,
      verify: mutation.verify,
    };
  }

  /**
   * Replace an existing image in a page with a new image fetched from a web
   * (http/https) URL. Uploads the new file as a brand-new attachment, which
   * yields a fresh clean URL that both renders correctly and busts browser
   * caches (the URL changed). Finds every image node
   * whose attrs.attachmentId === oldAttachmentId (recursively, incl. nodes nested
   * in callouts/tables) and repoints its src/attachmentId/size, preserving
   * comments, alignment and alt. Operates on the live collab document so comments
   * and concurrent edits are preserved. Throws if no matching image is found.
   *
   * The OLD attachment is left in place as an unreferenced orphan: Docmost
   * exposes NO HTTP API to delete a single content attachment (verified against
   * the attachment controller/service and by probing the live API — deletion
   * happens only by cascade when the page, space or user is removed). This is the
   * same outcome as Docmost's own editor when an image is removed/replaced.
   * In-place byte overwrite is deliberately NOT used because some Docmost
   * versions corrupt the attachment (HTTP 500) when its bytes are overwritten.
   */
  async replaceImage(
    pageId: string,
    oldAttachmentId: string,
    url: string,
    opts: { align?: "left" | "center" | "right"; alt?: string } = {},
  ) {
    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260). The
    // page lock must ALSO key on the UUID so this operation serializes against
    // other writes to the same page (mutatePageContent now locks by the resolved
    // UUID too); locking by the raw slugId here would desync the mutex key and
    // reopen the TOCTOU/orphan-attachment window the lock closes. uploadImage
    // keeps the agent-supplied id (it hits REST, not the collab doc).
    const pageUuid = await this.resolvePageId(pageId);

    // Hold ONE per-page lock for the WHOLE operation (scan -> upload -> write).
    // Previously the scan and the write were two separate mutatePageContent
    // calls, each acquiring + releasing the lock, with the upload happening in
    // the UNLOCKED gap between them. A concurrent op could interleave there: it
    // could remove the target image so the write pass matches nothing, leaving
    // the freshly-uploaded attachment as an un-deletable orphan (Docmost has no
    // API to delete a single content attachment). Acquiring the lock once and
    // using the non-locking collab helper inside (the per-page mutex is NOT
    // reentrant, so the self-locking mutatePageContent would deadlock here)
    // closes that TOCTOU window. uploadImage hits /files/upload over plain HTTP
    // and does not touch the page lock, so it is safe to call while held.
    return withPageLock(pageUuid, async () => {
      // STEP 1: read-only live check. Scan the live document for any image node
      // matching oldAttachmentId BEFORE uploading anything, so a wrong/stale id
      // throws without ever creating an orphan attachment.
      let matchFound = false;
      const scan = (nodes: any[]) => {
        for (const node of nodes) {
          if (!node) continue;
          if (
            node.type === "image" &&
            node.attrs &&
            node.attrs.attachmentId === oldAttachmentId
          ) {
            matchFound = true;
          }
          if (Array.isArray(node.content)) scan(node.content);
        }
      };

      await this.mutateLiveContentUnlocked(pageUuid, collabToken, (liveDoc) => {
        matchFound = false; // reset per-transform (collab may retry the read).
        const doc =
          liveDoc && liveDoc.type === "doc"
            ? liveDoc
            : { type: "doc", content: [] };
        if (Array.isArray(doc.content)) scan(doc.content);
        return null; // read-only: never write on the check pass.
      });

      if (!matchFound) {
        throw new Error(
          `replaceImage: no image with attachmentId "${oldAttachmentId}" found on page ${pageId}`,
        );
      }

      // STEP 2: a match exists — upload the new file as a FRESH attachment (new
      // id, new clean URL) and repoint every matching node in a second pass.
      // Still inside the SAME lock, so no other op can have changed the page
      // since the scan.
      const up = await this.uploadImage(pageId, url);

      let replaced = 0;

      // Swap the source of one image node, preserving align/alt/title/geometry.
      const repoint = (node: any) => {
        node.attrs = {
          ...node.attrs,
          src: up.src,
          attachmentId: up.attachmentId,
          // Default to null when fileSize is unknown so the attr is never
          // undefined.
          size: up.fileSize ?? null,
        };
        if (opts.align) node.attrs.align = opts.align;
        if (opts.alt !== undefined) node.attrs.alt = opts.alt;
        replaced++;
      };

      // Recursively repoint every image node (incl. ones nested in callouts/tables).
      const walk = (nodes: any[]) => {
        for (const node of nodes) {
          if (!node) continue;
          if (
            node.type === "image" &&
            node.attrs &&
            node.attrs.attachmentId === oldAttachmentId
          ) {
            repoint(node);
          }
          if (Array.isArray(node.content)) walk(node.content);
        }
      };

      const mutation = await this.mutateLiveContentUnlocked(
        pageUuid,
        collabToken,
        (liveDoc) => {
          // Reset per-transform so collab retries recompute cleanly (no double-count).
          replaced = 0;
          const doc =
            liveDoc && liveDoc.type === "doc"
              ? liveDoc
              : { type: "doc", content: [] };
          if (!Array.isArray(doc.content)) doc.content = [];
          walk(doc.content);
          if (replaced === 0) return null; // no match -> skip the write entirely
          return doc;
        },
      );
      // KNOWN LIMITATION: a same-count image SRC swap (image count unchanged, no
      // text/mark change) may still report verify.changed === false, because the
      // text+marks+integrity-count model in summarizeChange does not inspect
      // image `src`/attachmentId attributes. That is acceptable here — the
      // replace is confirmed by `replaced` below, and verify is supplementary.

      if (replaced === 0) {
        // The pass-1 SCAN found the target (matchFound was true) and we already
        // uploaded the new attachment, but pass-2 matched nothing — a concurrent
        // editor must have removed the node between the two passes. Do NOT throw
        // here (that would leak the just-uploaded attachment AND report failure);
        // instead report success with the upload flagged as an unreferenced
        // orphan so the caller knows. (The early throw above still covers the
        // case where pass-1 finds nothing, before any upload happens.)
        return {
          success: true,
          replaced: 0,
          pageId,
          oldAttachmentId,
          newAttachmentId: up.attachmentId,
          src: up.src,
          orphanedAttachmentId: up.attachmentId,
          warning:
            "target image was removed concurrently; uploaded attachment is unreferenced",
          verify: mutation.verify,
        };
      }

      return {
        success: true,
        pageId,
        replaced,
        oldAttachmentId,
        newAttachmentId: up.attachmentId,
        src: up.src,
        verify: mutation.verify,
      };
    });
  }

  // --- draw.io diagrams (issue #423) ---

  /**
   * Upload a ready-made byte buffer as a page attachment via the same
   * multipart /files/upload endpoint uploadImage uses. Split out as its own
   * (overridable) seam so drawioCreate/update can upload the generated
   * `.drawio.svg` without going through the URL-fetch path, and so tests can
   * stub the network. Mirrors uploadImage's fresh-FormData + one-shot 401/403
   * re-auth handling (a FormData body is single-use, so it must be rebuilt per
   * attempt).
   */

  // --- draw.io diagrams (issue #423) ---

  /**
   * Upload a ready-made byte buffer as a page attachment via the same
   * multipart /files/upload endpoint uploadImage uses. Split out as its own
   * (overridable) seam so drawioCreate/update can upload the generated
   * `.drawio.svg` without going through the URL-fetch path, and so tests can
   * stub the network. Mirrors uploadImage's fresh-FormData + one-shot 401/403
   * re-auth handling (a FormData body is single-use, so it must be rebuilt per
   * attempt).
   */
  protected async uploadAttachmentBuffer(
    pageId: string,
    buffer: Buffer,
    fileName: string,
    mime: string,
  ): Promise<{ id: string; fileName: string; fileSize: number }> {
    await this.ensureAuthenticated();
    const buildForm = () => {
      const form = new FormData();
      form.append("pageId", pageId);
      form.append("file", buffer, { filename: fileName, contentType: mime });
      return form;
    };
    const uploadUrl = `${this.apiUrl}/files/upload`;
    let response;
    try {
      const form = buildForm();
      response = await axios.post(uploadUrl, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: this.client.defaults.headers.common["Authorization"],
        },
        timeout: 60000,
      });
    } catch (error) {
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        await this.login();
        const form2 = buildForm();
        response = await axios.post(uploadUrl, form2, {
          headers: {
            ...form2.getHeaders(),
            Authorization: this.client.defaults.headers.common["Authorization"],
          },
          timeout: 60000,
        });
      } else if (axios.isAxiosError(error)) {
        if (process.env.DEBUG) {
          console.error(
            "Attachment upload failed; response body:",
            JSON.stringify(error.response?.data),
          );
        }
        throw new Error(
          `Attachment upload failed: ${error.response?.status} ${error.response?.statusText}`,
        );
      } else {
        throw error;
      }
    }
    const att = response.data?.data ?? response.data;
    if (!att?.id || !att?.fileName) {
      throw new Error(
        "Unexpected /files/upload response: " + JSON.stringify(response.data),
      );
    }
    return {
      id: att.id,
      fileName: att.fileName,
      fileSize: att.fileSize ?? buffer.length,
    };
  }

  /**
   * Fetch a stored `.drawio.svg` attachment as text. Overridable seam over
   * fetchInternalFile (the authed loopback fetch, which also rejects any
   * traversal/SSRF src) so drawioGet/update can read the current diagram and
   * tests can stub the bytes.
   */
  protected async fetchAttachmentText(src: string): Promise<string> {
    const { buffer } = await this.fetchInternalFile(src);
    return buffer.toString("utf-8");
  }

  /**
   * PUBLIC accessor for the guarded internal-file fetch (#588). A thin, read-only
   * wrapper over the `protected fetchInternalFile` — it adds NO logic of its own
   * and deliberately reuses that method's SSRF / traversal / 64 MiB guards rather
   * than reimplementing them. Exposed on the public client surface so the in-app
   * AI-chat `viewImage` tool can pull an attachment's raw bytes + Content-Type to
   * deliver it to the model as vision (raster passthrough or SVG->PNG rasterize),
   * WITHOUT widening the trust boundary: `src` still flows through
   * resolveInternalFilePath, so any traversal/percent-encoded escape throws before
   * a network request is made.
   */
  async fetchAttachmentBytes(
    src: string,
  ): Promise<{ buffer: Buffer; mime: string }> {
    return this.fetchInternalFile(src);
  }

  }
  return MediaMixin;
}
