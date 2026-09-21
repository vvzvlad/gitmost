// draw.io (mxGraph) XML support for the MCP drawio tools (issue #423, stage 1).
//
// This module owns everything that is pure data-plumbing for draw.io diagrams:
//   - the DECODE CHAIN that turns a stored `diagram.drawio.svg` attachment back
//     into mxGraph XML (handles both the plain nested-XML form Docmost writes
//     and draw.io's own COMPRESSED `<diagram>` payload — base64 + raw-deflate);
//   - the ENCODE side that wraps mxGraph XML into the `.drawio.svg` attachment
//     using the exact same contract as the import service's createDrawioSvg;
//   - a deterministic LINTER that rejects the structural mistakes generators
//     make before anything is written (each violation carries the offending
//     cellId + position so the model can auto-retry);
//   - a stable HASH over the normalized XML, used as the optimistic-lock key.
//
// HARD CONSTRAINT: no backend rendering. Nothing here shells out or renders a
// bitmap; the only runtime dependencies are jsdom (already used across this
// package for XML parsing) and pako (raw-inflate for the compressed format).

import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import pako from "pako";

// --- shared XML parser -----------------------------------------------------

// A single reusable JSDOM window; constructing one per parse is wasteful and
// these tools are low-frequency. Only the DOMParser is used.
let _window: any = null;
function xmlWindow(): any {
  if (!_window) _window = new JSDOM("").window;
  return _window;
}

/** Default mxGraphModel attributes used when the server wraps a cell list. */
const DEFAULT_MODEL_ATTRS =
  'dx="0" dy="0" grid="1" gridSize="10" page="1" pageWidth="850" pageHeight="1100"';

// --- structured lint errors ------------------------------------------------

export interface DrawioLintIssue {
  /** Machine-readable rule id, e.g. "edge-geometry". */
  rule: string;
  /** Human-readable explanation the model can act on. */
  message: string;
  /** The offending cell's id, when the rule is cell-scoped. */
  cellId?: string;
  /** Extra location info: cell index in <root>, or a parser line:col. */
  position?: string;
}

/**
 * Thrown by the linter and by decode/prepare when the input is unusable. Carries
 * the full list of issues so the caller can surface a structured tool-error the
 * model auto-retries against.
 */
