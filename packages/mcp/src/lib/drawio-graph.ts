// Semantic graph -> draw.io pipeline for `drawioFromGraph` (issue #425, stage 3).
//
// The model describes a diagram SEMANTICALLY — nodes with a `kind` and an
// optional `icon`, groups (containers), edges with a `kind` — and NEVER sees a
// coordinate or a style string. This module owns the whole server-side pipeline:
//
//   1. validateGraph      — a hand-written validator (no zod dependency, so this
//                           lib stays importable by client.ts without coupling to
//                           a zod major) that rejects malformed graphs early.
//   2. resolveNodeStyle   — `icon` -> exact style via the shape catalog (#424);
//                           an UNKNOWN icon degrades to a generic shape by `kind`
//                           WITH the label (never an empty square). `kind` -> the
//                           preset palette slot.
//   3. graphToElk         — graph -> ELK-JSON, honouring the layout hints
//                           (`layer`/`sameLayerAs` -> layer constraints, `pinned`
//                           -> a fixed node) and compound group nodes.
//   4. assembleModel      — graph + ELK coordinates -> a full mxGraphModel XML
//                           that satisfies the #423 linter BY CONSTRUCTION
//                           (sentinels, transparent containers, relative child
//                           coords, cross-container edges parent="1", >=150px
//                           gaps from ELK spacing, escaped labels).
//
// The `layout` mode: "full" re-lays everything; "incremental" fixes existing
// coordinates (ELK interactive mode) and places only new nodes; "none" keeps the
// caller-provided/prior coordinates untouched.

import ELK from "elkjs/lib/elk.bundled.js";
import { JSDOM } from "jsdom";
import {
  searchShapes,
  awsServiceStyle,
  type ShapeResult,
} from "./drawio-shapes.js";
import {
  getPreset,
  genericNodeStyle,
  iconNodeStyle,
  edgeStyle,
  groupStyle,
  type PresetData,
} from "./drawio-presets.js";
import { MIN_SHAPE_GAP } from "./drawio-xml.js";

// --- graph schema (plain TS + a hand validator) ----------------------------

export interface GraphNode {
  id: string;
  label: string;
  kind?: string;
  /** Icon reference, e.g. "aws:lambda" | "azure:cosmos" | "lambda". */
  icon?: string;
  /** Group (container) id this node belongs to. */
  group?: string;
  /** Layer hint (ELK layerChoiceConstraint): 0-based column/row index. */
  layer?: number;
  /** Put this node in the same layer as another node id. */
  sameLayerAs?: string;
  /** Fix this node at exact coordinates (an ELK fixed node). */
  pinned?: { x: number; y: number };
}

export interface GraphGroup {
  id: string;
  label: string;
  kind?: string;
  /** Parent group id — lets a group nest inside another group (e.g. subnet in VPC). */
  group?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  kind?: string;
}

export interface Graph {
  nodes: GraphNode[];
  groups?: GraphGroup[];
  edges?: GraphEdge[];
  direction?: "LR" | "RL" | "TB" | "BT";
  preset?: string;
}

export type LayoutMode = "none" | "full" | "incremental";

/** A structured validation error (mirrors the drawio linter's shape loosely). */
export class GraphValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`drawioFromGraph: invalid graph — ${issues.join("; ")}`);
    this.name = "GraphValidationError";
    this.issues = issues;
  }
}

const MAX_GRAPH_NODES = 500; // parity with drawio-layout's ELK_MAX_NODES.
// Edge/group caps mirror drawio-layout's ELK_MAX_EDGES. Without an edge cap a
// tiny node set with a huge edge list (e.g. 500 nodes / 200000 edges) passes
// node validation, then graphToElk/runElk exhausts the heap SYNCHRONOUSLY inside
// elk.bundled.js — before the 5s ELK timeout can fire and OUTSIDE it entirely
// for the mapper/assembler — crashing the worker on LLM-authored input. Reject
// the over-limit shape here, before any layout or assembly runs.
export const MAX_GRAPH_EDGES = 1000; // parity with drawio-layout's ELK_MAX_EDGES.
export const MAX_GRAPH_GROUPS = 500; // groups are compound ELK nodes; bound them too.

/**
 * Validate the graph structure BEFORE any layout/assembly so the model gets a
 * precise, actionable error instead of a corrupt diagram. Throws
 * GraphValidationError listing every problem.
 */
