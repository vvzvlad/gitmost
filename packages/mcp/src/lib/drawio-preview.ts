// Pure-TS schematic SVG preview for draw.io diagrams (issue #423, stage 1).
//
// HARD CONSTRAINT: no backend rendering. This is a dependency-free string
// builder — given the parsed mxGraph cells it draws a rough schematic (rects,
// ellipses, diamonds, edges + labels) that stands in as the diagram's visible
// image UNTIL a human first opens it in the draw.io editor and saves, at which
// point the client replaces this with the pixel-perfect export SVG. It is
// deliberately approximate: it exists so a freshly-agent-created diagram is not
// an empty box in the page.

import type { DrawioCell, DrawioBBox } from "./drawio-xml.js";
import { absolutePos } from "./drawio-xml.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Strip HTML markup from a cell value (draw.io labels are HTML when html=1),
 * decode the handful of entities we care about, and collapse whitespace so the
 * label fits on the schematic. `<br>` becomes a space (this is a one-line
 * preview label, not a faithful multi-line render).
 */
function labelText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#xa;|&#10;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function centeredLabel(cx: number, cy: number, value: string, color = "#000000"): string {
  const text = labelText(value);
  if (!text) return "";
  return (
    `<text x="${round(cx)}" y="${round(cy)}" ` +
    `font-family="Helvetica, Arial, sans-serif" font-size="12" ` +
    `text-anchor="middle" dominant-baseline="middle" fill="${esc(color)}">` +
    `${esc(text)}</text>`
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

interface ShapeKind {
  kind: "ellipse" | "rhombus" | "triangle" | "rect";
}

/**
 * Decide which schematic primitive to draw for a vertex. A shape can be named
 * either as the style's base token (e.g. "ellipse;…") or as a key (e.g.
 * "shape=rhombus" / "ellipse=1"), so both the base style and the map are
 * checked.
 */
function shapeKind(
  styleMap: Record<string, string>,
  baseStyle?: string,
): ShapeKind {
  const shape = styleMap.shape ?? baseStyle;
  const has = (name: string) => shape === name || styleMap[name] != null;
  if (has("ellipse")) return { kind: "ellipse" };
  if (has("rhombus")) return { kind: "rhombus" };
  if (has("triangle")) return { kind: "triangle" };
  // Everything else — including unknown stencils (shape=mxgraph.*), swimlanes,
  // and plain boxes — is drawn as a (rounded) rectangle.
  return { kind: "rect" };
}

function fill(styleMap: Record<string, string>): string {
  const c = styleMap.fillColor;
  if (!c || c.toLowerCase() === "none") return "#ffffff";
  return c;
}

function stroke(styleMap: Record<string, string>): string {
  const c = styleMap.strokeColor;
  if (!c || c.toLowerCase() === "none") return "#000000";
  return c;
}

/**
 * Render the schematic shapes as the INNER content of the `.drawio.svg` (the
 * outer <svg> wrapper is added by drawio-xml.buildDrawioSvg). Coordinates are
 * absolute (container children are resolved via the parent chain).
 */
export function renderDiagramShapes(cells: DrawioCell[], _bbox: DrawioBBox): string {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const parts: string[] = [];

  // Edges first so vertices sit on top of their connectors.
  for (const c of cells) {
    if (!c.edge) continue;
    parts.push(renderEdge(c, byId));
  }

  for (const c of cells) {
    if (!c.vertex || !c.geometry.hasGeometry) continue;
    const g = c.geometry;
    if (g.width == null || g.height == null) continue;
    const { x, y } = absolutePos(c, byId);
    parts.push(renderVertex(c, x, y, g.width, g.height));
  }

  return `<g>${parts.filter(Boolean).join("")}</g>`;
}

function renderVertex(
  c: DrawioCell,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const f = esc(fill(c.styleMap));
  const s = esc(stroke(c.styleMap));
  const { kind } = shapeKind(c.styleMap, c.baseStyle);
  const cx = x + w / 2;
  const cy = y + h / 2;
  let shape = "";
  switch (kind) {
    case "ellipse":
      shape =
        `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(w / 2)}" ` +
        `ry="${round(h / 2)}" fill="${f}" stroke="${s}"/>`;
      break;
    case "rhombus": {
      const pts = [
        `${round(cx)},${round(y)}`,
        `${round(x + w)},${round(cy)}`,
        `${round(cx)},${round(y + h)}`,
        `${round(x)},${round(cy)}`,
      ].join(" ");
      shape = `<polygon points="${pts}" fill="${f}" stroke="${s}"/>`;
      break;
    }
    case "triangle": {
      const pts = [
        `${round(x)},${round(y)}`,
        `${round(x + w)},${round(cy)}`,
        `${round(x)},${round(y + h)}`,
      ].join(" ");
      shape = `<polygon points="${pts}" fill="${f}" stroke="${s}"/>`;
      break;
    }
    default: {
      const rounded = c.styleMap.rounded === "1";
      const rx = rounded ? Math.min(12, w / 2, h / 2) : 0;
      shape =
        `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" ` +
        `height="${round(h)}" rx="${round(rx)}" ry="${round(rx)}" ` +
        `fill="${f}" stroke="${s}"/>`;
    }
  }
  return shape + centeredLabel(cx, cy, c.value, c.styleMap.fontColor || "#000000");
}

function renderEdge(c: DrawioCell, byId: Map<string, DrawioCell>): string {
  const src = c.source != null ? byId.get(c.source) : undefined;
  const tgt = c.target != null ? byId.get(c.target) : undefined;
  const p1 = anchorPoint(src, byId);
  const p2 = anchorPoint(tgt, byId);
  if (!p1 || !p2) return ""; // a floating endpoint with no fixed point: skip
  const line =
    `<line x1="${round(p1.x)}" y1="${round(p1.y)}" ` +
    `x2="${round(p2.x)}" y2="${round(p2.y)}" ` +
    `stroke="#000000" stroke-width="1"/>`;
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  return line + centeredLabel(mid.x, mid.y, c.value);
}

/** Center point of a vertex used as an edge anchor (approximate). */
function anchorPoint(
  cell: DrawioCell | undefined,
  byId: Map<string, DrawioCell>,
): { x: number; y: number } | null {
  if (!cell || !cell.geometry.hasGeometry) return null;
  const g = cell.geometry;
  if (g.width == null || g.height == null) return null;
  const { x, y } = absolutePos(cell, byId);
  return { x: x + g.width / 2, y: y + g.height / 2 };
}
