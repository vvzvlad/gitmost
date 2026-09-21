// Pure Mermaid `flowchart` -> graph-JSON parser for `drawioFromMermaid` (issue
// #425, stage 3, OPTIONAL). The escape clause in the issue: convert WITHOUT
// Electron/draw.io-CLI, so a pure text parser only. It handles the common wiki
// flowchart subset — node shapes, labelled/dashed edges, subgraphs (-> groups),
// and the direction header — and emits a Graph the drawioFromGraph pipeline
// renders as an EDITABLE draw.io diagram. Anything beyond flowchart (sequence /
// class / state) throws a clear error so the model falls back to drawioFromGraph.
//
// DELIBERATELY NARROW: this is not a full Mermaid grammar (Mermaid's own parser
// is a 100KB+ browser dependency). It covers `flowchart`/`graph` with the node
// shapes and edge arrows that show up in practice; unusual syntax is skipped
// rather than mis-parsed, and a diagram that yields no nodes throws.

import type { Graph, GraphNode, GraphEdge, GraphGroup } from "./drawio-graph.js";

export class MermaidParseError extends Error {
  constructor(message: string) {
    super(`drawioFromMermaid: ${message}`);
    this.name = "MermaidParseError";
  }
}

// Input-size bounds applied BEFORE parsing. Without them a pathological mermaid
// string (e.g. 300000 connection lines, or 20000 nested `subgraph`s) builds a
// huge intermediate node/edge/group structure that OOM-crashes the worker — the
// downstream validateGraph caps in drawio-graph can't help because the parser
// exhausts the heap constructing the intermediate FIRST. These caps reject the
// over-limit input fast, before a single line is parsed.
const MAX_MERMAID_CHARS = 200_000; // ~200 KB of source is far beyond any real diagram.
const MAX_MERMAID_LINES = 20_000;
const MAX_MERMAID_GROUPS = 500; // parity with drawio-graph's MAX_GRAPH_GROUPS.
// Per connection line, the number of chained nodes we will expand (`A-->B-->C`).
const MAX_CHAIN_NODES = 500;

const DIRECTIONS: Record<string, Graph["direction"]> = {
  LR: "LR",
  RL: "RL",
  TB: "TB",
  TD: "TB",
  BT: "BT",
};

/**
 * Node-shape delimiters -> a semantic `kind`. Mermaid encodes shape in the
 * bracket style; we map the common ones to the palette kinds so the diagram is
 * colored meaningfully (a decision/diamond -> queue, a database cylinder -> db,
 * a rounded/stadium -> service, a subroutine/hexagon -> gateway, default rect ->
 * service). The label text lives between the delimiters.
 */
interface ShapeDef {
  open: string;
  close: string;
  kind: string;
}
// Order matters: longer/multi-char delimiters first so "([" beats "(".
const SHAPES: ShapeDef[] = [
  { open: "([", close: "])", kind: "service" }, // stadium
  { open: "[[", close: "]]", kind: "gateway" }, // subroutine
  { open: "[(", close: ")]", kind: "db" }, // cylinder-ish / database
  { open: "((", close: "))", kind: "external" }, // circle
  { open: "{{", close: "}}", kind: "gateway" }, // hexagon
  { open: "[", close: "]", kind: "service" }, // rectangle
  { open: "(", close: ")", kind: "service" }, // rounded
  { open: "{", close: "}", kind: "queue" }, // rhombus / decision
  { open: ">", close: "]", kind: "external" }, // asymmetric flag
];

/** Strip Mermaid label quoting/escapes and normalise whitespace. */
function cleanLabel(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  return s.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
}

/** A single edge-arrow spec: its regex and the resulting edge `kind`. */
interface ArrowDef {
  re: RegExp;
  kind: string;
}
// Dotted arrows (`-.->`) -> async; thick (`==>`) stay sync; normal `-->`/`---`.
// Each captures an optional `|label|` OR inline label between the two arrow
// halves. Applied to the segment between two node tokens.
const ARROWS: ArrowDef[] = [
  { re: /-\.->|-\.-/, kind: "async" },
  { re: /==>|===/, kind: "sync" },
  { re: /-->|---/, kind: "sync" },
];

interface ParsedRef {
  id: string;
  node?: GraphNode;
}

/**
 * Parse a single node token like `A`, `A[Label]`, `db[(Orders)]`, `d{Choose}`.
 * Returns the id and, when the token declares a shape/label, a GraphNode.
 */