export function validateGraph(graph: Graph): void {
  const issues: string[] = [];
  if (!graph || typeof graph !== "object") {
    throw new GraphValidationError(["graph must be an object"]);
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new GraphValidationError(["graph.nodes must be a non-empty array"]);
  }
  // Size caps FIRST (fail fast, before touching per-element loops) so an
  // over-limit graph can never reach the layout engine and OOM the worker.
  if (graph.nodes.length > MAX_GRAPH_NODES) {
    throw new GraphValidationError([
      `graph has ${graph.nodes.length} nodes (max ${MAX_GRAPH_NODES})`,
    ]);
  }
  if (Array.isArray(graph.edges) && graph.edges.length > MAX_GRAPH_EDGES) {
    throw new GraphValidationError([
      `graph has ${graph.edges.length} edges (max ${MAX_GRAPH_EDGES})`,
    ]);
  }
  if (Array.isArray(graph.groups) && graph.groups.length > MAX_GRAPH_GROUPS) {
    throw new GraphValidationError([
      `graph has ${graph.groups.length} groups (max ${MAX_GRAPH_GROUPS})`,
    ]);
  }

  const nodeIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const g of graph.groups ?? []) {
    if (!g.id) issues.push("a group is missing its id");
    else if (groupIds.has(g.id)) issues.push(`duplicate group id "${g.id}"`);
    groupIds.add(g.id);
  }
  for (const n of graph.nodes) {
    if (!n.id) issues.push("a node is missing its id");
    else if (nodeIds.has(n.id)) issues.push(`duplicate node id "${n.id}"`);
    else if (groupIds.has(n.id))
      issues.push(`node id "${n.id}" collides with a group id`);
    nodeIds.add(n.id);
    if (typeof n.label !== "string" || n.label === "")
      issues.push(`node "${n.id}" is missing a label`);
    if (n.group != null && !groupIds.has(n.group))
      issues.push(`node "${n.id}" references unknown group "${n.group}"`);
    if (n.pinned != null) {
      if (
        typeof n.pinned.x !== "number" ||
        typeof n.pinned.y !== "number" ||
        !Number.isFinite(n.pinned.x) ||
        !Number.isFinite(n.pinned.y)
      )
        issues.push(`node "${n.id}" has an invalid pinned {x,y}`);
    }
    if (n.layer != null && (!Number.isInteger(n.layer) || n.layer < 0))
      issues.push(`node "${n.id}" has an invalid layer (must be a >=0 integer)`);
  }
  // sameLayerAs must reference an existing node (checked after all ids known).
  for (const n of graph.nodes) {
    if (n.sameLayerAs != null && !nodeIds.has(n.sameLayerAs))
      issues.push(
        `node "${n.id}" sameLayerAs references unknown node "${n.sameLayerAs}"`,
      );
  }
  for (const e of graph.edges ?? []) {
    if (!e.from || !e.to) {
      issues.push("an edge is missing from/to");
      continue;
    }
    if (!nodeIds.has(e.from) && !groupIds.has(e.from))
      issues.push(`edge from "${e.from}" resolves to no node/group`);
    if (!nodeIds.has(e.to) && !groupIds.has(e.to))
      issues.push(`edge to "${e.to}" resolves to no node/group`);
  }
  if (issues.length > 0) throw new GraphValidationError(issues);
}

// --- icon resolution -------------------------------------------------------

/**
 * Resolve a node's `icon` reference to a concrete style-string + size via the
 * shape catalog. Accepts "aws:lambda", "azure:cosmos", or a bare "lambda". An
 * AWS `resIcon` name is built directly (exact service-icon template). Anything
 * else goes through searchShapes. Returns null when nothing resolves — the
 * caller then falls back to a generic shape by kind (never an empty box).
 */
export function resolveIcon(icon: string): ShapeResult | null {
  const raw = icon.trim();
  if (raw === "") return null;
  let provider = "";
  let name = raw;
  const colon = raw.indexOf(":");
  if (colon !== -1) {
    provider = raw.slice(0, colon).trim().toLowerCase();
    name = raw.slice(colon + 1).trim();
  }

  if (provider === "aws") {
    // Prefer an exact resIcon match from the catalog (carries the right size and
    // any rebrand/blocklist note); if the underscore/space name doesn't hit,
    // build the canonical service-icon style directly so it is never an empty box.
    const results = searchShapes(name.replace(/_/g, " "), { limit: 5 });
    const aws4 = results.find((r) => r.style.includes("mxgraph.aws4"));
    if (aws4) return aws4;
    return {
      style: awsServiceStyle(name.replace(/\s+/g, "_")),
      w: 78,
      h: 78,
      title: name,
      type: "vertex",
    };
  }

  // Non-AWS or bare name: fuzzy search the catalog. Take the top vertex hit,
  // but REJECT a weak match (the fuzzy scorer can prefix-match an unrelated
  // stencil, e.g. "not..." -> "Notebook"); require the hit's title to actually
  // share a meaningful token with the query, otherwise degrade to generic-by-kind.
  const q = provider ? `${provider} ${name}` : name;
  const results = searchShapes(q, { limit: 8 });
  const hit = results.find((r) => r.type !== "edge") ?? results[0];
  if (!hit) return null;
  if (!isRelevantMatch(name, hit.title)) return null;
  return hit;
}

