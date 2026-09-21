/**
 * Policy constants for the in-process SVG -> PNG rasterizer.
 *
 * Each constant carries a documented rationale and is overridable via an
 * environment variable so ops can tune limits without a redeploy. The env
 * override is read once at module load (except the timeout, which is resolved
 * per job so tests can lower it cheaply).
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Cap on the longest output side in pixels. Schematics and arbitrary SVG
 * attachments rarely need more than ~1600px to stay legible for on-screen or
 * AI-vision use; capping bounds resvg's raster memory (width*height*4 bytes of
 * RGBA) and the size of the PNG we hand downstream. 1600 -> at most ~10 MB of
 * intermediate RGBA for a square image.
 */
export const RASTER_MAX_LONGEST_SIDE_PX = envInt('RASTER_MAX_LONGEST_SIDE_PX', 1600);

/**
 * Reject SVG source larger than this BEFORE it reaches resvg. 4 MiB is far
 * above any real drawio schematic yet cheaply blocks oversized / billion-laughs
 * style payloads that would otherwise expand inside the wasm heap. Checked on
 * the main thread so the worker never even sees an abusive input.
 */
export const RASTER_MAX_SVG_BYTES = envInt('RASTER_MAX_SVG_BYTES', 4 * 1024 * 1024);

/**
 * Per-job wall-clock budget in milliseconds. A wasm render is synchronous and
 * uninterruptible, so this is enforced by terminating the worker thread (see
 * rasterize.ts). 5s is generous for a legitimate schematic while bounding a
 * pathological SVG (huge blur / element explosion) that would otherwise pin a
 * core indefinitely. Resolved per job so tests can override it via env.
 */
export const RASTER_TIMEOUT_MS = 5000;

/**
 * Default flatten background. drawio schematics assume an opaque white canvas;
 * a transparent default would render black-on-transparent labels invisible in
 * viewers that composite onto a dark surface. Callers may override per job.
 */
export const RASTER_DEFAULT_BACKGROUND = '#ffffff';

/**
 * The embedded font's REAL internal family name (verified with
 * `fc-scan --format '%{family}\n' DejaVuSans.ttf` => "DejaVu Sans").
 *
 * resvg maps an unknown SVG family (e.g. `font-family="Helvetica, Arial,
 * sans-serif"`, as emitted by drawio) onto `defaultFontFamily`. With a SINGLE
 * embedded font, resvg falls back to that one font for ANY family, so an exact
 * match here is not strictly required for text to render (verified by mutation:
 * setting this to a bogus name still renders ink). The actual hard requirement
 * is a NON-EMPTY fontBuffers — an empty buffer renders every label blank (that
 * is what the ink-gate test locks). Keep this accurate to the vendored font for
 * clarity and so behaviour stays predictable if more fonts are ever added.
 */
export const RASTER_DEFAULT_FONT_FAMILY = 'DejaVu Sans';

/** Resolve the per-job timeout, honouring a RASTER_TIMEOUT_MS env override. */
export function resolveTimeoutMs(): number {
  return envInt('RASTER_TIMEOUT_MS', RASTER_TIMEOUT_MS);
}
