// ID-based cell operations for `drawioEditCells` (issue #425, stage 3).
//
// Instead of resending the whole XML (whose diff is fragile — draw.io reorders
// attributes, and a {search,replace} text match breaks on it), the model sends
// targeted operations keyed by cell id:
//
//   { op: "add",    xml: "<mxCell .../>" }            // append a new cell
//   { op: "update", cellId: "n3", xml: "<mxCell .../>" }  // replace that cell
//   { op: "delete", cellId: "n5" }                    // + CASCADE
//
// `delete` CASCADES: it removes the cell, every descendant cell whose parent
// chain leads to it (container children), AND every edge whose source or target
// is any deleted cell. Ids are STABLE across edits so diffs stay meaningful.
//
// Operations apply to the parsed DOM of the current model; the caller re-lints
// and rebuilds the .drawio.svg through the existing #423 pipeline afterwards.

import { JSDOM } from "jsdom";

let _window: any = null;
function xmlWindow(): any {
  if (!_window) _window = new JSDOM("").window;
  return _window;
}

export type CellOp =
  | { op: "add"; xml: string }
  | { op: "update"; cellId: string; xml: string }
  | { op: "delete"; cellId: string };

export class CellOpsError extends Error {
  constructor(message: string) {
    super(`drawioEditCells: ${message}`);
    this.name = "CellOpsError";
  }
}

// The mxGraph root sentinels. id="0" is the graph root; id="1" is the default
// layer that parents every real cell. A delete targeting either would cascade
// through the whole diagram body (every cell chains up to "1"), so such an op is
// rejected outright.
const SENTINEL_IDS = new Set(["0", "1"]);

/** Parse a single `<mxCell …>…</mxCell>` fragment into an element, or throw. */
function parseCellFragment(xml: string): any {
  const parser = new (xmlWindow().DOMParser)();
  // Wrap so a self-closed or child-bearing single cell parses as one root.
  const doc = parser.parseFromString(`<root>${xml}</root>`, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new CellOpsError(`operation xml is not well-formed: ${xml.slice(0, 120)}`);
  }
  const cells = doc.getElementsByTagName("mxCell");
  if (cells.length !== 1) {
    throw new CellOpsError(
      `each add/update op must carry exactly one <mxCell> (got ${cells.length})`,
    );
  }
  return cells[0];
}

/** All ids reachable as descendants of `rootId` via the parent relation. */
function collectDescendants(
  rootId: string,
  parentOf: Map<string, string | undefined>,
): Set<string> {
  const doomed = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, parent] of parentOf) {
      if (!doomed.has(id) && parent != null && doomed.has(parent)) {
        doomed.add(id);
        grew = true;
      }
    }
  }
  return doomed;
}

/**
 * Apply the operation list to a model XML string and return the new model XML.
 * Uses the DOM so attribute order / formatting is preserved for untouched cells.
 * Throws CellOpsError on an unknown target id or a malformed op fragment (so the
 * model gets a precise error and nothing is half-applied).
 */
export function applyCellOps(modelXml: string, ops: CellOp[]): string {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new CellOpsError("operations must be a non-empty array");
  }
  const parser = new (xmlWindow().DOMParser)();
  const doc = parser.parseFromString(modelXml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new CellOpsError("the current diagram XML is not well-formed");
  }
  const root = doc.getElementsByTagName("root")[0];
  if (!root) throw new CellOpsError("the current diagram has no <root> element");

  const cellEls = () => Array.from(root.getElementsByTagName("mxCell")) as any[];
  const byId = () => {
    const m = new Map<string, any>();
    for (const el of cellEls()) m.set(el.getAttribute("id") ?? "", el);
    return m;
  };

  for (const op of ops) {
    if (op.op === "add") {
      const frag = parseCellFragment(op.xml);
      const id = frag.getAttribute("id");
      if (!id) throw new CellOpsError("an add op's <mxCell> is missing an id");
      if (byId().has(id))
        throw new CellOpsError(`add op id "${id}" already exists (use update)`);
      root.appendChild(doc.importNode(frag, true));
    } else if (op.op === "update") {
      const map = byId();
      const target = map.get(op.cellId);
      if (!target)
        throw new CellOpsError(`update target cell "${op.cellId}" does not exist`);
      const frag = parseCellFragment(op.xml);
      const newId = frag.getAttribute("id");
      if (newId && newId !== op.cellId)
        throw new CellOpsError(
          `update op cellId "${op.cellId}" != the <mxCell> id "${newId}" (ids are stable)`,
        );
      // Replace the element in place so surrounding cells are untouched.
      const imported = doc.importNode(frag, true);
      target.parentNode.replaceChild(imported, target);
    } else if (op.op === "delete") {
      // Reject a sentinel-targeted delete BEFORE collecting descendants: "0"/"1"
      // parent the entire diagram, so a cascade from either would wipe the whole
      // model body (doomed.delete("0"/"1") only spared the sentinel itself, not
      // its children).
      if (SENTINEL_IDS.has(op.cellId))
        throw new CellOpsError(
          `cannot delete sentinel cell "${op.cellId}" (the graph root/default layer)`,
        );
      const map = byId();
      if (!map.has(op.cellId))
        throw new CellOpsError(`delete target cell "${op.cellId}" does not exist`);
      // Build the parent relation over the CURRENT cells for the cascade.
      const parentOf = new Map<string, string | undefined>();
      for (const el of cellEls()) {
        parentOf.set(el.getAttribute("id") ?? "", el.getAttribute("parent") ?? undefined);
      }
      const doomed = collectDescendants(op.cellId, parentOf);
      // Cascade to edges whose source/target is any doomed cell.
      for (const el of cellEls()) {
        if (el.getAttribute("edge") !== "1") continue;
        const src = el.getAttribute("source");
        const tgt = el.getAttribute("target");
        if ((src && doomed.has(src)) || (tgt && doomed.has(tgt))) {
          doomed.add(el.getAttribute("id") ?? "");
        }
      }
      // Never delete the sentinels even if referenced by a malformed op.
      doomed.delete("0");
      doomed.delete("1");
      for (const el of cellEls()) {
        const id = el.getAttribute("id") ?? "";
        if (doomed.has(id)) el.parentNode.removeChild(el);
      }
    } else {
      throw new CellOpsError(`unknown op "${(op as any).op}"`);
    }
  }

  const ser = new (xmlWindow().XMLSerializer)();
  return ser.serializeToString(doc.documentElement);
}