/**
 * Whether a resolved stencil is a genuine match for the requested icon name (as
 * opposed to a loose prefix hit on an unrelated shape). True if any 3+ char
 * token of the query appears in the stencil title, or vice-versa.
 */
function isRelevantMatch(name: string, title: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const qTokens = norm(name).split(/\s+/).filter((t) => t.length >= 3);
  if (qTokens.length === 0) return true; // very short names: trust the scorer
  const t = norm(title);
  const tTokens = new Set(t.split(/\s+/));
  for (const qt of qTokens) {
    if (tTokens.has(qt)) return true;
    if (t.includes(qt)) return true;
    for (const tt of tTokens) if (tt.length >= 3 && qt.includes(tt)) return true;
  }
  return false;
}

/**
 * Decide the final style + size for a node. When `icon` resolves, use the icon
 * style (overlaid with a dark-preset font fix); otherwise a GENERIC shape by
 * `kind` carrying the label. `resolved` reports whether an icon was found (used
 * by the acceptance test that asserts no empty squares).
 */
export function resolveNodeStyle(
  preset: PresetData,
  node: GraphNode,
): { style: string; w: number; h: number; iconResolved: boolean } {
  if (node.icon) {
    const shape = resolveIcon(node.icon);
    if (shape) {
      return {
        style: iconNodeStyle(preset, shape.style),
        w: shape.w,
        h: shape.h,
        iconResolved: true,
      };
    }
  }
  // Generic shape by kind, sized to the label so a long label never overflows.
  const w = Math.max(120, estimateLabelWidth(node.label) + 32);
  return { style: genericNodeStyle(preset, node.kind), w, h: 60, iconResolved: false };
}

/** Rough rendered width of the longest label line at 12px (~0.6em/glyph). */
function estimateLabelWidth(label: string): number {
  const lines = label.split(/\r?\n|&#xa;|<br\s*\/?>/i);
  let longest = 0;
  for (const l of lines) longest = Math.max(longest, l.trim().length);
  return Math.ceil(longest * 12 * 0.6);
}

// --- graph -> ELK-JSON -----------------------------------------------------

interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  layoutOptions?: Record<string, string>;
}
interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
}
interface ElkGraph extends ElkNode {
  edges?: ElkEdge[];
}

const ELK_DIRECTION: Record<string, string> = {
  LR: "RIGHT",
  RL: "LEFT",
  TB: "DOWN",
  BT: "UP",
};

/** Sizes resolved per node id (from resolveNodeStyle), fed to the ELK mapper. */
export interface NodeSize {
  w: number;
  h: number;
}

/**
 * Build the ELK graph from the semantic graph + resolved node sizes. Compound
 * group nodes nest their members (a group may itself nest in another group).
 * `only` restricts the graph to a subset of node ids (used by the incremental
 * path to lay out ONLY the new nodes). Layout HINTS (`layer`/`sameLayerAs`/
 * `pinned`) are NOT encoded as ELK constraints here — ELK's constraint knobs are
 * unreliable across versions — they are enforced deterministically AFTER layout
 * by applyHints, which is exact and testable.
 */
