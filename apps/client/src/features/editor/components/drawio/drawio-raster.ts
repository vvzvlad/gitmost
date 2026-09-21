// Pure, framework-free helpers for the draw.io PNG-raster embedding feature
// (issue #629, Part A). These are deliberately side-effect free so the tricky
// bits (format dispatch, string-splice injection, the upload guardrail, the
// xml-state compare and the size budget) can be unit-tested without a browser
// or a live draw.io embed. The React orchestration lives in
// `use-drawio-raster-save.ts`; everything testable lives here.

// SHARED CONTRACT with the server/mcp consumers (Part B): the raster is stored
// as a root attribute on the `<svg …>` element. There is no shared package with
// mcp, so the attribute name is declared here as a named constant and mirrored
// verbatim on the consumer side.
export const DRAWIO_RASTER_ATTR = "data-raster";

// The exact data-URI prefix Part B keys on before base64-decoding and checking
// the 8-byte PNG signature. Must stay byte-identical on both sides.
export const RASTER_DATA_URI_PREFIX = "data:image/png;base64,";

// Size cap for the embedded raster, measured by DECODED bytes (A6). Over budget
// we step DOWN the scale ladder (see RASTER_*_SCALE below); if even the smallest
// scale is still over, we give up and save without a raster.
export const MAX_RASTER_BYTES = 2 * 1024 * 1024; // 2 MiB

// PNG export scale ladder (issue #629 follow-up: retina quality). draw.io's
// default png export is 1x, which looks soft on hi-DPI screens and whenever the
// diagram is shown wider than its native px size. We export at 2x for crisp
// text/lines and, on over-budget, step DOWN this ladder (2 -> 1 -> 0.5) instead
// of jumping straight to the smallest — so a big/dense diagram keeps the best
// scale that still fits MAX_RASTER_BYTES rather than collapsing to half-res.
export const RASTER_PRIMARY_SCALE = 2;
export const RASTER_DOWNSCALE_STEPS: readonly number[] = [1, 0.5];

// After this many consecutive failed/timed-out png exports in one editing
// session we stop attempting png so a broken export server does not add the
// per-export timeout to every save (A6 circuit-breaker).
export const RASTER_CIRCUIT_BREAKER_THRESHOLD = 3;

// react-drawio export format families. draw.io answers an `exportDiagram` with
// an `export` event whose `format` is one of these; we route the response by
// FAMILY (A2), never by the exact string, so a deployment that returns `xmlpng`
// instead of `png` still lands in the raster bucket.
export type ExportFamily = "svg" | "png";

/**
 * Classify a react-drawio export `format` into its family, or `null` for a
 * format we never request (so an unrecognised/unrequested response is ignored
 * rather than mis-routed). svg-like: `svg`, `xmlsvg`. png-like: `png`, `xmlpng`.
 */
export function classifyExportFormat(
  format: string | undefined | null,
): ExportFamily | null {
  switch (format) {
    case "svg":
    case "xmlsvg":
      return "svg";
    case "png":
    case "xmlpng":
      return "png";
    default:
      return null;
  }
}

/**
 * Normalize a raster payload draw.io handed us into the canonical
 * `data:image/png;base64,<b64>` data-URI Part B expects. draw.io usually returns
 * an already-prefixed data-URL for image formats, but if it returns a bare
 * base64 string we prepend the png prefix (A4).
 */
export function normalizeRasterDataUri(data: string): string {
  const trimmed = data.trim();
  if (trimmed.startsWith("data:")) {
    return trimmed;
  }
  return RASTER_DATA_URI_PREFIX + trimmed;
}

/**
 * Insert `data-raster="<dataUri>"` into the opening `<svg …>` tag by STRING
 * SPLICE — never via DOMParser/XMLSerializer, which would re-encode the
 * `content="&lt;mxfile…"` source payload (`&lt;` -> `&amp;lt;`) and corrupt the
 * one source copy (A4).
 *
 * The anchor is `/<svg\b[^>]*>/` so we land on the real SVG root tag and NOT
 * inside the `<?xml …?>` prolog (an `indexOf('>')` would). If the tag already
 * carries a `data-raster` attribute (idempotent re-save) it is replaced.
 *
 * Throws if the string has no `<svg …>` opening tag — callers must have a real
 * SVG in hand (the guardrail enforces this separately before upload).
 */