export class DrawioLintError extends Error {
  issues: DrawioLintIssue[];
  constructor(issues: DrawioLintIssue[]) {
    const summary = issues
      .map((i) => {
        const where = [
          i.cellId != null ? `cellId=${i.cellId}` : null,
          i.position != null ? `at ${i.position}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        return `[${i.rule}] ${i.message}${where ? ` (${where})` : ""}`;
      })
      .join("; ");
    super(`drawio lint failed: ${summary}`);
    this.name = "DrawioLintError";
    this.issues = issues;
  }
}

// --- parsed-cell model -----------------------------------------------------

export interface DrawioGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  relative: boolean;
  hasGeometry: boolean;
}

export interface DrawioCell {
  id: string;
  parent?: string;
  source?: string;
  target?: string;
  vertex: boolean;
  edge: boolean;
  value: string;
  style: string;
  styleMap: Record<string, string>;
  /** Non-key/value leading token of the style (a base stylename), if any. */
  baseStyle?: string;
  geometry: DrawioGeometry;
}

export interface DrawioBBox {
  width: number;
  height: number;
}

// --- style parsing ---------------------------------------------------------

/**
 * Parse a draw.io style string into { baseStyle, map }. Grammar:
 *   [stylename;]key=value;key=value;...
 * A single leading token without '=' is the base stylename (e.g. "text" or
 * "ellipse"). Every other non-empty segment must be exactly one key=value pair.
 * Returns `null` (the segment index) on the first malformed segment so the
 * linter can report a precise error.
 */
export function parseStyle(
  style: string,
): { baseStyle?: string; map: Record<string, string>; badSegment?: string } {
  const map: Record<string, string> = {};
  let baseStyle: string | undefined;
  const segments = style.split(";");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i].trim();
    if (seg === "") continue; // trailing/empty segments are fine
    const eq = seg.indexOf("=");
    if (eq === -1) {
      // A bare token is only valid as the FIRST meaningful segment (base style).
      if (baseStyle === undefined && Object.keys(map).length === 0) {
        baseStyle = seg;
        continue;
      }
      return { baseStyle, map, badSegment: seg };
    }
    // A second '=' inside the same segment is malformed.
    if (seg.indexOf("=", eq + 1) !== -1) {
      return { baseStyle, map, badSegment: seg };
    }
    const key = seg.slice(0, eq).trim();
    const val = seg.slice(eq + 1).trim();
    if (key === "") return { baseStyle, map, badSegment: seg };
    map[key] = val;
  }
  return { baseStyle, map };
}

// --- low-level XML helpers -------------------------------------------------

function parseXml(xml: string): { doc: any; error: string | null } {
  const parser = new (xmlWindow().DOMParser)();
  const doc = parser.parseFromString(xml, "application/xml");
  const err = doc.getElementsByTagName("parsererror");
  if (err.length > 0) {
    // jsdom prefixes the message with "line:col:" — keep it as the position.
    return { doc, error: (err[0].textContent || "malformed XML").trim() };
  }
  return { doc, error: null };
}

function num(v: string | null): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Extract the raw `<mxGraphModel …>…</mxGraphModel>` substring, or null. */
function sliceModel(xml: string): string | null {
  const open = xml.indexOf("<mxGraphModel");
  if (open === -1) return null;
  const close = xml.indexOf("</mxGraphModel>", open);
  if (close === -1) {
    // Self-closed empty model, e.g. `<mxGraphModel .../>`.
    const selfClose = xml.indexOf("/>", open);
    if (selfClose !== -1) return xml.slice(open, selfClose + 2);
    return null;
  }
  return xml.slice(open, close + "</mxGraphModel>".length);
}

// --- decode chain ----------------------------------------------------------

/**
 * Read the `content=` attribute out of a `.drawio.svg` string. Docmost writes
 * the mxfile XML entity-encoded there (buildDrawioSvg / createDrawioSvg), which
 * is also how draw.io's own SVG export stores it; older attachments stored a
 * base64 payload instead. The DOM decodes entities for us, so the caller only
 * has to distinguish "starts with '<'" (raw XML) from base64.
 */
export function extractContentAttr(svg: string): string {
  const { doc, error } = parseXml(svg);
  if (!error) {
    const root = doc.documentElement;
    if (root && root.hasAttribute && root.hasAttribute("content")) {
      return root.getAttribute("content") || "";
    }
  }
  // Fallback for a malformed wrapper: pull the attribute directly. The content
  // value itself never contains a double-quote (base64 / entity-encoded XML).
  const m = /content="([^"]*)"/.exec(svg);
  if (m) {
    // Decode the handful of XML entities a raw regex would leave encoded. The
    // numeric char-refs for tab/newline/CR MUST be decoded here too: the DOM
    // path above turns them back into the literal control chars, so this
    // regex fallback has to agree or the two decode paths diverge (#507).
    // `&amp;` is decoded last so an escaped `&amp;#x9;` reads back as the
    // literal text `&#x9;`, not a tab.
    return m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x9;/gi, "\t")
      .replace(/&#9;/g, "\t")
      .replace(/&#xa;/gi, "\n")
      .replace(/&#10;/g, "\n")
      .replace(/&#xd;/gi, "\r")
      .replace(/&#13;/g, "\r")
      .replace(/&amp;/g, "&");
  }
  throw new Error("drawio: SVG has no content= attribute to decode");
}

// --- embedded browser raster (issue #629) ----------------------------------
//
// SHARED CONTRACT with apps/client (Part A produces, this consumes). draw.io's
// `foreignObject` captions only render in a browser, so a server-side resvg
// rasterization of a `.drawio.svg` yields garbage. Part A makes the browser
// embed a real PNG raster of the diagram INTO the same SVG as a ROOT attribute
// `data-raster="data:image/png;base64,<b64>"`. There is no shared package
// between apps/client and packages/mcp, so the attribute NAME is duplicated as
// a named constant per side (the `internal-file-urls` convention).

/** Root SVG attribute carrying the browser-rendered PNG raster (issue #629). */
export const DRAWIO_RASTER_ATTR = "data-raster";

/** The exact data-URI prefix a valid embedded raster must carry. A non-png mime
 * is never accepted (a PNG must never masquerade behind another type, #629). */
const RASTER_DATA_URI_PREFIX = "data:image/png;base64,";

/** PNG 8-byte file signature (89 50 4E 47 0D 0A 1A 0A). A `data-raster` whose
 * decoded bytes do not start with this is a fake/corrupt raster and rejected —
 * `Buffer.from(_, "base64")` silently yields garbage on a malformed URI, so the
 * signature check is what stops a non-PNG leaking into a public article/vision. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Upper bound on the base64 LENGTH of a `data-raster` value we will decode.
 * Capped BEFORE `Buffer.from` so a hostile huge attribute never allocates
 * unbounded memory. 8 MiB of base64 ≈ 6 MiB of PNG — generous for a diagram
 * preview while keeping the decode bounded.
 */
export const MAX_RASTER_BASE64_LENGTH = 8 * 1024 * 1024;

/**
 * Read the `data-raster` attribute from the ROOT `<svg>` element ONLY. Reuses
 * the `parseXml`/`documentElement` path like extractContentAttr, with a regex
 * fallback for a malformed wrapper — the fallback anchors to the OPENING
 * `<svg …>` tag so a nested element's `data-raster` can never be picked up.
 * Returns the raw attribute value, or null when it is absent.
 */
function readRootRasterAttr(svg: string): string | null {
  const { doc, error } = parseXml(svg);
  if (!error) {
    const root = doc.documentElement;
    if (root && root.hasAttribute && root.hasAttribute(DRAWIO_RASTER_ATTR)) {
      return root.getAttribute(DRAWIO_RASTER_ATTR) || "";
    }
  }
  // Malformed wrapper: pull the attribute from the OPENING <svg …> tag ONLY
  // (the first `<svg …>` is the root open tag). The base64 data-URI value never
  // contains `>` or `"`, so `[^>]`/`[^"]` slicing is safe.
  const openTag = /<svg\b[^>]*>/i.exec(svg);
  if (openTag) {
    const m = new RegExp(`\\b${DRAWIO_RASTER_ATTR}\\s*=\\s*"([^"]*)"`, "i").exec(
      openTag[0],
    );
    if (m) return m[1];
  }
  return null;
}

/**
 * Extract and VALIDATE the browser-embedded PNG raster from a `.drawio.svg`.
 * Returns the decoded PNG `Buffer`, or null when there is no usable raster:
 * absent attribute, a non-`data:image/png;base64,` prefix (never accept a
 * non-png mime), an oversized value (capped before decode), or bytes that fail
 * the 8-byte PNG signature check (a fake/corrupt raster). A `.drawio.svg`
 * regenerated by a server tool (buildDrawioSvg) has no such attribute → null,
 * which is a normal, expected "no raster" state.
 */
export function extractDrawioRaster(svg: string): Buffer | null {
  const raw = readRootRasterAttr(svg);
  if (raw == null) return null;
  // Slice at the FIRST comma: `data:image/png;base64,<b64>`. base64 contains no
  // comma, so the first comma is always the data-URI separator.
  const comma = raw.indexOf(",");
  if (comma === -1) return null;
  if (raw.slice(0, comma + 1) !== RASTER_DATA_URI_PREFIX) return null;
  const base64 = raw.slice(comma + 1);
  // Cap the base64 length BEFORE decoding (memory guard).
  if (base64.length === 0 || base64.length > MAX_RASTER_BASE64_LENGTH) {
    return null;
  }
  const png = Buffer.from(base64, "base64");
  if (png.length < PNG_SIGNATURE.length) return null;
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  return png;
}

/**
 * Remove the `data-raster="…"` attribute from a `.drawio.svg` at the STRING
 * level (before any jsdom parse), so a caller can cheaply strip a ~100 KB
 * attribute out of the text — and keep a huge attribute from ever reaching the
 * jsdom parse. Anchors to the opening `<svg …>` tag and touches ONLY
 * `data-raster`; `content=` is left byte-intact.
 */
export function stripRasterAttr(svg: string): string {
  const openTag = /<svg\b[^>]*>/i.exec(svg);
  if (!openTag) return svg;
  const tag = openTag[0];
  const stripped = tag.replace(
    new RegExp(`\\s*\\b${DRAWIO_RASTER_ATTR}\\s*=\\s*"[^"]*"`, "i"),
    "",
  );
  if (stripped === tag) return svg;
  return (
    svg.slice(0, openTag.index) +
    stripped +
    svg.slice(openTag.index + tag.length)
  );
}

/**
 * Turn a decoded draw.io file (`<mxfile>` or a bare `<mxGraphModel>`, possibly
 * with a COMPRESSED `<diagram>` payload) into the mxGraphModel XML. For the
 * plain form the raw substring is returned verbatim so a round-trip stays
 * byte-stable; the compressed form is inflated (base64 → raw-deflate →
 * decodeURIComponent), which is how draw.io stores diagrams by default.
 */
export function decodeDrawioFileToModel(fileXml: string): string {
  // Plain, nested XML: return the model substring untouched (byte-stable).
  const sliced = sliceModel(fileXml);
  if (sliced) return sliced;

  // Otherwise it must be the compressed `<diagram>…</diagram>` text payload.
  const open = fileXml.indexOf("<diagram");
  if (open !== -1) {
    const gt = fileXml.indexOf(">", open);
    const close = fileXml.indexOf("</diagram>", gt);
    if (gt !== -1 && close !== -1) {
      const payload = fileXml.slice(gt + 1, close).trim();
      if (payload) {
        const inflated = inflateDiagramPayload(payload);
        const model = sliceModel(inflated);
        if (model) return model;
        return inflated;
      }
    }
  }
  throw new Error(
    "drawio: could not decode file — no <mxGraphModel> and no compressed <diagram> payload",
  );
}

/**
 * Upper bound on the inflated size of a compressed `<diagram>` payload
 * (decompression-bomb guard). `fetchInternalFile` caps the DOWNLOAD at 64 MiB,
 * but a tiny crafted compressed payload can inflate to gigabytes and OOM the
 * process. A real diagram's mxGraphModel XML is small (KBs to low MBs even for
 * large diagrams), so 16 MiB is far above any legitimate payload while keeping
 * memory bounded. Chars ~= bytes for the (mostly ASCII) URI-encoded XML.
 */
export const MAX_INFLATED_DIAGRAM_BYTES = 16 * 1024 * 1024;

/**
 * Inflate draw.io's compressed diagram payload:
 *   base64-decode → raw-inflate (raw deflate, windowBits -15) →
 *   decodeURIComponent.
 *
 * Uses pako's streaming Inflate so we can abort as soon as the decompressed
 * output exceeds MAX_INFLATED_DIAGRAM_BYTES — the full bomb is never
 * materialised in memory.
 */
export function inflateDiagramPayload(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  const inflator = new pako.Inflate({ raw: true, to: "string" });
  let total = 0;
  const passthrough = inflator.onData.bind(inflator);
  inflator.onData = (chunk: string | Uint8Array) => {
    total += chunk.length;
    if (total > MAX_INFLATED_DIAGRAM_BYTES) {
      // Throwing here propagates out of push(), aborting inflation immediately.
      throw new Error(
        `drawio: refusing to decode diagram — decompressed size exceeds ` +
          `${MAX_INFLATED_DIAGRAM_BYTES} bytes (possible decompression bomb)`,
      );
    }
    passthrough(chunk);
  };
  inflator.push(bytes, true);
  if (inflator.err) {
    throw new Error(
      `drawio: failed to inflate compressed <diagram> payload (${inflator.msg || inflator.err})`,
    );
  }
  const uriEncoded = inflator.result as string;
  return decodeURIComponent(uriEncoded);
}

/** Full decode chain: `.drawio.svg` string → mxGraphModel XML. */
export function decodeDrawioSvg(svg: string): string {
  const content = extractContentAttr(svg).trim();
  const fileXml = content.startsWith("<")
    ? content
    : Buffer.from(content, "base64").toString("utf-8");
  return decodeDrawioFileToModel(fileXml);
}

// --- encode side -----------------------------------------------------------

/**
 * Wrap an mxGraphModel in the plain (uncompressed) `<mxfile><diagram>` envelope.
 * draw.io opens uncompressed XML fine, and staying uncompressed keeps the
 * write path deterministic and the round-trip byte-stable.
 */
export function encodeDrawioFile(modelXml: string, title = "Page-1"): string {
  const safeTitle = xmlEscape(title);
  return `<mxfile host="drawio"><diagram id="page-1" name="${safeTitle}">${modelXml}</diagram></mxfile>`;
}

/**
 * Build the `diagram.drawio.svg` attachment. Mirrors the import service's
 * createDrawioSvg contract exactly:
 *   <svg xmlns=… xmlns:xlink=… content="${xmlEscape(drawioFile)}">${inner}</svg>
 * plus width/height/viewBox from the diagram bounding box and the schematic
 * preview as the visible children (`inner`).
 *
 * The `content=` value is the mxfile XML XML-entity-escaped (draw.io's own
 * native form), NOT base64. draw.io's editor decodes a base64 content= via
 * Latin-1 atob (no UTF-8 step), turning every non-ASCII char (e.g. Cyrillic,
 * ё, —) into mojibake; the entity-encoded form is decoded by the DOM as UTF-8
 * and opens intact. Our decoder (decodeDrawioSvg) reads both forms, so old
 * base64 attachments still round-trip.
 */
export function buildDrawioSvg(
  modelXml: string,
  inner: string,
  bbox: DrawioBBox,
  title = "Page-1",
): string {
  const file = encodeDrawioFile(modelXml, title);
  const content = xmlEscape(file);
  const w = Math.max(1, Math.round(bbox.width));
  const h = Math.max(1, Math.round(bbox.height));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `content="${content}">${inner}</svg>`
  );
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // A literal tab/newline/CR inside an attribute value is collapsed to a
    // single space by XML attribute-value normalization on DOM read (both jsdom
    // here and the real draw.io editor), silently flattening multi-line labels
    // and tab-bearing values. Numeric char-refs survive that normalization, so
    // emit them the way draw.io's own native export does (#507).
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xa;")
    .replace(/\r/g, "&#xd;");
}

// --- normalization + hash --------------------------------------------------

/**
 * Normalize mxGraph XML for hashing / stable comparison: drop the whitespace
 * between tags and trim. This is intentionally conservative — it never reorders
 * attributes or cells (that would be lossy) — so two documents hash equal iff
 * they differ only in inter-tag formatting.
 */
export function normalizeXml(xml: string): string {
  return xml.replace(/>\s+</g, "><").trim();
}

/** Stable optimistic-lock hash over the normalized model XML (sha256, hex). */
export function mxHash(modelXml: string): string {
  return createHash("sha256").update(normalizeXml(modelXml), "utf-8").digest("hex");
}

// --- cell parsing ----------------------------------------------------------

/** Parse every `<mxCell>` in a model into a structured DrawioCell list. */
export function parseCells(modelXml: string): DrawioCell[] {
  const { doc, error } = parseXml(modelXml);
  if (error) {
    throw new DrawioLintError([
      { rule: "well-formed-xml", message: error, position: firstLineCol(error) },
    ]);
  }
  const cells: DrawioCell[] = [];
  const els = doc.getElementsByTagName("mxCell");
  for (let i = 0; i < els.length; i++) {
    cells.push(readCell(els[i]));
  }
  return cells;
}

function readCell(el: any): DrawioCell {
  const style = el.getAttribute("style") || "";
  const parsed = parseStyle(style);
  const geoEl = firstChildByTag(el, "mxGeometry");
  const geometry: DrawioGeometry = geoEl
    ? {
        x: num(geoEl.getAttribute("x")),
        y: num(geoEl.getAttribute("y")),
        width: num(geoEl.getAttribute("width")),
        height: num(geoEl.getAttribute("height")),
        relative: geoEl.getAttribute("relative") === "1",
        hasGeometry: true,
      }
    : { relative: false, hasGeometry: false };
  return {
    id: el.getAttribute("id") ?? "",
    parent: el.getAttribute("parent") ?? undefined,
    source: el.getAttribute("source") ?? undefined,
    target: el.getAttribute("target") ?? undefined,
    vertex: el.getAttribute("vertex") === "1",
    edge: el.getAttribute("edge") === "1",
    value: el.getAttribute("value") ?? "",
    style,
    styleMap: parsed.map,
    baseStyle: parsed.baseStyle,
    geometry,
  };
}

function firstChildByTag(el: any, tag: string): any {
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === 1 && c.tagName === tag) return c;
  }
  return null;
}

function firstLineCol(msg: string): string | undefined {
  const m = /^(\d+:\d+)/.exec(msg);
  return m ? m[1] : undefined;
}

// --- bounding box ----------------------------------------------------------

/**
 * Absolute bounding box of the diagram from its vertex geometries. Container
 * children are relative, so absolute positions are resolved along the parent
 * chain before taking the extent. Falls back to a default canvas when empty.
 */
export function computeBBox(cells: DrawioCell[]): DrawioBBox {
  const byId = new Map(cells.map((c) => [c.id, c]));
  let maxX = 0;
  let maxY = 0;
  let any = false;
  for (const c of cells) {
    if (!c.vertex || !c.geometry.hasGeometry) continue;
    const g = c.geometry;
    if (g.width == null || g.height == null) continue;
    const { x, y } = absolutePos(c, byId);
    maxX = Math.max(maxX, x + g.width);
    maxY = Math.max(maxY, y + g.height);
    any = true;
  }
  if (!any) return { width: 300, height: 200 };
  // A small margin so borders/labels are not clipped at the edge.
  return { width: Math.ceil(maxX) + 20, height: Math.ceil(maxY) + 20 };
}

/** Absolute (x,y) of a vertex, following its parent chain (containers). */
export function absolutePos(
  cell: DrawioCell,
  byId: Map<string, DrawioCell>,
): { x: number; y: number } {
  let x = cell.geometry.x ?? 0;
  let y = cell.geometry.y ?? 0;
  const seen = new Set<string>([cell.id]);
  let parentId = cell.parent;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const p = byId.get(parentId);
    // Sentinels (0/1) carry no geometry; stop there.
    if (!p || !p.vertex || !p.geometry.hasGeometry) break;
    x += p.geometry.x ?? 0;
    y += p.geometry.y ?? 0;
    parentId = p.parent;
  }
  return { x, y };
}

// --- quality warnings (geometry, non-blocking) -----------------------------
//
// These are computed purely from geometry — NO rendering — and are returned as
// WARNINGS (never errors): they do not block the write, they nudge the model to
// self-correct ("fix the warnings and retry, max 2 iterations"). They replace
// the vision-self-check a render backend would have done.

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Absolute rect of a vertex (following the container chain), or null. */
function rectOf(cell: DrawioCell, byId: Map<string, DrawioCell>): Rect | null {
  if (!cell.vertex || !cell.geometry.hasGeometry) return null;
  const g = cell.geometry;
  if (g.width == null || g.height == null) return null;
  const { x, y } = absolutePos(cell, byId);
  return { x, y, w: g.width, h: g.height };
}

/** True if `ancestorId` is somewhere up `cell`'s parent chain. */
function isAncestor(
  ancestorId: string,
  cell: DrawioCell,
  byId: Map<string, DrawioCell>,
): boolean {
  const seen = new Set<string>([cell.id]);
  let p = cell.parent;
  while (p && !seen.has(p)) {
    if (p === ancestorId) return true;
    seen.add(p);
    p = byId.get(p)?.parent;
  }
  return false;
}

/** Strict interior overlap of two rects (touching edges do NOT count). */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Liang-Barsky: does segment p->q pass through the INTERIOR of rect r? Used to
 * detect an edge crossing a shape that is not one of its endpoints.
 */
function segCrossesRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  r: Rect,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Canonical Liang-Barsky: for each of the 4 slabs, p*t <= q.
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false; // parallel to this slab AND outside it
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t1 > t0; // strictly non-degenerate overlap with the rect interior
}

function cross(
  ox: number,
  oy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Collinear + overlapping test for two straight segments (edge-on-edge). */
function segmentsOverlap(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): boolean {
  const EPS = 1;
  // b1 and b2 must be (near-)collinear with segment a.
  if (
    Math.abs(cross(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y)) > EPS * dist(a1, a2) ||
    Math.abs(cross(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y)) > EPS * dist(a1, a2)
  ) {
    return false;
  }
  // Project all four points onto the dominant axis and test 1-D overlap length.
  const horizontal = Math.abs(a2.x - a1.x) >= Math.abs(a2.y - a1.y);
  const pa = horizontal ? [a1.x, a2.x] : [a1.y, a2.y];
  const pb = horizontal ? [b1.x, b2.x] : [b1.y, b2.y];
  const loA = Math.min(pa[0], pa[1]);
  const hiA = Math.max(pa[0], pa[1]);
  const loB = Math.min(pb[0], pb[1]);
  const hiB = Math.max(pb[0], pb[1]);
  const overlap = Math.min(hiA, hiB) - Math.max(loA, loB);
  return overlap > 5; // >5px of shared collinear run
}

function dist(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
}

/** Approximate rendered text width (px) of a cell value at a font size. */
function estimateLabelWidth(value: string, fontSize: number): number {
  // Decode explicit line breaks, strip tags/entities, take the longest line.
  const lines = value
    .replace(/&#xa;/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, "x")
    .split("\n");
  let longest = 0;
  for (const l of lines) longest = Math.max(longest, l.trim().length);
  // ~0.6em per glyph is a decent average for proportional fonts.
  return longest * fontSize * 0.6;
}

/** Page size declared on the model root, defaulting to Letter (850x1100). */
function parsePageSize(modelXml: string): { w: number; h: number } {
  const w = /pageWidth="(\d+)"/.exec(modelXml);
  const h = /pageHeight="(\d+)"/.exec(modelXml);
  return {
    w: w ? Number(w[1]) : 850,
    h: h ? Number(h[1]) : 1100,
  };
}

/** Minimum required gap between adjacent shapes (appendix heuristic). */
export const MIN_SHAPE_GAP = 150;

/**
 * Compute the geometry-derived quality warnings for a parsed model. Each is a
 * `[rule] message` string. Pure — no rendering, no I/O.
 */
export function computeQualityWarnings(
  cells: DrawioCell[],
  modelXml?: string,
): string[] {
  const warnings: string[] = [];
  const byId = new Map(cells.map((c) => [c.id, c]));
  const verts = cells.filter((c) => c.vertex && c.id !== "0" && c.id !== "1");
  const isContainer = (id: string) =>
    verts.some((v) => v.parent === id);
  const rects = new Map<string, Rect>();
  for (const v of verts) {
    const r = rectOf(v, byId);
    if (r) rects.set(v.id, r);
  }

  // 1. Shape bbox overlap (excluding a container overlapping its own child).
  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      const a = verts[i];
      const b = verts[j];
      const ra = rects.get(a.id);
      const rb = rects.get(b.id);
      if (!ra || !rb) continue;
      if (isAncestor(a.id, b, byId) || isAncestor(b.id, a, byId)) continue;
      if (rectsOverlap(ra, rb)) {
        warnings.push(
          `[shape-overlap] shapes "${a.id}" and "${b.id}" overlap; separate them (>=${MIN_SHAPE_GAP}px apart) or use layout:"elk"`,
        );
      }
    }
  }

  // 2. Edge passing through a non-endpoint LEAF shape's bbox.
  const edges = cells.filter((c) => c.edge);
  for (const e of edges) {
    if (!e.source || !e.target) continue;
    const rs = rects.get(e.source);
    const rt = rects.get(e.target);
    if (!rs || !rt) continue;
    const p = center(rs);
    const q = center(rt);
    for (const v of verts) {
      if (v.id === e.source || v.id === e.target) continue;
      if (isContainer(v.id)) continue; // an edge legitimately crosses container frames
      const rv = rects.get(v.id);
      if (!rv) continue;
      // shrink to avoid flagging a graze at a shared layer boundary
      const shrunk: Rect = { x: rv.x + 6, y: rv.y + 6, w: rv.w - 12, h: rv.h - 12 };
      if (shrunk.w <= 0 || shrunk.h <= 0) continue;
      if (segCrossesRect(p, q, shrunk)) {
        warnings.push(
          `[edge-through-shape] edge "${e.id}" passes through shape "${v.id}" (not its source/target); add exitX/exitY/entryX/entryY or a waypoint`,
        );
        break;
      }
    }
  }

  // 3. Edge-on-edge overlap (parallel duplicates or collinear shared runs).
  const edgeSegs: { id: string; a: any; b: any; key: string }[] = [];
  for (const e of edges) {
    if (!e.source || !e.target) continue;
    const rs = rects.get(e.source);
    const rt = rects.get(e.target);
    if (!rs || !rt) continue;
    const key = [e.source, e.target].sort().join("::");
    edgeSegs.push({ id: e.id, a: center(rs), b: center(rt), key });
  }
  for (let i = 0; i < edgeSegs.length; i++) {
    for (let j = i + 1; j < edgeSegs.length; j++) {
      const ea = edgeSegs[i];
      const eb = edgeSegs[j];
      const dup = ea.key === eb.key;
      if (dup || segmentsOverlap(ea.a, ea.b, eb.a, eb.b)) {
        warnings.push(
          `[edge-overlap] edges "${ea.id}" and "${eb.id}" lie on top of each other; offset one (distinct exit/entry points) or reroute`,
        );
      }
    }
  }

  // 4. Adjacent SIBLING leaf shapes closer than MIN_SHAPE_GAP.
  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      const a = verts[i];
      const b = verts[j];
      if ((a.parent ?? "") !== (b.parent ?? "")) continue;
      if (isContainer(a.id) || isContainer(b.id)) continue;
      const ra = rects.get(a.id);
      const rb = rects.get(b.id);
      if (!ra || !rb || rectsOverlap(ra, rb)) continue;
      const yOverlap = ra.y < rb.y + rb.h && rb.y < ra.y + ra.h;
      const xOverlap = ra.x < rb.x + rb.w && rb.x < ra.x + ra.w;
      let gap = Infinity;
      if (yOverlap) {
        gap = Math.min(
          gap,
          ra.x >= rb.x ? ra.x - (rb.x + rb.w) : rb.x - (ra.x + ra.w),
        );
      }
      if (xOverlap) {
        gap = Math.min(
          gap,
          ra.y >= rb.y ? ra.y - (rb.y + rb.h) : rb.y - (ra.y + ra.h),
        );
      }
      if (gap > 0 && gap < MIN_SHAPE_GAP) {
        warnings.push(
          `[gap-too-small] shapes "${a.id}" and "${b.id}" are ${Math.round(gap)}px apart (<${MIN_SHAPE_GAP}px); increase spacing`,
        );
      }
    }
  }