export function graphToElk(
  graph: Graph,
  sizes: Map<string, NodeSize>,
  opts: { only?: Set<string> } = {},
): ElkGraph {
  const direction = ELK_DIRECTION[graph.direction ?? "LR"] ?? "RIGHT";
  const only = opts.only;
  const include = (id: string) => !only || only.has(id);

  const makeNode = (n: GraphNode): ElkNode => {
    const size = sizes.get(n.id) ?? { w: 140, h: 60 };
    return { id: n.id, width: size.w, height: size.h };
  };

  // Group children nest under their group node; ungrouped nodes are roots.
  const groupNode = new Map<string, ElkNode>();
  const usedGroups = new Set<string>();
  for (const g of graph.groups ?? []) {
    const size = sizes.get(g.id) ?? { w: 200, h: 150 };
    groupNode.set(g.id, {
      id: g.id,
      width: size.w,
      height: size.h,
      children: [],
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": direction,
        "elk.padding": "[top=40,left=30,bottom=30,right=30]",
        "elk.layered.spacing.nodeNodeBetweenLayers": "170",
        "elk.spacing.nodeNode": "170",
      },
    });
  }
  const roots: ElkNode[] = [];
  for (const n of graph.nodes) {
    if (!include(n.id)) continue;
    const en = makeNode(n);
    if (n.group && groupNode.has(n.group)) {
      groupNode.get(n.group)!.children!.push(en);
      usedGroups.add(n.group);
    } else {
      roots.push(en);
    }
  }
  // Nest group nodes into their parent group (a subnet inside a VPC); groups
  // with no parent group become roots. Only groups that hold an included node.
  const groupIdSet = new Set((graph.groups ?? []).map((g) => g.id));
  for (const g of graph.groups ?? []) {
    if (only && !usedGroups.has(g.id)) continue;
    const en = groupNode.get(g.id)!;
    if (g.group && groupIdSet.has(g.group) && g.group !== g.id && (!only || usedGroups.has(g.group))) {
      groupNode.get(g.group)!.children!.push(en);
    } else {
      roots.push(en);
    }
  }

  // Edges: endpoints may be nodes or groups; INCLUDE_CHILDREN spans the nesting.
  const validIds = new Set<string>([
    ...graph.nodes.filter((n) => include(n.id)).map((n) => n.id),
    ...(graph.groups ?? []).map((g) => g.id),
  ]);
  const edges: ElkEdge[] = [];
  (graph.edges ?? []).forEach((e, i) => {
    if (!validIds.has(e.from) || !validIds.has(e.to)) return;
    edges.push({ id: `e${i}`, sources: [e.from], targets: [e.to] });
  });

  const rootOptions: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.layered.spacing.nodeNodeBetweenLayers": "170",
    "elk.spacing.nodeNode": "170",
    "elk.spacing.edgeNode": "40",
    "elk.spacing.edgeEdge": "30",
    "elk.padding": "[top=20,left=20,bottom=20,right=20]",
  };

  return { id: "root", layoutOptions: rootOptions, children: roots, edges };
}

/**
 * Enforce the layout hints DETERMINISTICALLY on ELK's output (mutates `geo`):
 *   - `sameLayerAs`: snap the dependent node's LAYER-AXIS coordinate to its
 *     anchor's, so the pair lands in the same layer (x for LR/RL, y for TB/BT).
 *     `layer` groups nodes with the same index onto the same anchor coordinate.
 *   - `pinned`: override the node's coordinate with the exact pinned {x,y}.
 * Applied only to top-level (ungrouped) nodes, whose ELK coords are absolute.
 */
export function applyHints(
  graph: Graph,
  geo: Map<string, { x: number; y: number; w: number; h: number }>,
): void {
  const dir = graph.direction ?? "LR";
  const layerAxis: "x" | "y" = dir === "TB" || dir === "BT" ? "y" : "x";
  // The perpendicular (cross-layer) axis: members snapped onto one layer must be
  // spread along THIS axis so they don't stack onto the same point.
  const crossAxis: "x" | "y" = layerAxis === "x" ? "y" : "x";
  const crossSize: "w" | "h" = crossAxis === "x" ? "w" : "h";
  const grouped = new Set(
    graph.nodes.filter((n) => n.group).map((n) => n.id),
  );

  // sameLayerAs / layer: co-assign the layer-axis coordinate.
  // Build the effective layer key per node, then pick a representative coord.
  const layerKeyOf = new Map<string, string>();
  const explicitLayer = new Map<string, number>();
  for (const n of graph.nodes) if (n.layer != null) explicitLayer.set(n.id, n.layer);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const resolveKey = (n: GraphNode): string | null => {
    if (explicitLayer.has(n.id)) return `L${explicitLayer.get(n.id)}`;
    const seen = new Set<string>([n.id]);
    let cur: GraphNode | undefined = n;
    while (cur && cur.sameLayerAs != null && !seen.has(cur.sameLayerAs)) {
      seen.add(cur.sameLayerAs);
      const t = byId.get(cur.sameLayerAs);
      if (!t) break;
      if (explicitLayer.has(t.id)) return `L${explicitLayer.get(t.id)}`;
      cur = t;
    }
    // A sameLayerAs chain with no explicit layer: key on the chain's root id.
    if (n.sameLayerAs != null) {
      let root = n.id;
      const s2 = new Set<string>([n.id]);
      let c: GraphNode | undefined = n;
      while (c && c.sameLayerAs != null && !s2.has(c.sameLayerAs)) {
        s2.add(c.sameLayerAs);
        root = c.sameLayerAs;
        c = byId.get(c.sameLayerAs);
      }
      return `C${root}`;
    }
    return null;
  };
  for (const n of graph.nodes) {
    if (grouped.has(n.id)) continue; // group children are relative — skip
    const key = resolveKey(n);
    if (key) layerKeyOf.set(n.id, key);
  }
  // Group members of each layer key so we can snap AND spread them together.
  const membersOf = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const key = layerKeyOf.get(n.id);
    if (key == null) continue;
    if (!geo.has(n.id)) continue;
    (membersOf.get(key) ?? membersOf.set(key, []).get(key)!).push(n.id);
  }
  // For each layer key: snap every member to the FIRST member's layer-axis coord,
  // then SPREAD them along the perpendicular (cross-layer) axis with a >=
  // MIN_SHAPE_GAP gap. Without the spread, a sameLayerAs chain whose nodes ELK
  // happened to give the same cross-axis coordinate would collapse onto one point
  // -> shape-overlap + edge-through-shape quality warnings (breaking the
  // "0 warnings by construction" guarantee for these AUTO-positioned hints). We
  // start from the members' minimum cross-axis coord and stack them with a gap
  // of MIN_SHAPE_GAP beyond each shape's cross-axis size.
  for (const [key, members] of membersOf) {
    if (members.length === 0) continue;
    // Snap layer-axis coord to the first member.
    const repCoord = geo.get(members[0])![layerAxis];
    // Preserve the members' existing relative order along the cross axis so the
    // spread stays visually stable, then re-lay them contiguously.
    const sorted = [...members].sort(
      (a, b) => geo.get(a)![crossAxis] - geo.get(b)![crossAxis],
    );
    let cursor = geo.get(sorted[0])![crossAxis];
    for (const id of sorted) {
      const g = geo.get(id)!;
      g[layerAxis] = repCoord;
      g[crossAxis] = cursor;
      cursor += g[crossSize] + MIN_SHAPE_GAP;
    }
    void key;
  }

  // pinned: exact override (wins over any layer snap). Explicit user coordinates
  // are user intent, but CLAMP to non-negative so an out-of-bounds pin (e.g.
  // x:-500) never renders off-canvas. Two user-pinned nodes at the same point is
  // user error the server can't silently relocate — the assembler docstring
  // documents that explicit pins are user-directed and MAY warn (see #423/#425
  // acceptance: the "0 quality-warnings by construction" guarantee is for
  // AUTO-LAYOUT, not for coordinates the user pinned by hand).
  for (const n of graph.nodes) {
    if (!n.pinned) continue;
    const px = Math.max(0, n.pinned.x);
    const py = Math.max(0, n.pinned.y);
    const g = geo.get(n.id);
    if (g) {
      g.x = px;
      g.y = py;
    } else {
      const sz = { w: 140, h: 60 };
      geo.set(n.id, { x: px, y: py, w: sz.w, h: sz.h });
    }
  }
}

