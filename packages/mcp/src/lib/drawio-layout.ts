// ELK auto-layout for draw.io models (issue #424, stage 2). The model declares
// the LOGICAL structure (which nodes exist, which containers nest which
// children, which edges connect what) with rough or arbitrary coordinates; this
// module runs an Eclipse Layout Kernel "layered" pass (via elkjs — a pure-JS
// port, no native/browser deps) that HONOURS nested containers as compound
// nodes, then rewrites every vertex's <mxGeometry> with the computed pixels.
//
// Principle: "the model declares logical structure, the server computes pixels."
// Coordinates ELK returns for a node are relative to its parent, which is
// exactly mxGraph's convention for a child of a container, so they map across
// directly. Container sizes are computed by ELK; leaf sizes are preserved.

import { Worker } from "node:worker_threads";
import { JSDOM } from "jsdom";
import { normalizeInput, parseCells, type DrawioCell } from "./drawio-xml.js";

// Default sizes when a vertex declares no geometry (appendix base sizes).
const DEFAULT_W = 140;
const DEFAULT_H = 60;

// DoS bounds for the ELK layout. The mxGraph XML is LLM-supplied (layout:"elk"
// in drawioCreate/drawioUpdate). elkjs' layout() returns a Promise but runs the
// crossing-minimisation SYNCHRONOUSLY — it blocks whatever thread it runs on for
// the whole pass. A ~1MB XML (well under the stage-1 16MB cap) can carry
// thousands of nodes. We (a) cap the graph size before ever calling ELK and
// (b) run the layout in a WORKER THREAD so the main event loop stays free, with
// the wall-clock timeout enforced by terminating that worker. On either bound we
// fall back to the ORIGINAL model, the same best-effort contract the catch honours.
//   - 500 nodes lays out in well under a second; beyond that ELK cost climbs
//     steeply, so refuse and leave the (already-valid) model untouched.
//   - Edges dominate the layered-crossing cost, so allow a bit more headroom
//     (1000) than nodes but still bound them.
//   - The timeout is a HARD kill of the worker thread — the only way to interrupt
//     synchronous JS. The in-process setTimeout race we used before was an
//     illusion: the timer could never fire while the SAME thread was blocked
//     inside elkjs, so it "protected" nothing. Now the timer runs on the main
//     thread while ELK runs on the worker, so it can actually fire and terminate.
const ELK_MAX_NODES = 500;
const ELK_MAX_EDGES = 1000;
// Wall-clock ceiling for a single layout pass. Overridable for tests (a tiny
// value forces the terminate-on-timeout path deterministically); a non-positive
// or unparseable override falls back to the default.
const ELK_TIMEOUT_DEFAULT_MS = 5000;
function resolveElkTimeoutMs(): number {
  const raw = Number(process.env.DRAWIO_ELK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : ELK_TIMEOUT_DEFAULT_MS;
}

// Spacing is set >=150px on purpose so an ELK layout never trips the linter's
// "gap between adjacent shapes < 150px" quality warning (acceptance #3).
const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  // Route edges across container boundaries in a single hierarchical pass.
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "170",
  "elk.spacing.nodeNode": "170",
  "elk.spacing.edgeNode": "40",
  "elk.spacing.edgeEdge": "30",
  "elk.padding": "[top=20,left=20,bottom=20,right=20]",
};

// Per-container options: pad children >=30px off the frame (appendix rule) and
// carry the same generous spacing so nested nodes never trip the "gap <150px"
// warning either.
const CONTAINER_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.padding": "[top=40,left=30,bottom=30,right=30]",
  "elk.layered.spacing.nodeNodeBetweenLayers": "170",
  "elk.spacing.nodeNode": "170",
};

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

/**
 * Run one ELK layered layout on a worker thread and resolve with the laid-out
 * graph. The timeout is enforced by `worker.terminate()` — a HARD kill, which is
 * the only way to interrupt elkjs' synchronous crossing-minimisation once it has
 * started. Rejects on timeout, worker error, or an early exit; the caller treats
 * any rejection as "keep the original model" (best-effort layout).
 */
function layoutInWorker(graph: ElkGraph, timeoutMs: number): Promise<ElkGraph> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./drawio-layout.worker.js", import.meta.url),
      { workerData: { graph } },
    );
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always tear the worker down: on the happy path so it does not linger,
      // on timeout so the blocked synchronous ELK run is actually interrupted.
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("ELK layout timed out"))),
      timeoutMs,
    );
    worker.once("message", (msg: { ok?: boolean; laid?: ElkGraph; error?: string }) => {
      finish(() =>
        msg?.ok
          ? resolve(msg.laid as ElkGraph)
          : reject(new Error(msg?.error ?? "ELK layout failed")),
      );
    });
    worker.once("error", (err) => finish(() => reject(err)));
    worker.once("exit", (code) => {
      // A clean exit after we already settled is normal (terminate()); only an
      // unexpected early exit while still pending is a failure.
      if (settled) return;
      finish(() => reject(new Error(`ELK worker exited early (code ${code})`)));
    });
  });
}

/**
 * Apply an ELK layered layout to a drawio input and return a full mxGraphModel
 * string with rewritten geometry. Accepts the same three input forms as
 * drawioCreate (a bare model, an <mxfile>, or a <mxCell> list). Async because
 * the layout runs on a worker thread. On any layout failure (including a
 * terminate-on-timeout) the ORIGINAL (normalized) model is returned unchanged —
 * layout is best-effort polish, never a reason to fail the write.
 */