  // 5. Label visibly wider than its shape (skip labels drawn OUTSIDE the shape).
  for (const v of verts) {
    if (!v.value || isContainer(v.id)) continue;
    if (v.styleMap.verticalLabelPosition || v.styleMap.labelPosition) continue;
    const r = rects.get(v.id);
    if (!r) continue;
    const fontSize = Number(v.styleMap.fontSize) || 12;
    const est = estimateLabelWidth(v.value, fontSize);
    if (est > r.w * 1.15) {
      warnings.push(
        `[label-overflow] label of "${v.id}" (~${Math.round(est)}px) is wider than its shape (${r.w}px); widen it, shorten the text, or wrap with &#xa;`,
      );
    }
  }

  // 6. Negative / off-page (top-left) coordinates.
  const page = parsePageSize(modelXml ?? "");
  for (const v of verts) {
    const r = rects.get(v.id);
    if (!r) continue;
    if (r.x < 0 || r.y < 0) {
      warnings.push(
        `[out-of-bounds] shape "${v.id}" has negative coordinates (${Math.round(r.x)},${Math.round(r.y)}); move it into the positive quadrant (page ${page.w}x${page.h})`,
      );
    }
  }

  return warnings;
}

// --- linter ----------------------------------------------------------------

/**
 * Run every deterministic pre-write rule over a full mxGraphModel string. On any
 * violation it throws a DrawioLintError carrying one issue per violation, each
 * with the offending cellId + position. Returns the parsed cells on success.
 */