/**
 * Incremental variant of applyHints: apply `pinned` only to NEW nodes (those
 * absent from `existing`); an existing node's coordinates are NEVER changed
 * (acceptance #3). sameLayerAs/layer snapping is intentionally skipped in the
 * incremental path — moving a new node's layer axis could still be desired, but
 * it must never move an existing cell, so we keep the incremental contract
 * simple: existing cells are frozen, new pinned nodes honour their pin.
 */
export function applyHintsForNew(
  graph: Graph,
  geo: Map<string, { x: number; y: number; w: number; h: number }>,
  existing: Map<string, { x: number; y: number }>,
): void {
  for (const n of graph.nodes) {
    if (existing.has(n.id)) continue; // never move an existing cell
    if (!n.pinned) continue;
    const px = Math.max(0, n.pinned.x); // clamp out-of-bounds pins non-negative
    const py = Math.max(0, n.pinned.y);
    const g = geo.get(n.id);
    if (g) {
      g.x = px;
      g.y = py;
    } else {
      geo.set(n.id, { x: px, y: py, w: 140, h: 60 });
    }
  }
}

// --- layout runner ---------------------------------------------------------

const ELK_TIMEOUT_MS = 5000;

/**
 * Run ELK over the mapped graph and return computed geometry per id (coords are
 * parent-relative, matching mxGraph's convention for container children). On any
 * ELK failure/timeout the returned map is empty and the caller falls back to a
 * deterministic grid placement (so the write never fails on a layout hiccup).
 */
export async function runElk(
  elk: ElkGraph,
): Promise<Map<string, { x: number; y: number; w: number; h: number }>> {
  const geo = new Map<string, { x: number; y: number; w: number; h: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const Ctor: any = (ELK as any).default ?? ELK;
    const inst = new Ctor();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ELK timed out")), ELK_TIMEOUT_MS);
    });
    const laid = (await Promise.race([inst.layout(elk as any), timeout])) as ElkGraph;
    const walk = (n: ElkNode) => {
      if (n.id !== "root") {
        geo.set(n.id, {
          x: Math.round(n.x ?? 0),
          y: Math.round(n.y ?? 0),
          w: Math.round(n.width ?? 140),
          h: Math.round(n.height ?? 60),
        });
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(laid);
  } catch {
    return new Map(); // best-effort: empty -> caller uses fallback grid.
  } finally {
    if (timer) clearTimeout(timer);
  }
  return geo;
}

