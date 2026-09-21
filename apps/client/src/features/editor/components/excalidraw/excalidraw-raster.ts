// Pure, framework-free helpers for the excalidraw PNG-raster embedding feature
// (issue #632, Part A — symmetric to draw.io's #629). Side-effect free so the
// splice/budget/guardrail decisions are unit-testable without a browser or a live
// Excalidraw scene. The React orchestration lives in `excalidraw-view.tsx`.
//
// SHARED CONTRACT is IDENTICAL to #629: the raster is stored as a root
// `data-raster="data:image/png;base64,<b64>"` attribute on the `<svg …>` element,
// validated with the 8-byte PNG signature by the server/mcp consumers (Part B).
// The type-agnostic injection/budget primitives are REUSED from drawio-raster.ts
// (cross-component import — no logic is duplicated); only the excalidraw-specific
// upload guardrail lives here.

import {
  decodedBase64ByteLength,
  injectRasterIntoSvg,
  isWithinRasterBudget,
  normalizeRasterDataUri,
} from "../drawio/drawio-raster.ts";

/**
 * Embed a PNG raster data-URI into an excalidraw SVG string IFF it is within the
 * shared decoded-byte budget (2 MiB). Over budget we save WITHOUT the raster —
 * excalidraw's SVG is itself valid (its captions are real `<text>`, not a
 * browser-only `foreignObject`), so this is a graceful degrade, never a failure.
 *
 * Returns the possibly-modified svg plus whether the raster was embedded and, on
 * a skip, a machine-readable reason. Pure: `injectRasterIntoSvg` is the same
 * string-splice #629 uses (never DOMParser), so the SVG body is left byte-intact.
 */
export function embedRasterIfWithinBudget(
  svgString: string,
  rasterDataUri: string,
): { svg: string; embedded: boolean; reason?: string } {
  const dataUri = normalizeRasterDataUri(rasterDataUri);
  const decodedBytes = decodedBase64ByteLength(dataUri);
  if (decodedBytes === 0) {
    return { svg: svgString, embedded: false, reason: "empty raster" };
  }
  if (!isWithinRasterBudget(decodedBytes)) {
    return { svg: svgString, embedded: false, reason: "over budget" };
  }
  return { svg: injectRasterIntoSvg(svgString, dataUri), embedded: true };
}

/**
 * Upload guardrail: the bytes about to be uploaded under the `.excalidraw.svg`
 * name MUST be a real SVG (open with `<svg`/`<?xml`). UNLIKE draw.io's
 * isValidDrawioSvg this does NOT require a `content="<mxfile…"` source attribute
 * — an excalidraw SVG has no mxfile payload; its own `content=` (when
 * exportEmbedScene is on) is an excalidraw scene JSON, not mxgraph. This is the
 * last line of defence against uploading a PNG/garbage under the SVG name.
 */
export function isValidExcalidrawSvg(svgString: string): boolean {
  if (!svgString) return false;
  const head = svgString.replace(/^\uFEFF/, "").trimStart();
  return head.startsWith("<svg") || head.startsWith("<?xml");
}
