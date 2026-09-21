// Auto-split from client.ts (issue #450). Mixin over the shared client context.
// Bodies are VERBATIM from the original DocmostClient; only the enclosing class
// changed to a mixin factory. See client/context.ts for the shared base.
import type { GConstructor, DocmostClientContext } from "./context.js";
import {
  collectInternalFileNodes,
  normalizeFileUrl,
  resolveInternalFilePath,
} from "../lib/internal-file-urls.js";
import { extractDrawioRaster } from "../lib/drawio-xml.js";

// downloadFile (#613) — base64 branch ceiling.
// The base64 branch returns the bytes base64-encoded INTO the tool result, which
// the MCP host serializes as TEXT into the model context (jsonContent). So this
// ceiling is a CONTEXT budget, not a transport one: 1 MiB of bytes ≈ 1.37 MiB of
// base64 text ≈ hundreds of thousands of tokens already. Default 1 MiB; the value
// is overridable via MCP_MAX_DOWNLOAD_BASE64_BYTES or a per-call maxBase64Bytes,
// but ALWAYS clamped to DOWNLOAD_BASE64_HARD_CEILING so neither a bad env var nor
// a caller can turn the base64 branch into a context bomb (review finding).
const DEFAULT_MAX_DOWNLOAD_BASE64_BYTES = 1 * 1024 * 1024; // 1 MiB
const DOWNLOAD_BASE64_HARD_CEILING = 4 * 1024 * 1024; // 4 MiB absolute clamp

/**
 * The loopback read's own memory guard: fetchInternalFile never buffers more
 * than this, whatever a caller or a sandbox env asks for. Every deliverable
 * bound is clamped to it, so an error message can never quote a limit the fetch
 * physically cannot reach.
 */
const FETCH_HARD_CEILING = 64 * 1024 * 1024; // 64 MiB

// downloadFile (#613) — blob-sandbox per-blob delivery caps: FALLBACK defaults.
// The AUTHORITATIVE caps are the sink's own (on the Docmost server they are the
// per-deployment env vars SANDBOX_MAX_BYTES / SANDBOX_MAX_IMAGE_BYTES, read on
// every put), and the host reports them to the package through the sandbox sink
// (config.sandbox.maxBytes / maxImageBytes → this.sandboxMaxBytes /
// this.sandboxMaxImageBytes). downloadFile uses THOSE values for its pre-check,
// its early-abort fetch bound and every size error message, so raising the env
// on the server genuinely raises what downloadFile will deliver.
// These two constants are used ONLY when the host reports nothing (standalone /
// stdio, or an older binding); they are the upstream DEFAULTS of those env vars.
const DEFAULT_SANDBOX_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB, non-image blob
const DEFAULT_SANDBOX_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB, image blob

/**
 * Resolve the downloadFile base64 ceiling: an explicit per-call override wins,
 * else MCP_MAX_DOWNLOAD_BASE64_BYTES, else the 1 MiB default — and the result is
 * ALWAYS clamped to DOWNLOAD_BASE64_HARD_CEILING. Parsed like resolveMaxUploadBytes:
 * a non-finite/non-positive value is ignored (never DISABLES the limit). Read
 * fresh so a test/rollback can change the env without reloading the module.
 */
function resolveMaxDownloadBase64Bytes(override?: number): number {
  const fromOpt =
    typeof override === "number" && Number.isFinite(override) && override > 0
      ? override
      : undefined;
  const parsed = parseInt(process.env.MCP_MAX_DOWNLOAD_BASE64_BYTES ?? "", 10);
  const fromEnv = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  const chosen = fromOpt ?? fromEnv ?? DEFAULT_MAX_DOWNLOAD_BASE64_BYTES;
  return Math.min(chosen, DOWNLOAD_BASE64_HARD_CEILING);
}

/**
 * Recognize an axios content-length abort (the early-abort guard fired) so
 * downloadFile can rewrap it as an actionable, size-specific error instead of
 * surfacing the raw axios internals. Best-effort: matches the v1 error code and
 * the classic message on either bound.
 */
function isMaxContentLengthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: unknown; message?: unknown };
  const code = typeof anyErr.code === "string" ? anyErr.code : "";
  const msg = typeof anyErr.message === "string" ? anyErr.message : "";
  return (
    /ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED/i.test(code) ||
    /maxContentLength|maxBodyLength/i.test(msg)
  );
}

