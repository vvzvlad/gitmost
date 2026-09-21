import { useCallback, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import { TFunction } from "i18next";
import { DrawIoEmbedRef, EventExport, EventSave } from "react-drawio";
import { uploadFile } from "@/features/page/services/page-service.ts";
import { IAttachment } from "@/features/attachments/types/attachment.types";
import { decodeBase64ToSvgString, svgStringToFile } from "@/lib/utils";
import {
  decodedBase64ByteLength,
  ExportFamily,
  injectRasterIntoSvg,
  isValidDrawioSvg,
  isWithinRasterBudget,
  nextCircuitBreakerState,
  RASTER_CIRCUIT_BREAKER_THRESHOLD,
  RASTER_DOWNSCALE_STEPS,
  RASTER_PRIMARY_SCALE,
  resolveEffectiveUpdateSrc,
  resolveExportFamily,
  xmlStatesMatch,
} from "./drawio-raster.ts";

// Export round-trip timeouts (A6). react-drawio has NO built-in timeout/error
// for exportDiagram, so we own them. ~8s for png (the raster), a matching guard
// for the svg source path (essentially today's fast path).
const PNG_EXPORT_TIMEOUT_MS = 8000;
const SVG_EXPORT_TIMEOUT_MS = 8000;

// A single draw.io export response as delivered by onExport: `data` is the
// exported payload (a base64 data-URL for image formats), `xml` is the source.
type ExportResponse = { data: string; xml: string; format: string };

export interface UseDrawioRasterSaveParams<TTarget> {
  /** Live ref accessor to the draw.io embed (may be null before mount). */
  getDrawio: () => DrawIoEmbedRef | null;
  /** Page id the attachment belongs to. */
  getPageId: () => string | undefined;
  /** Current attachment id (undefined for a brand-new diagram). */
  getAttachmentId: () => string | undefined;
  /**
   * Whether autosave ticks may write the `src` node attribute. DrawioView MUST
   * pass `false` (writing `src` from autosave destroys the live nodeview+iframe
   * per the drawio.ts nodeview rule); DrawioMenu passes `true`.
   */
  updateSrcOnAutoSave: boolean;
  /** Whether raster GENERATION is enabled (env kill-switch, A9). */
  rasterEnabled: boolean;
  /**
   * Capture a write target at the START of a save (before the async export
   * round-trip), so the eventual attribute write is pinned to the right node
   * even if the selection moved (A7).
   */
  beginTarget: () => TTarget;
  /**
   * Apply the resulting attachment to the node. Called only if the save was not
   * cancelled. `updateSrc=false` must not write `src` (see updateSrcOnAutoSave).
   */
  applyAttributes: (
    attachment: IAttachment,
    updateSrc: boolean,
    target: TTarget,
  ) => void;
  t: TFunction;
}

export interface UseDrawioRasterSave {
  /** LoadingOverlay flag. */
  isSaving: boolean;
  /** onAutoSave handler: marks the diagram dirty. */
  markDirty: () => void;
  /** onExport handler: pure dispatcher, routes responses by format family (A2). */
  handleExport: (data: EventExport) => void;
  /** onSave handler: awaits the REAL save, then closes (A7 — no mutex early-return). */
  saveAndClose: (data: EventSave, close: () => void) => void;
  /** Autosave interval tick: saves iff dirty and idle. Stable identity. */
  autoSaveTick: () => void;
  /** Cancel any in-flight save and stop it before upload / attribute write (A7). */
  cancel: () => void;
}

export function useDrawioRasterSave<TTarget>(
  params: UseDrawioRasterSaveParams<TTarget>,
): UseDrawioRasterSave {
  // Read params through a ref so every callback below can keep a STABLE identity
  // (empty dep arrays) while still reading the latest props/getters. This keeps
  // the autosave interval from restarting on every render and avoids stale
  // closures capturing an old attachmentId / drawio ref.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const isDirtyRef = useRef(false);

  // Pending export resolvers, keyed by format FAMILY. onExport resolves the
  // pending resolver for the family it receives; it NEVER consults isSavingRef
  // (that would swallow responses and deadlock, A2).
  const pendingRef = useRef<
    Partial<Record<ExportFamily, (r: ExportResponse) => void>>
  >({});

  // Cancel token: every save captures the current token; cancel() bumps it so an
  // in-flight save sees a mismatch and bails BEFORE upload / attribute write.
  const saveTokenRef = useRef(0);
  // Coalesces an explicit Save onto an already-running save (A7).
  const inFlightRef = useRef<Promise<void> | null>(null);
  // The MUTABLE opts object the in-flight save is running with. A coalescing
  // caller upgrades its `updateSrc` in place so a coalesced explicit Save is
  // never downgraded to the running autosave's `updateSrc:false` (M2). doSave
  // reads `opts.updateSrc` live at attribute-write time, so the upgrade takes
  // effect on the already-running save.
  const inFlightOptsRef = useRef<{
    updateSrc: boolean;
    fallbackSvgData?: string;
  } | null>(null);

  // Circuit-breaker state (A6): consecutive png export failures in this session.
  const pngFailCountRef = useRef(0);
  const circuitBrokenRef = useRef(false);

  const notify = useCallback((message: string) => {
    notifications.show({ message, color: "yellow" });
  }, []);

  // Advance the png circuit-breaker refs through the pure state machine (A6/M3).
  const applyCircuitBreaker = useCallback(
    (outcome: "raster" | "skip" | "failure") => {
      const next = nextCircuitBreakerState(
        {
          failCount: pngFailCountRef.current,
          broken: circuitBrokenRef.current,
        },
        outcome,
        RASTER_CIRCUIT_BREAKER_THRESHOLD,
      );
      pngFailCountRef.current = next.failCount;
      circuitBrokenRef.current = next.broken;
    },
    [],
  );

  // ---- pure dispatcher (A2) --------------------------------------------------
  const handleExport = useCallback((data: EventExport) => {
    // Route by family, but ignore unrequested responses (draw.io's own auto-
    // xmlsvg on Save, stray autosave ticks): only resolve a family that is
    // actually pending (dispatch decision extracted to resolveExportFamily).
    const family = resolveExportFamily(
      data.format,
      (f) => pendingRef.current[f] != null,
    );
    if (!family) return;
    const resolver = pendingRef.current[family]!;
    pendingRef.current[family] = undefined;
    resolver({ data: data.data, xml: data.xml, format: data.format });
  }, []);

  // Request one export and await its response (or reject on timeout).
  const requestExport = useCallback(
    (
      family: ExportFamily,
      action: Parameters<DrawIoEmbedRef["exportDiagram"]>[0],
      timeoutMs: number,
    ): Promise<ExportResponse> => {
      return new Promise<ExportResponse>((resolve, reject) => {
        const embed = paramsRef.current.getDrawio();
        if (!embed) {
          reject(new Error("drawio embed not mounted"));
          return;
        }
        const timer = setTimeout(() => {
          if (pendingRef.current[family]) {
            pendingRef.current[family] = undefined;
            reject(new Error(`${family} export timed out`));
          }
        }, timeoutMs);
        pendingRef.current[family] = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
        embed.exportDiagram(action);
      });
    },
    [],
  );

  // ---- png raster generation with match/budget checks (A3/A6) ---------------
  // Returns a data-URI on success, or null WITH a reason when the raster is
  // dropped for being over the byte budget (a persistent state-mismatch now
  // embeds best-effort, it no longer drops the raster). THROWS only on export
  // failure/timeout (the caller counts those toward the circuit-breaker); an
  // over-budget skip is not a server failure.
  const generateRaster = useCallback(
    async (
      sourceXml: string | null,
      token: number,
    ): Promise<{ dataUri: string | null; reason: string | null }> => {
      const t = paramsRef.current.t;
      // Export at the primary (retina) scale; the budget ladder below steps it
      // down only if the result is over MAX_RASTER_BYTES.
      let resp = await requestExport(
        "png",
        { format: "png", scale: RASTER_PRIMARY_SCALE },
        PNG_EXPORT_TIMEOUT_MS,
      );
      if (token !== saveTokenRef.current) return { dataUri: null, reason: null };

      // Confirm the png captured the same diagram state as the svg (A3). One
      // redo on mismatch (at the same primary scale), then give up on the raster.
      if (sourceXml != null && !xmlStatesMatch(sourceXml, resp.xml)) {
        resp = await requestExport(
          "png",
          { format: "png", scale: RASTER_PRIMARY_SCALE },
          PNG_EXPORT_TIMEOUT_MS,
        );
        if (token !== saveTokenRef.current)
          return { dataUri: null, reason: null };
        if (!xmlStatesMatch(sourceXml, resp.xml)) {
          // Embed the preview best-effort: the png/svg state could not be
          // confirmed equal even after a retry, so this png may render a
          // slightly-different state than the svg source. We accept that as the
          // lesser evil vs. dropping the raster entirely (no data-raster ->
          // the diagram is lost on downstream publish). Do NOT return early:
          // fall through to the shared budget/downscale tail below so this png
          // is still capped by the byte budget like the matched path.
          console.warn(
            "drawio raster: png/svg state check could not be confirmed after a retry; embedding the preview best-effort",
          );
        }
      }

      // Budget: cap by DECODED bytes. Over budget -> step DOWN the scale ladder
      // (RASTER_DOWNSCALE_STEPS), re-exporting at each lower scale until one fits;
      // if even the smallest scale is still over, give up on the raster (A6).
      let size = decodedBase64ByteLength(resp.data);
      for (const scale of RASTER_DOWNSCALE_STEPS) {
        if (isWithinRasterBudget(size)) break;
        resp = await requestExport(
          "png",
          { format: "png", scale },
          PNG_EXPORT_TIMEOUT_MS,
        );
        if (token !== saveTokenRef.current)
          return { dataUri: null, reason: null };
        size = decodedBase64ByteLength(resp.data);
      }
      if (!isWithinRasterBudget(size)) {
        return {
          dataUri: null,
          reason: t("the preview image is too large"),
        };
      }

      return { dataUri: resp.data, reason: null };
    },
    [requestExport],
  );

  // ---- the save (A1 orchestration) ------------------------------------------
  const doSave = useCallback(
    async (opts: {
      updateSrc: boolean;
      fallbackSvgData?: string;
    }): Promise<void> => {
      const { rasterEnabled, beginTarget, applyAttributes, getPageId, getAttachmentId, t } =
        paramsRef.current;

      isSavingRef.current = true;
      setIsSaving(true);
      const token = ++saveTokenRef.current;
      const target = beginTarget();

      try {
        // 1. Export the SVG source (today's payload). Fall back to the payload
        //    draw.io already handed us on an explicit Save if the round-trip
        //    times out, so an explicit Save never silently loses data.
        let svgResp: ExportResponse;
        try {
          svgResp = await requestExport(
            "svg",
            { format: "xmlsvg" },
            SVG_EXPORT_TIMEOUT_MS,
          );
        } catch (err) {
          if (opts.fallbackSvgData) {
            svgResp = { data: opts.fallbackSvgData, xml: "", format: "xmlsvg" };
          } else {
            throw err;
          }
        }
        if (token !== saveTokenRef.current) return;

        // 2. Optionally generate + embed the png raster.
        let rasterDataUri: string | null = null;
        if (rasterEnabled && !circuitBrokenRef.current) {
          try {
            // When we fell back to draw.io's payload we have no source xml to
            // compare against; skip the match check (explicit Save is a stable
            // moment) but still budget-check.
            const sourceXml = svgResp.xml ? svgResp.xml : null;
            const r = await generateRaster(sourceXml, token);
            if (token !== saveTokenRef.current) return;
            rasterDataUri = r.dataUri;
            // A completed export (raster used, OR skipped over-budget) proves
            // the server works, so it resets the failure streak (A6).
            applyCircuitBreaker(rasterDataUri ? "raster" : "skip");
            if (!rasterDataUri && r.reason) {
              notify(
                t("Saved without a preview image: {{reason}}", {
                  reason: r.reason,
                }),
              );
            }
          } catch (err) {
            console.error(err);
            applyCircuitBreaker("failure");
            notify(
              t("Could not render the diagram preview image; saved without it."),
            );
          }
        }

        // 3. Build the SVG string to upload and inject the raster (A4).
        let svgString = decodeBase64ToSvgString(svgResp.data);
        if (rasterDataUri) {
          svgString = injectRasterIntoSvg(svgString, rasterDataUri);
        }

        // 4. Write-guardrail (A5): never overwrite the single source copy with a
        //    PNG or a source-stripped SVG.
        if (!isValidDrawioSvg(svgString)) {
          throw new Error(
            "drawio save guardrail: refusing to upload a non-drawio SVG",
          );
        }

        const file = await svgStringToFile(svgString, "diagram.drawio.svg");
        const pageId = getPageId();
        const attachmentId = getAttachmentId();

        // 5. Cancel token check BEFORE the write (A7): a discard/unmount during
        //    the export round-trip must not reach uploadFile.
        if (token !== saveTokenRef.current) return;

        const attachment = attachmentId
          ? await uploadFile(file, pageId, attachmentId)
          : await uploadFile(file, pageId);

        // 6. Cancel token check before writing node attributes (A7).
        if (token !== saveTokenRef.current) return;

        applyAttributes(attachment, opts.updateSrc, target);
        isDirtyRef.current = false;
      } finally {
        isSavingRef.current = false;
        setIsSaving(false);
      }
    },
    [requestExport, generateRaster, notify],
  );

  // Coalescing wrapper: an explicit Save that arrives while a save is running
  // AWAITS the in-flight save instead of throwing on an undefined return (A7).
  const save = useCallback(
    async (opts: {
      updateSrc: boolean;
      fallbackSvgData?: string;
    }): Promise<void> => {
      if (isSavingRef.current && inFlightRef.current) {
        // Coalesce onto the running save. Upgrade its updateSrc in place so a
        // coalesced explicit Save still refreshes the node's src (M2): the
        // strongest updateSrc among the coalesced callers wins.
        if (inFlightOptsRef.current) {
          inFlightOptsRef.current.updateSrc = resolveEffectiveUpdateSrc(
            inFlightOptsRef.current.updateSrc,
            opts.updateSrc,
          );
        }
        await inFlightRef.current;
        return;
      }
      inFlightOptsRef.current = opts;
      const p = doSave(opts);
      inFlightRef.current = p;
      try {
        await p;
      } finally {
        inFlightRef.current = null;
        inFlightOptsRef.current = null;
      }
    },
    [doSave],
  );

  const markDirty = useCallback(() => {
    isDirtyRef.current = true;
  }, []);

  const saveAndClose = useCallback(
    (data: EventSave, close: () => void) => {
      // Await the REAL save before closing (A7): the old `.then(close)` on an
      // undefined mutex early-return closed the modal with NO save.
      void save({ updateSrc: true, fallbackSvgData: data.xml }).then(
        () => close(),
        (err) => {
          console.error(err);
          notify(paramsRef.current.t("Failed to save the diagram."));
        },
      );
    },
    [save, notify],
  );

  const autoSaveTick = useCallback(() => {
    if (isDirtyRef.current && !isSavingRef.current && paramsRef.current.getDrawio()) {
      void save({ updateSrc: paramsRef.current.updateSrcOnAutoSave }).catch(
        (err) => console.error(err),
      );
    }
  }, [save]);

  const cancel = useCallback(() => {
    // Invalidate any in-flight save so it bails before upload / attribute write.
    saveTokenRef.current += 1;
  }, []);

  return {
    isSaving,
    markDirty,
    handleExport,
    saveAndClose,
    autoSaveTick,
    cancel,
  };
}