export function lintModel(modelXml: string): {
  cells: DrawioCell[];
  warnings: string[];
} {
  const issues: DrawioLintIssue[] = [];
  const warnings: string[] = [];

  // Rule: no XML comments. Checked on the raw string (a comment survives DOM
  // parsing as a comment node, but the intent is to reject them outright — they
  // routinely wrap "TODO" cruft that breaks downstream tooling).
  if (modelXml.includes("<!--")) {
    issues.push({
      rule: "no-comments",
      message: "XML comments (<!-- -->) are not allowed in diagram XML",
    });
  }

  // Rule: value escaping + literal newline. Scan raw <mxCell> tags so the error
  // can name the cell id even when the whole document is otherwise malformed.
  scanRawValues(modelXml, issues);

  // Well-formedness — everything below needs a parsed DOM.
  const { doc, error } = parseXml(modelXml);
  if (error) {
    issues.push({
      rule: "well-formed-xml",
      message: error,
      position: firstLineCol(error),
    });
    throw new DrawioLintError(issues);
  }

  const root = doc.documentElement;
  if (!root || root.tagName !== "mxGraphModel") {
    issues.push({
      rule: "structure",
      message: `root element must be <mxGraphModel>, got <${root ? root.tagName : "?"}>`,
    });
    throw new DrawioLintError(issues);
  }
  if (!firstChildByTag(root, "root")) {
    issues.push({
      rule: "structure",
      message: "<mxGraphModel> must contain a <root> element",
    });
    throw new DrawioLintError(issues);
  }

  const cells = parseCells(modelXml);
  const ids = new Set<string>();

  // Rule: sentinel cells id="0" and id="1"(parent="0").
  const cell0 = cells.find((c) => c.id === "0");
  const cell1 = cells.find((c) => c.id === "1");
  if (!cell0) {
    issues.push({
      rule: "sentinel-cells",
      message: 'missing the root sentinel cell <mxCell id="0"/>',
      cellId: "0",
    });
  }
  if (!cell1) {
    issues.push({
      rule: "sentinel-cells",
      message: 'missing the layer sentinel cell <mxCell id="1" parent="0"/>',
      cellId: "1",
    });
  } else if (cell1.parent !== "0") {
    issues.push({
      rule: "sentinel-cells",
      message: 'the layer sentinel <mxCell id="1"> must have parent="0"',
      cellId: "1",
    });
  }

  cells.forEach((c, index) => {
    const pos = `cell #${index}`;
    const isSentinel = c.id === "0" || c.id === "1";

    // Rule: unique, non-empty ids; user cells must not reuse 0/1.
    if (c.id === "") {
      issues.push({ rule: "cell-id", message: "cell has an empty id", position: pos });
    } else if (ids.has(c.id)) {
      issues.push({
        rule: "duplicate-id",
        message: `duplicate cell id "${c.id}"`,
        cellId: c.id,
        position: pos,
      });
    }
    ids.add(c.id);

    if (isSentinel) return; // sentinels are exempt from the shape rules below

    // Rule: vertex XOR edge (a cell may be neither: groups/containers).
    if (c.vertex && c.edge) {
      issues.push({
        rule: "vertex-edge-exclusive",
        message: 'a cell cannot be both vertex="1" and edge="1"',
        cellId: c.id,
        position: pos,
      });
    }

    // Rule: every edge has a child <mxGeometry as="geometry"/>.
    if (c.edge && !c.geometry.hasGeometry) {
      issues.push({
        rule: "edge-geometry",
        message:
          'edge is missing its child <mxGeometry relative="1" as="geometry"/> — it will not render',
        cellId: c.id,
        position: pos,
      });
    }

    // Rule: edge endpoints resolve to existing ids.
    if (c.edge) {
      for (const end of ["source", "target"] as const) {
        const ref = c[end];
        if (ref != null && ref !== "" && !cellExists(cells, ref)) {
          issues.push({
            rule: "edge-endpoint",
            message: `edge ${end} "${ref}" does not resolve to any cell`,
            cellId: c.id,
            position: pos,
          });
        }
      }
    }

    // Rule: parent must exist.
    if (c.parent != null && c.parent !== "" && !cellExists(cells, c.parent)) {
      issues.push({
        rule: "parent-exists",
        message: `parent "${c.parent}" does not resolve to any cell`,
        cellId: c.id,
        position: pos,
      });
    }

    // Rule: style parses as key=value; pairs.
    if (c.style !== "") {
      const parsed = parseStyle(c.style);
      if (parsed.badSegment !== undefined) {
        issues.push({
          rule: "style-format",
          message: `malformed style segment "${parsed.badSegment}" (expected key=value)`,
          cellId: c.id,
          position: pos,
        });
      }
    }
  });

  if (issues.length > 0) throw new DrawioLintError(issues);
  return { cells, warnings };
}