export async function applyElkLayout(inputXml: string): Promise<string> {
  const modelXml = normalizeInput(inputXml);
  let cells: DrawioCell[];
  try {
    cells = parseCells(modelXml);
  } catch {
    return modelXml; // unparseable -> let the linter report it downstream
  }

  const byId = new Map(cells.map((c) => [c.id, c]));
  const vertices = cells.filter(
    (c) => c.vertex && c.id !== "0" && c.id !== "1",
  );
  if (vertices.length === 0) return modelXml;

  // A vertex is a CONTAINER iff some other vertex names it as parent.
  const childrenOf = new Map<string, DrawioCell[]>();
  for (const v of vertices) {
    const p = v.parent && byId.get(v.parent)?.vertex ? v.parent : "__root__";
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(v);
  }
  const isContainer = (id: string) => childrenOf.has(id);

  const buildNode = (v: DrawioCell): ElkNode => {
    const kids = childrenOf.get(v.id);
    const node: ElkNode = { id: v.id };
    if (kids && kids.length > 0) {
      node.children = kids.map(buildNode);
      node.layoutOptions = { ...CONTAINER_OPTIONS };
    } else {
      node.width = v.geometry.width ?? DEFAULT_W;
      node.height = v.geometry.height ?? DEFAULT_H;
    }
    return node;
  };

  const roots = (childrenOf.get("__root__") ?? []).map(buildNode);

  // All edges at the root; INCLUDE_CHILDREN lets them span the hierarchy. Only
  // edges whose endpoints are laid-out vertices are handed to ELK.
  const vertexIds = new Set(vertices.map((v) => v.id));
  const edges: ElkEdge[] = [];
  for (const c of cells) {
    if (!c.edge || !c.source || !c.target) continue;
    if (!vertexIds.has(c.source) || !vertexIds.has(c.target)) continue;
    edges.push({ id: c.id || `e${edges.length}`, sources: [c.source], targets: [c.target] });
  }

  // DoS guard: refuse to lay out an oversized LLM-supplied graph. elkjs runs
  // in-process on the event loop, so bound the work before we ever call it and
  // return the original model unchanged (best-effort, same as the catch below).
  if (vertices.length > ELK_MAX_NODES || edges.length > ELK_MAX_EDGES) {
    return modelXml;
  }

  const graph: ElkGraph = {
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: roots,
    edges,
  };

  let laid: ElkGraph;
  try {
    // Run the (synchronous-under-the-hood) ELK pass on a worker thread so the
    // main event loop is never blocked, and enforce the wall-clock ceiling by
    // terminating that worker on timeout. A graph under the node/edge caps but
    // still pathologically slow is hard-killed instead of wedging anything.
    laid = await layoutInWorker(graph, resolveElkTimeoutMs());
  } catch {
    return modelXml; // best-effort: keep the model as-is on timeout or ELK failure
  }

  // Collect computed geometry per node id (coords are parent-relative already).
  const geo = new Map<string, { x: number; y: number; w: number; h: number }>();
  const walk = (n: ElkNode) => {
    if (n.id !== "root") {
      geo.set(n.id, {
        x: Math.round(n.x ?? 0),
        y: Math.round(n.y ?? 0),
        w: Math.round(n.width ?? DEFAULT_W),
        h: Math.round(n.height ?? DEFAULT_H),
      });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(laid);

  return rewriteGeometry(modelXml, geo, isContainer);
}

/**
 * Rewrite each vertex cell's <mxGeometry> x/y (and width/height for containers,
 * whose size ELK computed) using the DOM, then serialize back. Leaf sizes are
 * left untouched. Edges and non-geometry attributes are preserved verbatim.
 */
function rewriteGeometry(
  modelXml: string,
  geo: Map<string, { x: number; y: number; w: number; h: number }>,
  isContainer: (id: string) => boolean,
): string {
  const dom = new JSDOM("");
  const parser = new dom.window.DOMParser();
  const doc = parser.parseFromString(modelXml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return modelXml;

  const cellEls = doc.getElementsByTagName("mxCell");
  for (let i = 0; i < cellEls.length; i++) {
    const el = cellEls[i];
    const id = el.getAttribute("id") || "";
    const g = geo.get(id);
    if (!g) continue;
    let geoEl: any = null;
    for (let j = 0; j < el.childNodes.length; j++) {
      const ch = el.childNodes[j];
      if (ch.nodeType === 1 && (ch as any).tagName === "mxGeometry") {
        geoEl = ch;
        break;
      }
    }
    if (!geoEl) {
      geoEl = doc.createElement("mxGeometry");
      geoEl.setAttribute("as", "geometry");
      el.appendChild(geoEl);
    }
    geoEl.setAttribute("x", String(g.x));
    geoEl.setAttribute("y", String(g.y));
    // Containers take ELK's computed size; leaves keep their authored size.
    if (isContainer(id) || !geoEl.hasAttribute("width")) {
      geoEl.setAttribute("width", String(g.w));
    }
    if (isContainer(id) || !geoEl.hasAttribute("height")) {
      geoEl.setAttribute("height", String(g.h));
    }
  }

  const ser = new dom.window.XMLSerializer();
  return ser.serializeToString(doc.documentElement);
}