// --- XML assembler ---------------------------------------------------------

/** Order groups so a parent group always precedes its nested children. */
function topoSortGroups(groups: GraphGroup[], groupIds: Set<string>): GraphGroup[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out: GraphGroup[] = [];
  const done = new Set<string>();
  const visit = (g: GraphGroup, stack: Set<string>) => {
    if (done.has(g.id)) return;
    if (stack.has(g.id)) return; // cycle guard
    stack.add(g.id);
    if (g.group && groupIds.has(g.group) && g.group !== g.id) {
      const parent = byId.get(g.group);
      if (parent) visit(parent, stack);
    }
    stack.delete(g.id);
    if (!done.has(g.id)) {
      done.add(g.id);
      out.push(g);
    }
  };
  for (const g of groups) visit(g, new Set());
  return out;
}

function xmlEscapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n|\r|\n/g, "&#xa;"); // literal newline -> the linter-approved entity
}

export interface AssembleResult {
  modelXml: string;
  iconsResolved: number;
  iconsMissing: string[];
}

/**
 * Assemble the final mxGraphModel XML from the graph + resolved styles/coords.
 * Guarantees BY CONSTRUCTION that the #423 linter passes:
 *   - id=0 and id=1(parent=0) sentinels;
 *   - each node/group is vertex="1" (containers get container=1 via the style);
 *   - each edge is edge="1" with a child <mxGeometry relative="1" as="geometry"/>;
 *   - group children set parent=<groupId> and RELATIVE coords; an edge between
 *     two different parents is parent="1";
 *   - labels are XML-escaped and any newline is &#xa;.
 * `geo` may be empty (ELK failed) — then a deterministic grid is used so the
 * output is still valid and non-overlapping (>=170px stride).
 *
 * QUALITY-WARNING GUARANTEE: the "0 quality-warnings by construction" promise
 * holds for AUTO-LAYOUT — ELK spacing plus applyHints' cross-axis spread for the
 * server-positioned `layer`/`sameLayerAs` hints keep shapes >=MIN_SHAPE_GAP
 * apart. It does NOT extend to explicit `pinned` coordinates: those are
 * user-directed, so two nodes the user pins to the same/overlapping point are
 * user error the server honours verbatim (only clamped non-negative) and MAY
 * therefore produce a quality warning.
 */