function cellExists(cells: DrawioCell[], id: string): boolean {
  return cells.some((c) => c.id === id);
}

/**
 * Raw-string scan of every `value="…"`/`value='…'` on an mxCell tag. Catches an
 * unescaped `&`/`<`/`>` and a literal newline character inside a value, keyed to
 * the cell's id. Runs before DOM parsing so a value bug is reported with its
 * cellId even when the document is otherwise malformed.
 */
function scanRawValues(xml: string, issues: DrawioLintIssue[]): void {
  const tagRe = /<mxCell\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const attrs = m[1];
    const idM = /\bid\s*=\s*"([^"]*)"/.exec(attrs);
    const cellId = idM ? idM[1] : undefined;
    const valM = /\bvalue\s*=\s*"([^"]*)"/.exec(attrs) || /\bvalue\s*=\s*'([^']*)'/.exec(attrs);
    if (!valM) continue;
    const raw = valM[1];
    // Literal newline (0x0A / 0x0D) inside the attribute value.
    if (/[\n\r]/.test(raw)) {
      issues.push({
        rule: "value-newline",
        message:
          "value contains a literal newline; use &#xa; (or <br> with html=1) instead",
        cellId,
      });
    }
    // Unescaped '<' or '>' inside a value.
    if (raw.includes("<") || raw.includes(">")) {
      issues.push({
        rule: "value-escaping",
        message: "value contains an unescaped '<' or '>'; use &lt; / &gt;",
        cellId,
      });
    }
    // '&' that does not begin a valid entity.
    const badAmp = /&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/.test(raw);
    if (badAmp) {
      issues.push({
        rule: "value-escaping",
        message: "value contains an unescaped '&'; use &amp;",
        cellId,
      });
    }
  }
}