/**
 * Discriminated result of downloadFile (#613). `kind` selects the branch:
 *  - 'base64': the bytes, base64-encoded (small files — enters the model context);
 *  - 'url': a short ANONYMOUS sandbox URL any server can fetch without auth.
 * Both carry best-effort `fileName`/`attachmentId` parsed from the src.
 */
export type DownloadFileResult =
  | {
      kind: "base64";
      base64: string;
      mime: string;
      fileName: string | null;
      attachmentId: string | null;
      size: number;
    }
  | {
      kind: "url";
      uri: string;
      sha256: string;
      mime: string;
      fileName: string | null;
      attachmentId: string | null;
      size: number;
    };

// Public method surface of StashMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements IStashMixin` fails to compile on drift.
export interface IStashMixin {
  stashPage(pageId: string): Promise<{ uri: string; sha256: string; size: number; images: { mirrored: number; failed: number }; diagrams: { rasterized: number; degraded: number }; }>;
  downloadFile(src: string, opts?: { format?: "base64" | "url" | "auto"; maxBase64Bytes?: number }): Promise<DownloadFileResult>;
}

export function StashMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & IStashMixin> & TBase {
  abstract class StashMixin extends Base implements IStashMixin {
  /**
   * Fetch an INTERNAL Docmost file (authed loopback) for sandbox mirroring.
   * `src` is normalized to `/api/files/<id>/<file>`; `this.client.baseURL`
   * already ends in `/api`, so we strip the leading `/api` and request the
   * relative path with the client's Authorization header. Returns the raw bytes
   * and the response Content-Type (mime), defaulting to octet-stream.
   *
   * The fetch is size-bounded (hard 64 MiB ceiling) purely to protect memory;
   * the authoritative per-blob cap is enforced by the sandbox `put`. The path is
   * resolved via resolveInternalFilePath, which REJECTS (throws) any traversal
   * or percent-encoded src that would let an attacker-controlled `attrs.src`
   * escape `/api/files/` and reach another internal endpoint (SSRF). That throw
   * happens before this.client.get, so a malicious src is counted as a failed
   * mirror — it never reaches the network.
   *
   * `maxBytes` (optional, #613) lowers the axios content-length bound BELOW the
   * 64 MiB ceiling so an oversize blob aborts EARLY (before buffering 64 MiB) —
   * downloadFile passes it so a file over the requested delivery ceiling is
   * rejected without a full read. It is clamped to the hard ceiling, so it can
   * only tighten, never widen, the guard; omitted (the stashPage/viewImage path)
   * it keeps the original 64 MiB behaviour unchanged.
   */
  protected async fetchInternalFile(
    src: string,
    maxBytes?: number,
  ): Promise<{ buffer: Buffer; mime: string }> {
    const cap =
      typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.min(maxBytes, FETCH_HARD_CEILING)
        : FETCH_HARD_CEILING;
    const relPath = resolveInternalFilePath(src);
    const response = await this.client.get(relPath, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: cap,
      maxBodyLength: cap,
    });
    const buffer = Buffer.from(response.data);
    if (buffer.length === 0) {
      throw new Error(`Empty file response from "${src}"`);
    }
    const rawCt = response.headers?.["content-type"];
    const mime =
      typeof rawCt === "string" && rawCt.length > 0
        ? rawCt.split(";")[0].trim().toLowerCase()
        : "application/octet-stream";
    return { buffer, mime };
  }

  /**
   * Stash a page's full content into the in-RAM blob sandbox and return ONLY a
   * short anonymous URL — the body never enters the model context (this is the
   * whole point: ~30KB+ ProseMirror docs blow the model context if passed as a
   * tool argument). Every INTERNAL file/image src (the type-agnostic criterion,
   * so drawio/excalidraw/video/file nodes are covered too) is mirrored into the
   * sandbox and its `src` rewritten to the sandbox URL, so an external consumer
   * can fetch the images anonymously. External http(s) srcs are left untouched.
   *
   * Blobs live in RAM with a short TTL and are cleared on restart — consume the
   * URLs within the TTL and one uptime. A failed image fetch never aborts the
   * doc: the original src is kept and the failure counted.
   *
   * DIAGRAMS (issue #629 draw.io, #632 excalidraw): a `drawio`/`excalidraw` node
   * is NOT mirrored as its raw `.svg` under its own type (habr does not know
   * these node types and would drop them; draw.io captions also live in a
   * browser-only `foreignObject` that renders as garbage server-side). Instead,
   * if the SVG carries a valid browser-embedded PNG raster (DRAWIO_RASTER_ATTR),
   * the PNG is stashed and the node is rewritten in-place to an `image` node
   * pointing at it (`rasterized`). A diagram with no/invalid raster diverges by
   * type: a `drawio` node DEGRADES in place (stays a drawio node with its
   * original src, counted `degraded`); an `excalidraw` node — whose SVG is itself
   * VALID (real `<text>`) — instead has its SVG mirrored into the sandbox and the
   * node rewritten to an `image` pointing at that SVG (also counted `degraded`),
   * so habr renders it as an image rather than dropping it. This reader never
   * throws on the no-raster case, so "hand this to a translator" keeps working.
   *
   * Returns { uri, sha256, size, images:{mirrored, failed},
   * diagrams:{rasterized, degraded} }. `uri` and `sha256` are for the document
   * blob; `sha256` is also the blob's ETag (integrity). This result is a
   * PUBLICATION VIEW — one-way; do NOT write it back as page content.
   */
  async stashPage(pageId: string): Promise<{
    uri: string;
    sha256: string;
    size: number;
    images: { mirrored: number; failed: number };
    diagrams: { rasterized: number; degraded: number };
  }> {
    if (!this.sandboxPut) {
      throw new Error(
        "stashPage is unavailable: the blob sandbox is not configured on this server",
      );
    }
    await this.ensureAuthenticated();

    // Stash the SAME shape getPageJson returns (id/title/.../content), with a
    // deep clone so the rewrite never mutates anything shared.
    const pageJson = await this.getPageJson(pageId);
    const cloned: any = structuredClone(pageJson);

    // Group internal-file nodes by normalized src so each unique resource is
    // fetched + stored ONCE (dedup), and every node sharing that src points at
    // the one sandbox blob. Capture each node's ORIGINAL raw src per-node:
    // dedup groups nodes whose normalized src is equal even when their raw srcs
    // differ (e.g. `/api/files/...` vs the bare `/files/...`), so on a revert we
    // must restore each node's own original value, not the group key.
    const bySrc = new Map<string, Array<{ node: any; origSrc: string }>>();
    // drawio nodes are handled by a SEPARATE diagram pass (#629) — never mirror
    // their raw `.drawio.svg` (it rasterizes to garbage). Group them by src too
    // so a copied diagram (two nodes, one src) is fetched/extracted once.
    const diagramBySrc = new Map<string, any[]>();
    for (const node of collectInternalFileNodes(cloned.content)) {
      if (node.type === "drawio" || node.type === "excalidraw") {
        const src = normalizeFileUrl(String(node.attrs.src));
        const group = diagramBySrc.get(src);
        if (group) group.push(node);
        else diagramBySrc.set(src, [node]);
        continue;
      }
      const origSrc = String(node.attrs.src);
      const src = normalizeFileUrl(origSrc);
      const entry = { node, origSrc };
      const group = bySrc.get(src);
      if (group) group.push(entry);
      else bySrc.set(src, [entry]);
    }

    let mirrored = 0;
    let failed = 0;
    // Record every successful mirror so it can be (a) reverted if its blob gets
    // FIFO-evicted by a LATER put in this same stash, and (b) freed if the final
    // doc put throws.
    const mirrors: Array<{
      uri: string;
      entries: Array<{ node: any; origSrc: string }>;
    }> = [];
    const MAX_CONCURRENCY = 5;
    const groups = [...bySrc.entries()];
    for (let i = 0; i < groups.length; i += MAX_CONCURRENCY) {
      const batch = groups.slice(i, i + MAX_CONCURRENCY);
      await Promise.all(
        batch.map(async ([src, entries]) => {
          try {
            const { buffer, mime } = await this.fetchInternalFile(src);
            // put may throw if the blob exceeds the per-blob/total caps.
            const stored = this.sandboxPut!(buffer, mime);
            for (const entry of entries) entry.node.attrs.src = stored.uri;
            mirrors.push({ uri: stored.uri, entries });
            mirrored++;
          } catch (err) {
            // One bad/oversized image (or a rejected traversal src) must not
            // abort the document. Logged unconditionally (never the blob body),
            // matching the package's ungated console.warn convention.
            failed++;
            console.warn(
              `stashPage: failed to mirror "${src}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }),
      );
    }

    // --- diagram pass (#629) -------------------------------------------------
    // For each drawio node: fetch its `.drawio.svg`, extract+validate the
    // browser-embedded PNG raster. If present -> stash the PNG and rewrite the
    // node IN-PLACE to an `image` node pointing at it. If absent/invalid ->
    // best-effort DEGRADE (leave it a drawio node with its original src). A
    // synthesized PNG blob participates in the same FIFO-eviction reconciliation
    // as image mirrors below, but with a STRICTER policy: once the node has been
    // converted to an `image`, there is no drawio fallback, so an evicted
    // synthesized blob is a HARD FAILURE (clean up this op's blobs and throw),
    // never a silent revert to a broken state.
    let rasterized = 0;
    let degraded = 0;
    const synthesized: Array<{ uri: string; nodes: any[] }> = [];
    // #632: excalidraw nodes with NO usable raster do NOT degrade in place (that
    // drops them from habr, which does not know the `excalidraw` type). Because
    // an excalidraw SVG is itself VALID (real `<text>`, no browser-only
    // foreignObject), we MIRROR the SVG into the sandbox and rewrite the node to
    // an `image` pointing at it. Unlike a synthesized PNG raster, this is a SOFT
    // mirror: an eviction reverts the node to an in-place degrade (still counted
    // as `degraded`), never a hard failure. Each entry snapshots the original
    // node type+attrs so the revert can restore the excalidraw node exactly.
    const svgMirrors: Array<{
      uri: string;
      orig: Array<{ node: any; type: string; attrs: any }>;
    }> = [];
    const diagramGroups = [...diagramBySrc.entries()];
    for (let i = 0; i < diagramGroups.length; i += MAX_CONCURRENCY) {
      const batch = diagramGroups.slice(i, i + MAX_CONCURRENCY);
      await Promise.all(
        batch.map(async ([src, nodes]) => {
          // A group shares one src => one attachment => one node type.
          const nodeType = nodes[0]?.type;
          let svgBuffer: Buffer | null = null;
          let png: Buffer | null = null;
          try {
            const { buffer } = await this.fetchInternalFile(src);
            svgBuffer = buffer;
            png = extractDrawioRaster(buffer.toString("utf-8"));
          } catch (err) {
            svgBuffer = null;
            png = null;
            console.warn(
              `stashPage: failed to read diagram "${src}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          if (!png) {
            // No/invalid raster. For excalidraw the SVG is valid, so mirror it as
            // an image instead of dropping it (below). For drawio (or an
            // excalidraw whose SVG could not be fetched) -> degrade in place.
            if (nodeType === "excalidraw" && svgBuffer) {
              let storedSvg: { uri: string; sha256: string; size: number };
              try {
                storedSvg = this.sandboxPut!(svgBuffer, "image/svg+xml");
              } catch (err) {
                // Could not stash the SVG (e.g. exceeds a per-blob cap) ->
                // degrade in place (leave the excalidraw node untouched).
                degraded++;
                console.warn(
                  `stashPage: failed to mirror excalidraw SVG for "${src}": ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                return;
              }
              // Snapshot BEFORE mutating so an eviction can restore the exact
              // excalidraw node (type + attrs).
              const orig = nodes.map((node) => ({
                node,
                type: node.type,
                attrs: node.attrs,
              }));
              for (const node of nodes) {
                const alt = node.attrs.alt ?? node.attrs.title;
                const width = node.attrs.width;
                const align = node.attrs.align;
                node.type = "image";
                const attrs: any = { src: storedSvg.uri };
                if (alt != null) attrs.alt = alt;
                if (width != null) attrs.width = width;
                if (align != null) attrs.align = align;
                node.attrs = attrs;
              }
              svgMirrors.push({ uri: storedSvg.uri, orig });
              // The diagram did not get a raster -> still counted as degraded.
              degraded++;
              return;
            }
            // drawio (or excalidraw with no fetchable SVG) -> degrade in place.
            degraded++;
            return;
          }
          let stored: { uri: string; sha256: string; size: number };
          try {
            stored = this.sandboxPut!(png, "image/png");
          } catch (err) {
            // The synthesized PNG could not be stored (e.g. exceeds a per-blob
            // cap). Degrade rather than abort — the node is still a valid diagram
            // node pointing at its original src (nothing was mutated yet).
            degraded++;
            console.warn(
              `stashPage: failed to stash diagram raster for "${src}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return;
          }
          // Convert each node in-place: diagram -> image, carrying alt (<- alt ||
          // title), width and align, and pointing src at the sandbox PNG. The
          // SVG itself is NOT put into the sandbox.
          for (const node of nodes) {
            const alt = node.attrs.alt ?? node.attrs.title;
            const width = node.attrs.width;
            const align = node.attrs.align;
            node.type = "image";
            const attrs: any = { src: stored.uri };
            if (alt != null) attrs.alt = alt;
            if (width != null) attrs.width = width;
            if (align != null) attrs.align = align;
            node.attrs = attrs;
          }
          synthesized.push({ uri: stored.uri, nodes });
          rasterized++;
        }),
      );
    }

    // Revert one image mirror's nodes to their original internal srcs and
    // re-count it as failed (its blob was FIFO-evicted before the doc could
    // reference it safely).
    const revertImageMirror = (mirror: {
      uri: string;
      entries: Array<{ node: any; origSrc: string }>;
    }) => {
      for (const entry of mirror.entries) entry.node.attrs.src = entry.origSrc;
      mirrored--;
      failed++;
      console.warn(
        `stashPage: mirrored blob ${mirror.uri} was evicted before the doc ` +
          `could safely reference it; reverted its src and counted it as failed`,
      );
    };

    // Revert one excalidraw SVG mirror (#632): its sandbox SVG blob was evicted,
    // so restore the ORIGINAL excalidraw node (type + attrs) — an in-place
    // degrade, which is a correct fallback (the excalidraw SVG stays valid). The
    // node was already counted as `degraded`, so no counter changes here.
    const revertSvgMirror = (mirror: {
      uri: string;
      orig: Array<{ node: any; type: string; attrs: any }>;
    }) => {
      for (const o of mirror.orig) {
        o.node.type = o.type;
        o.node.attrs = o.attrs;
      }
      console.warn(
        `stashPage: mirrored excalidraw SVG blob ${mirror.uri} was evicted ` +
          `before the doc could reference it; reverted the node to an in-place ` +
          `degrade`,
      );
    };

    // Unified SOFT-revert mirror set (image mirrors + excalidraw SVG mirrors):
    // both follow the FIFO-eviction revert path, as opposed to synthesized PNG
    // rasters (which HARD-FAIL). Each carries its own revert closure so the
    // reconciliation below is type-agnostic.
    type SoftMirror = { uri: string; revert: () => void };
    let liveMirrors: SoftMirror[] = [
      ...mirrors.map((m) => ({ uri: m.uri, revert: () => revertImageMirror(m) })),
      ...svgMirrors.map((m) => ({ uri: m.uri, revert: () => revertSvgMirror(m) })),
    ];

    // Free every blob this op stored (image mirrors + excalidraw SVG mirrors +
    // synthesized diagram rasters). Used on a HARD failure so nothing leaks in
    // RAM for the TTL.
    const cleanupOpBlobs = () => {
      if (!this.sandboxEvict) return;
      for (const mirror of liveMirrors) this.sandboxEvict(mirror.uri);
      for (const s of synthesized) this.sandboxEvict(s.uri);
    };
    // A synthesized diagram raster evicted before the doc can reference it is a
    // hard failure: its drawio node is already an `image` node (no fallback), so
    // silently keeping a dead sandbox URL would ship a broken publication view.
    const assertSynthLive = () => {
      if (!this.sandboxHas) return;
      const dead = synthesized.filter((s) => !this.sandboxHas!(s.uri));
      if (dead.length > 0) {
        cleanupOpBlobs();
        throw new Error(
          `stashPage: a synthesized diagram raster (${dead[0].uri}) was evicted ` +
            `from the sandbox before the document could reference it — aborting ` +
            `rather than shipping a broken publication view. Retry, or reduce the ` +
            `page's attachment volume.`,
        );
      }
    };

    // Pre-put reconciliation: a put earlier in THIS stash can FIFO-evict an
    // even-earlier soft mirror of the same stash. Drop those from the live set
    // first (reverting each) so the first serialized doc is already mostly
    // correct.
    if (this.sandboxHas) {
      const stillLive: SoftMirror[] = [];
      for (const mirror of liveMirrors) {
        if (this.sandboxHas(mirror.uri)) stillLive.push(mirror);
        else mirror.revert();
      }
      liveMirrors = stillLive;
      // A synthesized raster evicted by a later put (image or another raster) in
      // this same stash -> hard failure.
      assertSynthLive();
    }

    // Put the document, then reconcile against eviction caused by the doc put
    // ITSELF (the doc is newest, FIFO drops oldest = this stash's images). Each
    // iteration reverts >=1 mirror, so the loop terminates (worst case: all
    // images reverted and the doc references no sandbox image URLs).
    let stored: { uri: string; sha256: string; size: number };
    for (;;) {
      const docBuf = Buffer.from(JSON.stringify(cloned), "utf8");
      let docStored: { uri: string; sha256: string; size: number };
      try {
        docStored = this.sandboxPut(docBuf, "application/json");
      } catch (err) {
        // The doc put failed (e.g. doc exceeds the cap). Free this op's image
        // AND synthesized-raster blobs instead of leaking them in RAM for the
        // whole TTL, then re-throw.
        cleanupOpBlobs();
        throw err;
      }

      if (!this.sandboxHas) {
        stored = docStored;
        break;
      }
      // The doc put (newest) can FIFO-evict this stash's oldest blobs. If it
      // evicted a SYNTHESIZED raster, that is a hard failure (drop the doc blob
      // first, then clean up + throw) — never a silent revert.
      if (synthesized.some((s) => !this.sandboxHas!(s.uri))) {
        if (this.sandboxEvict) this.sandboxEvict(docStored.uri);
        assertSynthLive();
      }
      const evictedNow = liveMirrors.filter((m) => !this.sandboxHas!(m.uri));
      if (evictedNow.length === 0) {
        stored = docStored;
        break;
      }
      // The doc we just stored references now-dead blobs. Revert those nodes,
      // drop the stale doc blob, and loop to re-serialize + re-put the
      // corrected doc.
      for (const mirror of evictedNow) mirror.revert();
      liveMirrors = liveMirrors.filter((m) => this.sandboxHas!(m.uri));
      if (this.sandboxEvict) this.sandboxEvict(docStored.uri);
    }
    return {
      uri: stored.uri,
      sha256: stored.sha256,
      size: stored.size,
      images: { mirrored, failed },
      diagrams: { rasterized, degraded },
    };
  }

  /**
   * Download an INTERNAL Docmost attachment's bytes and hand them back in a
   * caller-chosen shape (#613). `src` is the internal `/api/files/<id>/<name>`
   * (or bare `/files/...`) URL the agent already has from getPageJson / getNode /
   * uploadFile. The reused primitive is the SAME guarded loopback fetch
   * (fetchInternalFile) stashPage/viewImage use, so the SSRF / traversal /
   * memory guards are unchanged; this method only surfaces the bytes externally.
   *
   * `format` (default 'auto'):
   *  - 'base64' → the bytes base64-encoded (small files ONLY — this enters the
   *    model context and costs tokens); rejected over the base64 ceiling.
   *  - 'url' → the bytes stashed into the blob sandbox and returned as a SHORT
   *    ANONYMOUS URL any server can fetch WITHOUT auth (the way to hand a file to
   *    insertImage/replaceImage on another instance). The URL is PUBLIC and
   *    NON-revocable until it expires (~1h TTL, RAM-only) — same model as stashPage.
   *  - 'auto' → base64 when it fits the base64 ceiling, else the anonymous URL
   *    when the sandbox is configured and the file fits its per-blob cap, else a
   *    clear "too large to deliver" error (the dead zone between the base64
   *    ceiling and the sandbox's per-blob cap for that mime — by default 1–8 MiB
   *    is delivered as a URL and 8–20 MiB is the dead zone for a NON-image, while
   *    an image is deliverable up to the 20 MiB image cap).
   *
   * The per-blob caps are the sink's REAL ones when the host reports them (see
   * DEFAULT_SANDBOX_MAX_BYTES above), so an operator who raises SANDBOX_MAX_BYTES
   * on the server raises what this tool delivers, and the error messages quote
   * the caps that will actually be enforced.
   *
   * `src` may be an ABSOLUTE URL (e.g. copied from another instance): its HOST is
   * IGNORED — only the `/api/files/...` path is used, and the bytes are ALWAYS
   * fetched from THIS instance over the authenticated loopback. It is therefore
   * never a way to reach a remote host (no SSRF), but it is also NOT a way to
   * download another instance's file: you get THIS instance's file with that id,
   * or a 404.
   *
   * SECURITY: `src` is resolved via resolveInternalFilePath (rejects traversal /
   * percent-encoded escapes / anything outside /api/files/ BEFORE any network
   * call) and then additionally required to be EXACTLY /api/files/<uuid>/<name>,
   * so `/api/files/onlyoneseg` (which clears the prefix gate but matches no file
   * route and would hit the SPA catch-all with a 200 index.html) is rejected up
   * front rather than "succeeding" with an HTML page.
   */
  async downloadFile(
    src: string,
    opts: {
      format?: "base64" | "url" | "auto";
      maxBase64Bytes?: number;
    } = {},
  ): Promise<DownloadFileResult> {
    await this.ensureAuthenticated();

    // Accept BOTH internal forms an agent can copy out of getPageJson/getNode:
    // the canonical `/api/files/...` and the bare `/files/...` (page content
    // carries both — stashPage normalizes for the same reason before fetching).
    // This only ADDS the `/api` prefix to a `/files/`-rooted path; it cannot
    // widen the trust boundary, because resolveInternalFilePath below still
    // canonicalizes the result and re-asserts the `/api/files/` prefix.
    const normalizedSrc = normalizeFileUrl(src);

    // FORM VALIDATION. resolveInternalFilePath throws on traversal / percent-
    // encoded escape / non-/api/files src BEFORE any network call. We then pin the
    // shape to /files/<uuid>/<non-empty name> so the SPA catch-all can never be
    // mistaken for an attachment (review R-sec #5).
    const relPath = resolveInternalFilePath(normalizedSrc);
    const formMatch =
      /^\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([^/]+)$/i.exec(
        relPath,
      );
    if (!formMatch) {
      throw new Error(
        `downloadFile: src must be an internal attachment URL of the form ` +
          `/api/files/<uuid>/<fileName> (got "${src}")`,
      );
    }

    // The canonical, HOST-STRIPPED path we actually fetch. resolveInternalFilePath
    // already discarded any absolute-URL host (that is the SSRF guard), so feeding
    // its output back is what pins the property structurally: whatever host the
    // agent passed, the loopback fetch only ever sees `/api/files/<uuid>/<name>`
    // on THIS instance. (fetchInternalFile re-resolves it — idempotent.)
    const canonicalSrc = `/api${relPath}`;

    const format = opts.format ?? "auto";
    const base64cap = resolveMaxDownloadBase64Bytes(opts.maxBase64Bytes);

    // The sink's REAL per-blob caps when the host reports them, else the upstream
    // defaults (see the constants above). Read BEFORE the fetch because they set
    // the early-abort bound.
    const maxNonImageBytes = this.sandboxMaxBytes ?? DEFAULT_SANDBOX_MAX_BYTES;
    const maxImageBytes =
      this.sandboxMaxImageBytes ?? DEFAULT_SANDBOX_MAX_IMAGE_BYTES;
    // The absolute ceiling of what the url branch can EVER deliver, whatever the
    // mime turns out to be. Math.max (not "the image cap") because an operator is
    // free to configure a non-image cap LARGER than the image one — but clamped
    // to the loopback read's own 64 MiB memory guard (fetchInternalFile's
    // HARD_CEILING), which no sandbox env can lift. Without the clamp, raising
    // SANDBOX_MAX_IMAGE_BYTES past 64 MiB would make the abort message quote a
    // limit the fetch can never reach, and promise a delivery it cannot make.
    const maxDeliverableBytes = Math.min(
      Math.max(maxNonImageBytes, maxImageBytes),
      FETCH_HARD_CEILING,
    );

    // Bound the loopback read so an oversize blob aborts EARLY (before buffering
    // the full 64 MiB ceiling): base64 can never deliver more than base64cap;
    // url/auto no more than the largest per-blob cap. +1 so a file EXACTLY at the
    // cap still reads and is then rejected below with a clear message.
    const fetchBound =
      format === "base64" ? base64cap + 1 : maxDeliverableBytes + 1;

    let buffer: Buffer;
    let mime: string;
    try {
      const got = await this.fetchInternalFile(canonicalSrc, fetchBound);
      buffer = got.buffer;
      mime = got.mime;
    } catch (err) {
      // The early-abort guard firing is reported as a size-specific, actionable
      // error; every other fetch failure (traversal reject / 404 / timeout)
      // propagates unchanged.
      if (isMaxContentLengthError(err)) {
        if (format === "base64") {
          throw new Error(
            `downloadFile: file exceeds the base64 ceiling of ${base64cap} bytes; ` +
              `use format:'url' (anonymous URL) or 'auto'`,
          );
        }
        // The mime is unknown at abort time (the response was cut off), so the
        // only honest bound to quote is the ABSOLUTE maximum — the largest
        // per-blob cap. A non-image's own cap may well be lower; that case is
        // caught after a completed read, with its exact cap named.
        throw new Error(
          `downloadFile: file exceeds the ${maxDeliverableBytes}-byte absolute ` +
            `maximum this server can deliver (the largest blob-sandbox per-blob ` +
            `cap); fetch it directly from Docmost instead`,
        );
      }
      throw err;
    }

    // Observability: report the volume read over the loopback so a bulk download
    // by an external agent is visible to the operator (access stays within the
    // service account's CASL scope, but VOLUME is otherwise invisible; review
    // ops #4). Emitted once per successful fetch, before format branching.
    this.onMetricFn?.("mcp_download_bytes_total", buffer.length, {
      tool: "downloadFile",
    });

    // Best-effort metadata from the resolved path. decodeURIComponent throws on a
    // malformed % escape → keep fileName null rather than fail the download.
    const attachmentId: string | null = formMatch[1];
    let fileName: string | null = null;
    try {
      fileName = decodeURIComponent(formMatch[2]);
    } catch {
      fileName = null;
    }

    const isImage = mime.startsWith("image/");
    const sandboxCap = isImage ? maxImageBytes : maxNonImageBytes;
    const size = buffer.length;

    const deliverBase64 = (): DownloadFileResult => {
      if (buffer.length > base64cap) {
        throw new Error(
          `downloadFile: file is ${buffer.length} bytes, over the base64 ceiling ` +
            `of ${base64cap} bytes; use format:'url' (anonymous URL) or 'auto'`,
        );
      }
      return {
        kind: "base64",
        base64: buffer.toString("base64"),
        mime,
        fileName,
        attachmentId,
        size,
      };
    };

    const deliverUrl = (): DownloadFileResult => {
      if (!this.sandboxPut) {
        throw new Error(
          "downloadFile: url format is unavailable — the blob sandbox is not " +
            "configured on this server",
        );
      }
      if (buffer.length > sandboxCap) {
        throw new Error(
          `downloadFile: file is ${buffer.length} bytes, over the ${sandboxCap}-byte ` +
            `deliverable limit for ${isImage ? "images" : "non-image files"} ` +
            `(the blob sandbox per-blob cap)`,
        );
      }
      let stored;
      try {
        stored = this.sandboxPut(buffer, mime);
      } catch (err) {
        // The pre-check above should have caught an oversize; never leak a raw
        // sandbox internal error to the agent.
        throw new Error(
          `downloadFile: failed to stash the file into the blob sandbox: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return {
        kind: "url",
        uri: stored.uri,
        sha256: stored.sha256,
        mime,
        fileName,
        attachmentId,
        size,
      };
    };

    if (format === "base64") return deliverBase64();
    if (format === "url") return deliverUrl();
    // auto: small enough for context → base64; else if the sandbox can take it →
    // url; else a clear "too large to deliver". That dead zone is (this mime's
    // per-blob cap, maxDeliverableBytes]: with the DEFAULT caps a non-image over
    // 8 MiB is undeliverable (8–20 MiB reaches here; over 20 MiB the fetch
    // early-aborts and the message above fires instead), while an image is
    // deliverable right up to its 20 MiB cap. It also covers "no sandbox at all",
    // where anything over the base64 ceiling is undeliverable.
    if (buffer.length <= base64cap) return deliverBase64();
    if (this.sandboxPut && buffer.length <= sandboxCap) return deliverUrl();
    throw new Error(
      `downloadFile: file is ${buffer.length} bytes — too large to deliver ` +
        `(base64 ceiling ${base64cap} bytes; ${
          this.sandboxPut
            ? `sandbox cap ${sandboxCap} bytes for ${
                isImage ? "images" : "non-image files"
              }`
            : "blob sandbox not configured"
        }). Fetch it directly from Docmost instead.`,
    );
  }

  /**
   * Compact outline of a page's top-level blocks (no full document body).
   * Cheap way to locate sections/tables and grab block ids before drilling in
   * with getNode / patchNode / insertNode.
   */
  }
  return StashMixin;
}