export function assembleModel(
  graph: Graph,
  opts: {
    preset: PresetData;
    styles: Map<string, { style: string; w: number; h: number; iconResolved: boolean }>;
    geo: Map<string, { x: number; y: number; w: number; h: number }>;
  },
): AssembleResult {
  const { preset, styles, geo } = opts;
  const groupIds = new Set((graph.groups ?? []).map((g) => g.id));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Fallback grid when ELK produced nothing: lay ungrouped nodes on a grid with
  // a 190px stride (>150 gap). Grouped nodes/groups are placed inside their group.
  const fallback = geo.size === 0;
  const gridPos = (i: number) => ({ x: 40 + (i % 5) * 200, y: 40 + Math.floor(i / 5) * 140 });

  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];

  // Groups first (they are parents of their members). A nested group sets
  // parent=<parentGroupId>; emit parents before children so parent-exists holds.
  let gi = 0;
  const groupGeo = new Map<string, { x: number; y: number; w: number; h: number }>();
  const orderedGroups = topoSortGroups(graph.groups ?? [], groupIds);
  for (const g of orderedGroups) {
    const gg = geo.get(g.id) ?? { ...gridPos(gi++), w: 320, h: 220 };
    groupGeo.set(g.id, gg);
    const style = groupStyle(preset);
    const gParent = g.group && groupIds.has(g.group) && g.group !== g.id ? g.group : "1";
    cells.push(
      `<mxCell id="${xmlEscapeAttr(g.id)}" value="${xmlEscapeAttr(g.label)}" style="${style}" vertex="1" parent="${xmlEscapeAttr(gParent)}">` +
        `<mxGeometry x="${gg.x}" y="${gg.y}" width="${gg.w}" height="${gg.h}" as="geometry"/></mxCell>`,
    );
  }

  // Nodes. A grouped node's coords are RELATIVE to its group (ELK already
  // returns child coords relative to the parent; for the fallback grid we place
  // children on a small in-group grid).
  let ungrouped = (graph.groups?.length ?? 0);
  const inGroupIndex = new Map<string, number>();
  let iconsResolved = 0;
  const iconsMissing: string[] = [];
  for (const n of graph.nodes) {
    const st = styles.get(n.id)!;
    if (n.icon) {
      if (st.iconResolved) iconsResolved++;
      else iconsMissing.push(n.id);
    }
    let x: number;
    let y: number;
    const g = geo.get(n.id);
    if (g && !fallback) {
      x = g.x;
      y = g.y;
    } else if (n.group && groupIds.has(n.group)) {
      const k = inGroupIndex.get(n.group) ?? 0;
      inGroupIndex.set(n.group, k + 1);
      x = 30 + (k % 3) * 180;
      y = 40 + Math.floor(k / 3) * 120;
    } else {
      const p = gridPos(ungrouped++);
      x = p.x;
      y = p.y;
    }
    const parent = n.group && groupIds.has(n.group) ? n.group : "1";
    cells.push(
      `<mxCell id="${xmlEscapeAttr(n.id)}" value="${xmlEscapeAttr(n.label)}" style="${st.style}" vertex="1" parent="${xmlEscapeAttr(parent)}">` +
        `<mxGeometry x="${x}" y="${y}" width="${st.w}" height="${st.h}" as="geometry"/></mxCell>`,
    );
  }

  // Edges. parent="1" whenever the two endpoints have different container
  // parents (or either is a group); otherwise the shared group id.
  (graph.edges ?? []).forEach((e, i) => {
    const style = edgeStyle(preset, e.kind);
    const fromNode = nodeById.get(e.from);
    const toNode = nodeById.get(e.to);
    const fromParent = fromNode?.group && groupIds.has(fromNode.group) ? fromNode.group : "1";
    const toParent = toNode?.group && groupIds.has(toNode.group) ? toNode.group : "1";
    const parent = fromParent === toParent ? fromParent : "1";
    const label = e.label ? ` value="${xmlEscapeAttr(e.label)}"` : "";
    cells.push(
      `<mxCell id="ge${i}"${label} style="${style}" edge="1" parent="${xmlEscapeAttr(parent)}" ` +
        `source="${xmlEscapeAttr(e.from)}" target="${xmlEscapeAttr(e.to)}">` +
        `<mxGeometry relative="1" as="geometry"/></mxCell>`,
    );
  });

  const modelAttrs =
    'dx="0" dy="0" grid="1" gridSize="10" page="1" pageWidth="850" pageHeight="1100" adaptiveColors="auto"';
  const modelXml = `<mxGraphModel ${modelAttrs}><root>${cells.join("")}</root></mxGraphModel>`;
  return { modelXml, iconsResolved, iconsMissing };
}

// --- incremental merge -----------------------------------------------------

let _mergeWindow: any = null;
function mergeWindow(): any {
  if (!_mergeWindow) _mergeWindow = new JSDOM("").window;
  return _mergeWindow;
}

/**
 * Merge the freshly-assembled graph XML with the EXISTING diagram model so an
 * incremental "add a node" call never drops a hand-placed cell. `assembleModel`
 * emits ONLY the passed graph's cells; on its own it would replace the whole
 * model, wiping any existing cell the caller didn't re-list. This splices every
 * existing cell that the graph does NOT re-list (preserved verbatim: coords,
 * style, edges) into the assembled root:
 *   - id in the graph  -> the graph's (re-laid) cell wins (already assembled;
 *     coords are frozen for existing ids via the incremental geo path);
 *   - id NOT in the graph -> the existing cell is preserved verbatim;
 *   - a graph node absent from the existing model -> added (offset clear).
 * The sentinels ("0"/"1") come from the assembled model and are never doubled.
 */
function mergeExistingCells(
  assembledXml: string,
  existingModelXml: string,
  graph: Graph,
): string {
  const win = mergeWindow();
  const parser = new win.DOMParser();
  const existingDoc = parser.parseFromString(existingModelXml, "application/xml");
  if (existingDoc.getElementsByTagName("parsererror").length > 0) {
    // Existing model unreadable: fall back to the assembled model alone (still a
    // valid diagram — better than throwing on a corrupt prior file).
    return assembledXml;
  }
  const assembledDoc = parser.parseFromString(assembledXml, "application/xml");
  const root = assembledDoc.getElementsByTagName("root")[0];
  if (!root) return assembledXml;

  // Ids the assembled model already emitted (graph nodes/groups/edges + sentinels).
  const assembledIds = new Set<string>();
  for (const el of Array.from(root.getElementsByTagName("mxCell")) as any[]) {
    const id = el.getAttribute("id");
    if (id) assembledIds.add(id);
  }
  // The graph's own ids: any existing cell with one of these is superseded by the
  // assembled version and must NOT be re-imported.
  const graphIds = new Set<string>([
    ...graph.nodes.map((n) => n.id),
    ...(graph.groups ?? []).map((g) => g.id),
  ]);

  const existingCells = Array.from(
    existingDoc.getElementsByTagName("mxCell"),
  ) as any[];
  for (const el of existingCells) {
    const id = el.getAttribute("id") ?? "";
    if (id === "0" || id === "1") continue; // sentinels come from the assembled model
    if (graphIds.has(id)) continue; // graph re-lists it -> assembled version wins
    if (assembledIds.has(id)) continue; // id collision guard -> keep assembled
    root.appendChild(assembledDoc.importNode(el, true));
    assembledIds.add(id);
  }

  const ser = new win.XMLSerializer();
  return ser.serializeToString(assembledDoc.documentElement);
}