export function injectRasterIntoSvg(
  svgString: string,
  rasterDataUri: string,
): string {
  const match = svgString.match(/<svg\b[^>]*>/);
  if (!match || match.index === undefined) {
    throw new Error("injectRasterIntoSvg: no <svg> opening tag found");
  }

  const dataUri = normalizeRasterDataUri(rasterDataUri);
  let openTag = match[0];

  // Drop any pre-existing data-raster attribute so re-saves don't accumulate.
  openTag = openTag.replace(
    new RegExp(`\\s${DRAWIO_RASTER_ATTR}="[^"]*"`, "g"),
    "",
  );

  // The value is a base64 data-URI: only [A-Za-z0-9+/=:;,.-] — no `"`/`<`/`>`/`&`
  // — so it is safe inside a double-quoted attribute without XML-escaping.
  const isSelfClosing = openTag.endsWith("/>");
  const closeLen = isSelfClosing ? 2 : 1;
  const injectedTag =
    openTag.slice(0, openTag.length - closeLen) +
    ` ${DRAWIO_RASTER_ATTR}="${dataUri}"` +
    openTag.slice(openTag.length - closeLen);

  return (
    svgString.slice(0, match.index) +
    injectedTag +
    svgString.slice(match.index + match[0].length)
  );
}

// A `content="…"` attribute whose value begins (after optional whitespace) with
// an ENTITY-ENCODED `<` in any form, followed by the mxgraph root element. This
// is what proves the SVG still carries its drawio source, without pinning us to
// one specific encoding draw.io happens to emit today:
//   - named:   `&lt;`
//   - decimal: `&#60;`   (optional leading zeros, e.g. `&#060;`)
//   - hex:     `&#x3c;`  (case-insensitive `x`/hex digit, optional leading zeros)
// then the root element `mxfile` (current) OR `mxGraphModel` (older exports).
// Kept deliberately loose: the guardrail's ONLY job is "is this a real drawio
// SVG carrying its source", so it must never reject a legitimate save just
// because a build switched to numeric char-refs — that would hard-fail EVERY
// save. (Corruption of the payload is prevented separately by the string-splice
// inject; a PNG / non-drawio SVG is still rejected because it lacks this attr.)
const DRAWIO_SOURCE_ATTR_RE =
  /content="\s*(?:&lt;|&#0*60;|&#[xX]0*3[cC];)(?:mxfile|mxGraphModel)/;

/**
 * Write-guardrail (A5): the bytes about to be uploaded under the `.svg` name
 * MUST be a real drawio SVG carrying the mxgraph source — i.e. it opens with
 * `<svg`/`<?xml` AND carries a `content="` source attribute whose value is an
 * entity-encoded `<mxfile`/`<mxGraphModel` (see `DRAWIO_SOURCE_ATTR_RE`). This
 * is the last line of defence against overwriting the single source copy with a
 * PNG or a source-stripped SVG.
 */
export function isValidDrawioSvg(svgString: string): boolean {
  if (!svgString) return false;
  const head = svgString.replace(/^\uFEFF/, "").trimStart();
  const startsOk = head.startsWith("<svg") || head.startsWith("<?xml");
  const hasSource = DRAWIO_SOURCE_ATTR_RE.test(svgString);
  return startsOk && hasSource;
}

/**
 * Strip EVERY attribute from the root `<mxfile …>` opening tag (A3). Every
 * attribute on the `<mxfile>` wrapper — `host`, `modified`, `agent`, `etag`,
 * `version`, `type`, `pages`, `scale`, `border`, … — is environment metadata
 * recorded by whichever draw.io instance produced the export; none of it
 * affects the actual diagram content, which lives entirely in the `<mxfile>`
 * children (`<diagram>`/`<mxGraphModel>`/`<mxCell>`). Reducing the wrapper to a
 * bare `<mxfile>` lets two exports of the SAME state — an `xmlsvg` and a plain
 * `png` export made milliseconds apart, which routinely differ in these
 * metadata attrs — compare equal. We only touch the `<mxfile>` opening tag,
 * never its children. Null/empty-safe: returns the input unchanged when falsy.
 */
export function stripVolatileMxfileAttrs(xml: string): string {
  if (!xml) return xml;
  // Preserve an optional self-close so `<mxfile/>` stays `<mxfile/>` (never
  // dropping the `/`); only the root tag's attributes are removed.
  return xml.replace(/<mxfile\b[^>]*?(\/?)>/, "<mxfile$1>");
}

/**
 * Compare two mxgraph sources for the SAME diagram state, ignoring the volatile
 * `<mxfile>` wrapper attributes (A3). Used to confirm the svg export and the png
 * export captured the same state before embedding the raster.
 *
 * Robust by construction: null/undefined coerce to "", and if EITHER side is
 * blank after trimming we return `true` — the plain `png` export legitimately
 * returns no `xml`, and it was captured milliseconds after the svg export from
 * the same idle embed, so we trust it rather than dropping the raster. Two
 * non-empty sources are compared after stripping the wrapper attrs and
 * normalizing inter-tag whitespace, so a genuine content change still returns
 * `false`.
 */