// --- input normalization + prepare -----------------------------------------

/**
 * Normalize an accepted tool input into a full mxGraphModel string:
 *   - a bare `<mxGraphModel>` is used as-is;
 *   - an `<mxfile>` is decoded to its first page's model;
 *   - a list of `<mxCell>` is wrapped with the mxGraphModel/root envelope and
 *     the sentinel cells (id=0, id=1 parent=0) are added when absent.
 */
export function normalizeInput(inputXml: string): string {
  let xml = inputXml.trim();
  // Strip an optional XML prolog.
  if (xml.startsWith("<?xml")) {
    const end = xml.indexOf("?>");
    if (end !== -1) xml = xml.slice(end + 2).trim();
  }
  if (xml.startsWith("<mxfile")) {
    return decodeDrawioFileToModel(xml);
  }
  if (xml.startsWith("<mxGraphModel")) {
    return xml;
  }
  if (xml.includes("<mxCell")) {
    return wrapCellFragment(xml);
  }
  throw new DrawioLintError([
    {
      rule: "unrecognized-input",
      message:
        "input must be a <mxGraphModel>, an <mxfile>, or a list of <mxCell> elements",
    },
  ]);
}

function wrapCellFragment(fragment: string): string {
  // Validate the fragment is well-formed (wrapped so a bare list parses) and
  // discover which sentinels are already present.
  const { doc, error } = parseXml(`<root>${fragment}</root>`);
  if (error) {
    throw new DrawioLintError([
      {
        rule: "well-formed-xml",
        message: error,
        position: firstLineCol(error),
      },
    ]);
  }
  const existing = new Set<string>();
  const els = doc.getElementsByTagName("mxCell");
  for (let i = 0; i < els.length; i++) {
    existing.add(els[i].getAttribute("id") ?? "");
  }
  let prefix = "";
  if (!existing.has("0")) prefix += '<mxCell id="0"/>';
  if (!existing.has("1")) prefix += '<mxCell id="1" parent="0"/>';
  return `<mxGraphModel ${DEFAULT_MODEL_ATTRS}><root>${prefix}${fragment}</root></mxGraphModel>`;
}