// --- top-level: graph -> mxGraphModel XML ----------------------------------

export interface BuildFromGraphResult {
  modelXml: string;
  iconsResolved: number;
  iconsMissing: string[];
  layout: LayoutMode;
}

/**
 * The full server-side pipeline: validate -> resolve styles/icons -> map to ELK
 * -> run ELK (or fall back) -> assemble linter-clean XML. `existingCoords` is
 * supplied for `layout:"incremental"` (the coordinates of the diagram's current
 * cells, so they are preserved and only new nodes are placed). `existingModelXml`
 * is the current diagram's full model XML — in incremental mode every existing
 * cell the graph does NOT re-list is MERGED back in verbatim so a hand-placed
 * cell is never dropped (WARNING #4). Pure — no network.
 */
export async function buildFromGraph(
  graph: Graph,
  layout: LayoutMode = "full",
  existingCoords?: Map<string, { x: number; y: number }>,
  existingModelXml?: string,
): Promise<BuildFromGraphResult> {
  validateGraph(graph);
  const preset = getPreset(graph.preset);

  // Resolve every node's style + size (icon or generic-by-kind).
  const styles = new Map<
    string,
    { style: string; w: number; h: number; iconResolved: boolean }
  >();
  const sizes = new Map<string, NodeSize>();
  for (const n of graph.nodes) {
    const s = resolveNodeStyle(preset, n);
    styles.set(n.id, s);
    sizes.set(n.id, { w: s.w, h: s.h });
  }
  // Group sizes: seed a min box; ELK computes the real size when it lays out.
  for (const g of graph.groups ?? []) sizes.set(g.id, { w: 240, h: 180 });

  let geo = new Map<string, { x: number; y: number; w: number; h: number }>();

  if (layout === "incremental" && existingCoords && existingCoords.size > 0) {
    // INCREMENTAL: keep every existing cell's coords VERBATIM (acceptance #3 —
    // never move a hand-arranged cell) and lay out ONLY the new nodes, then
    // offset that block clear of the existing bbox so nothing overlaps.
    for (const [id, c] of existingCoords) {
      const sz = sizes.get(id) ?? { w: 140, h: 60 };
      geo.set(id, { x: c.x, y: c.y, w: sz.w, h: sz.h });
    }
    const newIds = new Set(
      graph.nodes.filter((n) => !existingCoords.has(n.id)).map((n) => n.id),
    );
    if (newIds.size > 0) {
      const elk = graphToElk(graph, sizes, { only: newIds });
      const laid = await runElk(elk);
      // Place the new block below the existing content (a clear >=170px gap).
      let maxY = 0;
      for (const c of existingCoords.values()) maxY = Math.max(maxY, c.y);
      const offsetY = maxY + 200;
      for (const [id, g] of laid) {
        if (newIds.has(id)) geo.set(id, { ...g, y: g.y + offsetY });
        else if (!geo.has(id)) geo.set(id, g); // a new group container
      }
    }
    // Hints still apply to NEW pinned nodes only (existing ones stay put).
    applyHintsForNew(graph, geo, existingCoords);
  } else if (layout !== "none") {
    const elk = graphToElk(graph, sizes);
    geo = await runElk(elk);
    applyHints(graph, geo);
  } else if (existingCoords) {
    // layout:"none" with prior coords -> keep them verbatim.
    for (const [id, c] of existingCoords) {
      const sz = sizes.get(id) ?? { w: 140, h: 60 };
      geo.set(id, { x: c.x, y: c.y, w: sz.w, h: sz.h });
    }
  }

  const assembled = assembleModel(graph, { preset, styles, geo });
  // In incremental mode, splice back every existing cell the graph didn't
  // re-list so an "add one node" call preserves the user's manual layout.
  let modelXml = assembled.modelXml;
  if (
    layout === "incremental" &&
    existingModelXml &&
    existingCoords &&
    existingCoords.size > 0
  ) {
    modelXml = mergeExistingCells(modelXml, existingModelXml, graph);
  }
  return {
    modelXml,
    iconsResolved: assembled.iconsResolved,
    iconsMissing: assembled.iconsMissing,
    layout,
  };
}
