/**
 * Worker-thread body for the SVG -> PNG rasterizer.
 *
 * Why a worker at all: a resvg (wasm) render is a synchronous, uninterruptible
 * call. Running it on the main thread would mean a pathological SVG could pin
 * the event loop with no way to enforce a timeout. Isolating it in a long-lived
 * worker lets the main thread enforce a wall-clock budget by terminating this
 * thread (see rasterize.ts).
 *
 * Lifecycle: wasm + font are initialised exactly ONCE per worker (initWasm is a
 * process/thread-global one-shot), then the worker serves a queue of jobs. The
 * main thread posts { jobId, svg, opts } and gets back { jobId, png, ... } or
 * { jobId, error }.
 *
 * This file compiles to dist/integrations/ai/rasterize/rasterize.worker.js and
 * is spawned by its compiled path at runtime (see rasterize.ts).
 */
import { parentPort } from 'node:worker_threads';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { loadFontBuffer, loadWasmBytes } from './rasterize.assets';
import {
  RASTER_DEFAULT_BACKGROUND,
  RASTER_DEFAULT_FONT_FAMILY,
  RASTER_MAX_LONGEST_SIDE_PX,
} from './rasterize.constants';

export interface RasterJobOptions {
  maxLongestSidePx?: number;
  background?: string;
}

export interface RasterJobMessage {
  jobId: number;
  svg: string;
  opts?: RasterJobOptions;
}

export interface RasterJobReply {
  jobId: number;
  png?: Uint8Array;
  width?: number;
  height?: number;
  error?: string;
}

if (!parentPort) {
  throw new Error('rasterize.worker must be run as a worker thread');
}
const port = parentPort;

// One-shot init promise. If init fails we clear it so a later job can retry
// (e.g. a transient asset-read error) rather than wedging the worker forever.
let ready: Promise<Buffer> | null = null;

function ensureReady(): Promise<Buffer> {
  if (!ready) {
    ready = (async () => {
      // Compile then init: initWasm accepts a compiled Module and may only be
      // called once per thread, which this worker guarantees.
      const module = await WebAssembly.compile(new Uint8Array(loadWasmBytes()));
      await initWasm(module);
      return loadFontBuffer();
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

/**
 * Build the resvg font options. Every generic family is pointed at the single
 * embedded family so that drawio's `Helvetica, Arial, sans-serif` (and any
 * other unknown family) resolves to DejaVu Sans, which covers Cyrillic.
 */
function fontOptions(font: Buffer) {
  return {
    fontBuffers: [new Uint8Array(font)],
    defaultFontFamily: RASTER_DEFAULT_FONT_FAMILY,
    serifFamily: RASTER_DEFAULT_FONT_FAMILY,
    sansSerifFamily: RASTER_DEFAULT_FONT_FAMILY,
    cursiveFamily: RASTER_DEFAULT_FONT_FAMILY,
    fantasyFamily: RASTER_DEFAULT_FONT_FAMILY,
    monospaceFamily: RASTER_DEFAULT_FONT_FAMILY,
  };
}

function render(
  font: Buffer,
  svg: string,
  opts?: RasterJobOptions,
): { png: Buffer; width: number; height: number } {
  const requested =
    opts?.maxLongestSidePx && opts.maxLongestSidePx > 0
      ? opts.maxLongestSidePx
      : RASTER_MAX_LONGEST_SIDE_PX;
  // RASTER_MAX_LONGEST_SIDE_PX is a HARD ceiling: it bounds the rendered pixmap
  // allocation, so the per-call override may only LOWER it, never raise it. A
  // caller passing a huge maxLongestSidePx must not be able to request an
  // unbounded raster and OOM the worker (F1) — the const is the security cap.
  const maxSide = Math.min(requested, RASTER_MAX_LONGEST_SIDE_PX);
  const background = opts?.background ?? RASTER_DEFAULT_BACKGROUND;
  const font_ = fontOptions(font);

  // First pass with the intrinsic size to learn the SVG's natural dimensions.
  let resvg = new Resvg(svg, { font: font_, background });
  const intrinsicW = resvg.width;
  const intrinsicH = resvg.height;

  // Downscale only if the longest side exceeds the ceiling; otherwise keep the
  // original size. resvg preserves aspect ratio when fitTo constrains one axis.
  if (Math.max(intrinsicW, intrinsicH) > maxSide) {
    resvg.free();
    const fitTo =
      intrinsicW >= intrinsicH
        ? { mode: 'width' as const, value: maxSide }
        : { mode: 'height' as const, value: maxSide };
    resvg = new Resvg(svg, { font: font_, background, fitTo });
  }

  // Render + encode inside try/finally so a throw mid-render (the SVG parsed in
  // the constructor but the render/encode phase fails) still frees the wasm
  // memory. `resvg` here is the CURRENT instance: in the downscale branch the
  // first instance was already freed before reassignment, so `resvg.free()`
  // below only frees the second one (no double-free of the discarded first).
  // RenderedImage is not exported by the package, so infer it from the instance.
  let rendered: ReturnType<typeof resvg.render> | undefined;
  try {
    rendered = resvg.render();
    // Copy the PNG out of the wasm-owned image before freeing it.
    const png = Buffer.from(rendered.asPng());
    const width = rendered.width;
    const height = rendered.height;
    return { png, width, height };
  } finally {
    // Free wasm memory for both the rendered image (if created) and the parser.
    rendered?.free();
    resvg.free();
  }
}

port.on('message', (msg: RasterJobMessage) => {
  const { jobId } = msg;
  ensureReady()
    .then((font) => {
      const { png, width, height } = render(font, msg.svg, msg.opts);
      const reply: RasterJobReply = { jobId, png, width, height };
      port.postMessage(reply);
    })
    .catch((err: unknown) => {
      const reply: RasterJobReply = {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      };
      port.postMessage(reply);
    });
});
