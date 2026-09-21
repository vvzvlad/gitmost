// Semantic color/line presets for the graph tools (issue #425, stage 3). The
// PALETTE is DATA (packages/mcp/data/drawio-presets.json), not code: a node
// `kind` maps to a { fillColor, strokeColor, fontColor } slot and an edge `kind`
// maps to line-style props, per named preset (`default` / `dark` /
// `colorblind-safe`). This module only loads that data and turns a slot into a
// draw.io style fragment. The INVARIANT of the graph tools is that the model
// never sees a style string — it names a `kind`, the server picks the slot.
//
// Loading mirrors drawio-shapes.ts: the JSON is read once via `import.meta.url`
// relative to the built module. That is why this module (and drawio-graph.ts
// which imports it) is reached ONLY through client.ts's ESM build and never
// value-imported into the zod-agnostic tool-specs.ts (which the in-app server
// type-checks under module:commonjs, where `import.meta` is a TS1343 error).

import { readFileSync } from "node:fs";

/** A node color slot: the three draw.io color values for a `kind`. */
export interface NodeSlot {
  fillColor: string;
  strokeColor: string;
  fontColor: string;
}

/** An edge line style: the extra style props appended for an edge `kind`. */
export interface EdgeStyle {
  props: string;
}

export interface PresetData {
  canvasDark: boolean;
  okabeIto?: string[];
  nodes: Record<string, NodeSlot>;
  edges: Record<string, EdgeStyle>;
  edgeDefault: { strokeColor: string; fontColor: string };
  group: { strokeColor: string; fontColor: string };
}

interface PresetsFile {
  presets: Record<string, PresetData>;
}

/** The three shipped preset names. */
export const PRESET_NAMES = ["default", "dark", "colorblind-safe"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** Every node `kind` the base palette defines (also the generic-shape kinds). */
export const NODE_KINDS = [
  "service",
  "db",
  "queue",
  "gateway",
  "error",
  "external",
  "security",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Edge `kind`s the palette styles; anything else falls back to `sync`. */
export const EDGE_KINDS = ["sync", "async", "error"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

let _presets: Record<string, PresetData> | null = null;

function presetsPath(): URL {
  // build/lib/drawio-presets.js -> ../../data/drawio-presets.json
  return new URL("../../data/drawio-presets.json", import.meta.url);
}

/** Load + parse the bundled preset table once, then cache it. */
export function loadPresets(): Record<string, PresetData> {
  if (_presets) return _presets;
  const json = readFileSync(presetsPath(), "utf-8");
  const parsed = JSON.parse(json) as PresetsFile;
  _presets = parsed.presets;
  return _presets;
}

/** Resolve a preset by name, defaulting to `default` for an unknown name. */
export function getPreset(name?: string): PresetData {
  const presets = loadPresets();
  if (name && presets[name]) return presets[name];
  return presets["default"];
}

/** The slot for a node `kind` in a preset, falling back to `service`. */
export function nodeSlot(preset: PresetData, kind?: string): NodeSlot {
  if (kind && preset.nodes[kind]) return preset.nodes[kind];
  return preset.nodes["service"];
}

/**
 * Build the draw.io style string for a GENERIC (no-icon) node of a given kind.
 * A rounded rectangle carrying the slot's fill/stroke/font. `whiteSpace=wrap`
 * and `html=1` let a long label wrap inside the shape (the assembler also sizes
 * the shape to the label, so the linter's label-overflow warning never fires).
 */
export function genericNodeStyle(preset: PresetData, kind?: string): string {
  const s = nodeSlot(preset, kind);
  return (
    `rounded=1;whiteSpace=wrap;html=1;` +
    `fillColor=${s.fillColor};strokeColor=${s.strokeColor};fontColor=${s.fontColor};`
  );
}

/**
 * Overlay the preset's node slot colors onto a resolved ICON style-string
 * (from the shape catalog). An AWS/Azure icon carries its OWN mandatory
 * fill/stroke (the category color / white outline) that MUST NOT be recolored,
 * so for an icon we only ensure a readable fontColor when the preset is dark;
 * otherwise the icon style is returned verbatim. Keeping the icon's own colors
 * is deliberate: recoloring an AWS service icon breaks its category semantics.
 */
export function iconNodeStyle(preset: PresetData, iconStyle: string): string {
  if (!preset.canvasDark) return iconStyle;
  // On a dark canvas an icon's fontColor is usually a dark ink that vanishes;
  // append a light fontColor (icons put their label BELOW the glyph, so this
  // only affects the caption, never the glyph fill).
  if (/fontColor=/.test(iconStyle)) {
    return iconStyle.replace(/fontColor=[^;]*/, "fontColor=#e0e0e0");
  }
  return iconStyle + (iconStyle.endsWith(";") ? "" : ";") + "fontColor=#e0e0e0;";
}

/**
 * Build the draw.io style for an edge of a given `kind`. Base is an orthogonal
 * connector (edgeStyle=orthogonalEdgeStyle) with rounded corners and an open
 * arrowhead, plus the preset's default stroke/font, then the kind's extra props
 * (dashed / colored) overlaid. An unknown kind falls back to `sync` (solid).
 */
export function edgeStyle(preset: PresetData, kind?: string): string {
  const k = kind && preset.edges[kind] ? kind : "sync";
  const base =
    `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;` +
    `strokeColor=${preset.edgeDefault.strokeColor};fontColor=${preset.edgeDefault.fontColor};`;
  return base + preset.edges[k].props;
}

/**
 * Group (container) style: ALWAYS transparent (`fillColor=none;container=1;`)
 * per the spec, carrying the preset's group stroke/font. `dropTarget=1` marks it
 * a drop target in the editor; `verticalAlign=top;align=left;spacingLeft=8;` puts
 * the group label in the top-left like draw.io's own boundary containers.
 */
export function groupStyle(preset: PresetData): string {
  return (
    `rounded=0;whiteSpace=wrap;html=1;` +
    `fillColor=none;container=1;dropTarget=1;collapsible=0;` +
    `strokeColor=${preset.group.strokeColor};fontColor=${preset.group.fontColor};` +
    `verticalAlign=top;align=left;spacingLeft=8;spacingTop=4;`
  );
}