export interface PreparedModel {
  /** Canonical (normalized) mxGraphModel XML that gets written. */
  modelXml: string;
  cells: DrawioCell[];
  bbox: DrawioBBox;
  /** Number of user cells (excludes the id=0/id=1 sentinels). */
  cellCount: number;
  warnings: string[];
  hash: string;
}

/**
 * Full pre-write pipeline for create/update: normalize the input into a model,
 * lint it (throws DrawioLintError on any violation), then compute the canonical
 * form, bounding box, cell count and hash. Never touches the network.
 */
export function prepareModel(inputXml: string): PreparedModel {
  const rawModel = normalizeInput(inputXml);
  // Auto-strip XML comments before linting. The model routinely inserts
  // `<!-- ... -->` into the diagram XML despite the prohibition in the tool
  // description; a hard [no-comments] lint failure would force it to regenerate
  // the whole diagram (a wasted tool call). Comments carry no diagram semantics,
  // so stripping them is always safe. The linter's no-comments rule stays as a
  // defense-in-depth backstop for any path that reaches it without this strip.
  //
  // The strip is GATED on two conditions so the regex only ever targets real
  // comment nodes:
  //   1. Well-formedness. Well-formed XML forbids a bare `<` inside an attribute
  //      value (it must be entity-escaped, e.g. `&lt;!--`), so a literal `<!--`
  //      cannot hide in a value. On MALFORMED input (e.g. a raw unescaped `<!--`
  //      inside a value on the <mxGraphModel> create/update path, which
  //      normalizeInput passes through unparsed) we must NOT strip: truncating
  //      that value would silently corrupt the author's label. We leave it intact
  //      and let lintModel's value-escaping / well-formed-xml rules reject it so
  //      the author sees the real error.
  //   2. No CDATA. A CDATA section is well-formed yet its text may contain a
  //      literal `<!-- ... -->` that is NOT a comment node; stripping it would
  //      silently delete author content. Real drawio labels live in `value=`
  //      attributes (CDATA impossible), so excluding CDATA is free on legitimate
  //      models; a CDATA-bearing model with a genuine comment then falls to the
  //      retained no-comments lint backstop (an explicit error) rather than being
  //      silently corrupted.
  const { error: parseError } = parseXml(rawModel);
  const hasCdata = rawModel.includes("<![CDATA[");
  const commentMatches =
    parseError === null && !hasCdata
      ? (rawModel.match(/<!--[\s\S]*?-->/g) ?? [])
      : [];
  const commentCount = commentMatches.length;
  const strippedModel =
    commentCount > 0 ? rawModel.replace(/<!--[\s\S]*?-->/g, "") : rawModel;
  const stripWarnings =
    commentCount > 0 ? [`stripped ${commentCount} XML comment(s)`] : [];
  const { cells, warnings } = lintModel(strippedModel);
  const modelXml = normalizeXml(strippedModel);
  const bbox = computeBBox(cells);
  const cellCount = cells.filter((c) => c.id !== "0" && c.id !== "1").length;
  // Geometry quality warnings (non-blocking) are appended to any structural
  // warnings from the linter. The model surfaces these and can self-correct.
  const quality = computeQualityWarnings(cells, modelXml);
  return {
    modelXml,
    cells,
    bbox,
    cellCount,
    warnings: [...stripWarnings, ...warnings, ...quality],
    hash: mxHash(modelXml),
  };
}

/** Cell count of a decoded model (user cells only) — used by drawioGet meta. */
export function countUserCells(modelXml: string): number {
  return parseCells(modelXml).filter((c) => c.id !== "0" && c.id !== "1").length;
}