function parseNodeToken(token: string): ParsedRef | null {
  const t = token.trim();
  if (t === "") return null;
  for (const shape of SHAPES) {
    const oi = t.indexOf(shape.open);
    if (oi <= 0) continue;
    if (!t.endsWith(shape.close)) continue;
    const id = t.slice(0, oi).trim();
    const label = cleanLabel(t.slice(oi + shape.open.length, t.length - shape.close.length));
    if (!id) return null;
    return { id, node: { id, label: label || id, kind: shape.kind } };
  }
  // Bare id (no shape declared here — may be defined elsewhere).
  if (/^[A-Za-z0-9_.-]+$/.test(t)) return { id: t };
  return null;
}

/**
 * Split a connection line into [leftToken, arrowSegment, rightToken]. Returns
 * null if the line has no arrow. The arrow segment may embed a label as
 * `-->|text|` or `-- text -->`.
 */
function splitConnection(
  line: string,
): { left: string; right: string; kind: string; label?: string } | null {
  for (const arrow of ARROWS) {
    // Find the arrow occurrence. Support a mid-arrow label: `A -- text --> B`.
    const m = arrow.re.exec(line);
    if (!m) continue;
    const idx = m.index;
    let left = line.slice(0, idx).trim();
    let rest = line.slice(idx + m[0].length).trim();
    let label: string | undefined;
    // Pipe label: `-->|HTTPS| B`.
    const pipe = /^\|([^|]*)\|\s*(.*)$/.exec(rest);
    if (pipe) {
      label = cleanLabel(pipe[1]);
      rest = pipe[2].trim();
    }
    // Mid-arrow label on the left side: `A -- text` before the arrow half.
    const midLeft = /^(.*?)\s*--\s*(.+)$/.exec(left);
    if (!label && midLeft && /-\.|--|==/.test(line.slice(0, idx))) {
      // Only treat as a label when there's clearly text after `--`.
      if (!/[\[\](){}]/.test(midLeft[2])) {
        left = midLeft[1].trim();
        label = cleanLabel(midLeft[2]);
      }
    }
    if (!left || !rest) return null;
    return { left, right: rest, kind: arrow.kind, label };
  }
  return null;
}

/**
 * Parse Mermaid flowchart text into a Graph. Handles the header
 * (`flowchart LR` / `graph TD`), `subgraph <id>[title] … end` blocks (-> groups),
 * node declarations, and connection lines. Throws MermaidParseError for a
 * non-flowchart diagram or when nothing parses.
 */