export function xmlStatesMatch(a: string, b: string): boolean {
  const aStr = (a ?? "").trim();
  const bStr = (b ?? "").trim();
  if (aStr === "" || bStr === "") return true;
  const norm = (s: string) =>
    stripVolatileMxfileAttrs(s).replace(/>\s+</g, "><").trim();
  return norm(aStr) === norm(bStr);
}

/**
 * Decoded byte length of a base64 payload or `data:…;base64,<b64>` data-URI,
 * computed from the base64 length WITHOUT allocating the decoded buffer (A6
 * budget check). Whitespace inside the base64 (rare) is ignored.
 */
/** Whether a decoded raster size is within the embed budget (A6). */
export function isWithinRasterBudget(decodedBytes: number): boolean {
  return decodedBytes <= MAX_RASTER_BYTES;
}

export function decodedBase64ByteLength(input: string): number {
  if (!input) return 0;
  let b64 = input;
  const comma = b64.indexOf(",");
  if (b64.startsWith("data:") && comma !== -1) {
    b64 = b64.slice(comma + 1);
  }
  b64 = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  if (b64.length === 0) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor(b64.length / 4) * 3 - padding;
}

// ---------------------------------------------------------------------------
// Extracted decision logic for the React hook (`use-drawio-raster-save.ts`).
// These are the state-machine "cores" that were previously inline in the hook
// and thus untestable without a browser/editor; pulled out here so the hook's
// riskiest decisions get real unit-test regression protection (issue #629 M3).
// The hook wires refs/timers/ProseMirror around these; that plumbing stays in
// the hook and is genuinely lifecycle-bound.
// ---------------------------------------------------------------------------

/**
 * Decide which pending export a draw.io `export` response settles (A2): classify
 * the response `format` into a family, then accept it ONLY if a request for that
 * family is actually pending. Returns the family to resolve, or `null` to ignore
 * the response — an unknown/unrequested format, or a duplicate/stray response
 * (e.g. draw.io's own auto-`xmlsvg` on Save) for which nothing is waiting.
 */
export function resolveExportFamily(
  format: string | undefined | null,
  hasPendingFamily: (family: ExportFamily) => boolean,
): ExportFamily | null {
  const family = classifyExportFormat(format);
  if (!family) return null;
  if (!hasPendingFamily(family)) return null;
  return family;
}

/** Circuit-breaker state for png export failures in one editing session (A6). */
export interface CircuitBreakerState {
  /** Consecutive png export FAILURES (timeout/error). Reset by any completed export. */
  failCount: number;
  /** Once true, png generation is skipped for the rest of the session (latched). */
  broken: boolean;
}

/**
 * Outcome of one png export attempt, from the circuit-breaker's point of view:
 * - `"raster"`  — export completed and produced a usable raster.
 * - `"skip"`    — export COMPLETED but we chose not to embed it (over budget or
 *                 state mismatch). A completed round-trip proves the server
 *                 works, so it does NOT count as a failure — it resets the streak.
 * - `"failure"` — the export threw / timed out (a real server failure).
 */
export type RasterExportOutcome = "raster" | "skip" | "failure";

/**
 * Advance the png circuit-breaker (A6). A completed export (`raster` or `skip`)
 * clears the consecutive-failure count; a `failure` increments it and, once it
 * reaches `threshold`, latches the breaker open. `broken` is terminal for the
 * session: a completed export cannot re-close it, because once open we never
 * attempt an export that could produce one.
 */
export function nextCircuitBreakerState(
  state: CircuitBreakerState,
  outcome: RasterExportOutcome,
  threshold: number,
): CircuitBreakerState {
  if (outcome === "failure") {
    const failCount = state.failCount + 1;
    return { failCount, broken: state.broken || failCount >= threshold };
  }
  // raster | skip: a completed round-trip clears the failure streak.
  return { failCount: 0, broken: state.broken };
}

/**
 * Resolve the effective `updateSrc` when an explicit Save coalesces onto an
 * already in-flight save (A7 / M2). The STRONGEST `updateSrc` of the coalesced
 * callers wins: an explicit Save (`updateSrc:true`, which refreshes the node's
 * visible `src`/`?t=`) must never be downgraded to an autosave's
 * `updateSrc:false`, or the diagram keeps showing the stale image until reload.
 */
export function resolveEffectiveUpdateSrc(
  current: boolean,
  incoming: boolean,
): boolean {
  return current || incoming;
}