export function mermaidToGraph(mermaid: string): Graph {
  if (typeof mermaid !== "string" || mermaid.trim() === "") {
    throw new MermaidParseError("empty mermaid input");
  }
  // Size guards FIRST — bound the raw input before building any intermediate.
  if (mermaid.length > MAX_MERMAID_CHARS) {
    throw new MermaidParseError(
      `input is ${mermaid.length} chars (max ${MAX_MERMAID_CHARS}); split the diagram or use drawioFromGraph`,
    );
  }
  const rawLines = mermaid.split(/\r?\n/);
  if (rawLines.length > MAX_MERMAID_LINES) {
    throw new MermaidParseError(
      `input has ${rawLines.length} lines (max ${MAX_MERMAID_LINES}); split the diagram or use drawioFromGraph`,
    );
  }
  const nodes = new Map<string, GraphNode>();
  const groups: GraphGroup[] = [];
  const edges: GraphEdge[] = [];
  let direction: Graph["direction"] = "LR";
  let sawHeader = false;

  // Stack of active subgraph ids (nesting); the top is the current group.
  const groupStack: string[] = [];
  let anonGroup = 0;

  const ensureNode = (ref: ParsedRef) => {
    const existing = nodes.get(ref.id);
    if (ref.node) {
      if (existing) {
        // Fill in a label/kind if this token declared a shape and the prior didn't.
        if (existing.label === existing.id && ref.node.label !== ref.node.id)
          existing.label = ref.node.label;
        if (!existing.kind) existing.kind = ref.node.kind;
      } else {
        nodes.set(ref.id, { ...ref.node });
      }
    } else if (!existing) {
      nodes.set(ref.id, { id: ref.id, label: ref.id, kind: "service" });
    }
    // Assign to the current subgraph if inside one and not yet grouped.
    const cur = groupStack[groupStack.length - 1];
    const n = nodes.get(ref.id)!;
    if (cur && n.group == null) n.group = cur;
  };

  for (const raw of rawLines) {
    let line = raw.trim();
    if (line === "" || line.startsWith("%%")) continue; // blank / comment

    // Header.
    const header = /^(flowchart|graph)\s+([A-Za-z]{2})\b/.exec(line);
    if (header) {
      sawHeader = true;
      const dir = DIRECTIONS[header[2].toUpperCase()];
      if (dir) direction = dir;
      continue;
    }
    if (/^(sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey)\b/.test(line)) {
      throw new MermaidParseError(
        `only 'flowchart'/'graph' is supported (got '${line.split(/\s+/)[0]}'); use drawioFromGraph instead`,
      );
    }

    // Subgraph open: `subgraph id [Title]` or `subgraph Title`.
    const sg = /^subgraph\s+(.+)$/.exec(line);
    if (sg) {
      const spec = sg[1].trim();
      let id: string;
      let label: string;
      const bracket = /^([A-Za-z0-9_.-]+)\s*\[(.+)\]$/.exec(spec);
      if (bracket) {
        id = bracket[1];
        label = cleanLabel(bracket[2]);
      } else if (/^[A-Za-z0-9_.-]+$/.test(spec)) {
        id = spec;
        label = spec;
      } else {
        id = `sg${anonGroup++}`;
        label = cleanLabel(spec);
      }
      if (!groups.some((g) => g.id === id)) {
        if (groups.length >= MAX_MERMAID_GROUPS) {
          throw new MermaidParseError(
            `too many subgraphs (max ${MAX_MERMAID_GROUPS}); use drawioFromGraph for a diagram this large`,
          );
        }
        groups.push({ id, label, kind: "group" });
      }
      groupStack.push(id);
      continue;
    }
    if (/^end\b/.test(line)) {
      groupStack.pop();
      continue;
    }
    // `direction LR` inside a subgraph — apply to the top-level direction.
    const innerDir = /^direction\s+([A-Za-z]{2})\b/.exec(line);
    if (innerDir) {
      const dir = DIRECTIONS[innerDir[1].toUpperCase()];
      if (dir) direction = dir;
      continue;
    }
    // Style/class/click directives: ignore (no visual mapping in our palette).
    if (/^(style|classDef|class|click|linkStyle)\b/.test(line)) continue;

    // Strip a trailing semicolon.
    if (line.endsWith(";")) line = line.slice(0, -1).trim();

    // Connection line (possibly chained: A --> B --> C).
    const conn = splitConnection(line);
    if (conn) {
      // Handle a simple chain by re-splitting the right side.
      let leftTok = conn.left;
      let seg: typeof conn | null = conn;
      let guard = 0;
      while (seg) {
        if (guard++ >= MAX_CHAIN_NODES) {
          // Don't silently drop the tail of an over-long chain — surface it so
          // the model knows the diagram was too large rather than getting a
          // quietly-truncated result.
          throw new MermaidParseError(
            `a single connection chain exceeds ${MAX_CHAIN_NODES} nodes; split it or use drawioFromGraph`,
          );
        }
        const leftRef = parseNodeToken(leftTok);
        // The right side may itself contain another arrow (a chain).
        const nextSeg = splitConnection(seg.right);
        const rightTokenStr = nextSeg ? seg.right.slice(0, splitIndex(seg.right)) : seg.right;
        const rightRef = parseNodeToken(nextSeg ? nextSeg.left : seg.right);
        if (leftRef && rightRef) {
          ensureNode(leftRef);
          ensureNode(rightRef);
          edges.push({
            from: leftRef.id,
            to: rightRef.id,
            label: seg.label,
            kind: seg.kind,
          });
        }
        if (!nextSeg) break;
        leftTok = nextSeg.left;
        seg = nextSeg;
        void rightTokenStr;
      }
      continue;
    }

    // Standalone node declaration `A[Label]` OR a bare member ref `C` inside a
    // subgraph (which claims that node for the current group).
    const nodeRef = parseNodeToken(line);
    if (nodeRef && (nodeRef.node || groupStack.length > 0)) {
      ensureNode(nodeRef);
      continue;
    }
    // Unknown line: skip silently (robustness over strictness).
  }

  if (!sawHeader && nodes.size === 0) {
    throw new MermaidParseError(
      "input does not look like a mermaid flowchart (no 'flowchart'/'graph' header and no nodes)",
    );
  }
  if (nodes.size === 0) {
    throw new MermaidParseError("no nodes parsed from the flowchart");
  }

  const graph: Graph = {
    nodes: Array.from(nodes.values()),
    direction,
  };
  if (groups.length > 0) graph.groups = groups;
  if (edges.length > 0) graph.edges = edges;
  return graph;
}

/** Index of the first arrow in a segment (for chain splitting). */
function splitIndex(s: string): number {
  let best = -1;
  for (const arrow of ARROWS) {
    const m = arrow.re.exec(s);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best === -1 ? s.length : best;
}
