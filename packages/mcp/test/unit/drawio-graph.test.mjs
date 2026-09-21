// Unit tests for the drawioFromGraph pipeline (issue #425, stage 3): the
// semantic graph -> ELK -> linter-clean XML assembler, plus the layout hints
// (pinned / sameLayerAs / layer) and incremental layout. Pure — no client, no
// network — so they run under `node --test` against the built lib.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFromGraph,
  validateGraph,
  resolveNodeStyle,
  GraphValidationError,
} from "../../build/lib/drawio-graph.js";
import { getPreset } from "../../build/lib/drawio-presets.js";
import {
  prepareModel,
  parseCells,
  computeQualityWarnings,
} from "../../build/lib/drawio-xml.js";

function cellsOf(xml) {
  return parseCells(xml).filter((c) => c.id !== "0" && c.id !== "1");
}
function byId(xml) {
  const m = new Map();
  for (const c of parseCells(xml)) m.set(c.id, c);
  return m;
}

// --- Acceptance #1: 15-node graph, 2 nested groups, AWS icons ---------------

test("from_graph: 15+ nodes, 2 nested groups, AWS icons -> 0 lint errors, 0 warnings, all icons resolve", async () => {
  const awsIcons = [
    "aws:lambda", "aws:dynamodb", "aws:api_gateway", "aws:s3", "aws:sqs",
    "aws:sns", "aws:ec2", "aws:rds", "aws:cloudfront", "aws:elasticache",
    "aws:kinesis", "aws:cognito", "aws:secrets_manager", "aws:cloudwatch",
  ];
  const kinds = [
    "service", "db", "gateway", "service", "queue", "queue", "service", "db",
    "gateway", "db", "queue", "security", "security", "external",
  ];
  const nodes = [];
  for (let i = 0; i < 14; i++) {
    nodes.push({
      id: "n" + i,
      label: "Node " + i,
      kind: kinds[i],
      icon: awsIcons[i],
      group: i < 6 ? "sub1" : i < 10 ? "vpc1" : undefined,
    });
  }
  nodes.push({ id: "ext1", label: "External Service", kind: "external" });
  const graph = {
    nodes,
    groups: [
      { id: "vpc1", label: "VPC 10.0.0.0/16", kind: "vpc" },
      { id: "sub1", label: "Private Subnet", kind: "subnet", group: "vpc1" }, // NESTED
    ],
    edges: [
      { from: "n0", to: "n1", kind: "sync" },
      { from: "n1", to: "n2", kind: "async" },
      { from: "n2", to: "n3" },
      { from: "n3", to: "n7", kind: "sync" },
      { from: "n7", to: "n8" },
      { from: "n8", to: "ext1", kind: "error" },
      { from: "n4", to: "n5" },
      { from: "n10", to: "n11" },
    ],
    direction: "LR",
    preset: "default",
  };
  const r = await buildFromGraph(graph, "full");

  assert.equal(graph.nodes.length >= 15, true, "at least 15 nodes");
  // All icons resolved — NO empty squares.
  assert.equal(r.iconsMissing.length, 0, `unresolved icons: ${r.iconsMissing}`);
  assert.equal(r.iconsResolved, 14);

  // 0 lint errors + 0 quality-warnings.
  const prepared = prepareModel(r.modelXml);
  assert.equal(prepared.warnings.length, 0, prepared.warnings.join("\n"));

  // Groups are TRANSPARENT containers.
  const cells = byId(r.modelXml);
  for (const gid of ["vpc1", "sub1"]) {
    const g = cells.get(gid);
    assert.ok(g, `${gid} present`);
    assert.equal(g.styleMap.container, "1", `${gid} container=1`);
    assert.equal(g.styleMap.fillColor, "none", `${gid} fillColor=none`);
    assert.equal(g.styleMap.dropTarget, "1", `${gid} dropTarget=1`);
  }
  // The nested group sub1's parent IS vpc1 (nesting honoured).
  assert.equal(cells.get("sub1").parent, "vpc1");
  // A grouped node's parent is its group (relative coords).
  assert.equal(cells.get("n0").parent, "sub1");
});

test("from_graph: an UNKNOWN icon degrades to a labelled generic shape (never empty)", async () => {
  const graph = {
    nodes: [
      { id: "a", label: "Mystery", kind: "service", icon: "not:a-real-icon-xyz" },
      { id: "b", label: "Plain", kind: "db" },
    ],
    edges: [{ from: "a", to: "b" }],
  };
  const r = await buildFromGraph(graph, "full");
  const cells = byId(r.modelXml);
  // The node still carries its label and a real (non-empty) style with a fill.
  assert.equal(cells.get("a").value, "Mystery");
  assert.match(cells.get("a").style, /fillColor=/);
  // It is reported as missing so the model can see the degradation.
  assert.ok(r.iconsMissing.includes("a"));
});

// --- Acceptance #2: hints -----------------------------------------------------

test("from_graph: a pinned node stays at its exact coordinates", async () => {
  const graph = {
    nodes: [
      { id: "a", label: "A", pinned: { x: 40, y: 900 } },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  };
  const a = byId((await buildFromGraph(graph, "full")).modelXml).get("a");
  assert.equal(a.geometry.x, 40);
  assert.equal(a.geometry.y, 900);
});

test("from_graph: a sameLayerAs pair lands in the same layer (equal layer-axis coord)", async () => {
  const graph = {
    nodes: [
      { id: "x", label: "X" },
      { id: "y", label: "Y", sameLayerAs: "x" },
      { id: "z", label: "Z" },
    ],
    edges: [{ from: "z", to: "x" }, { from: "z", to: "y" }],
    direction: "LR", // layer axis = x
  };
  const cells = byId((await buildFromGraph(graph, "full")).modelXml);
  assert.equal(cells.get("x").geometry.x, cells.get("y").geometry.x);
});

test("from_graph: an explicit layer index co-aligns nodes on the layer axis", async () => {
  const graph = {
    nodes: [
      { id: "p", label: "P", layer: 0 },
      { id: "q", label: "Q", layer: 0 },
      { id: "r", label: "R", layer: 1 },
    ],
    edges: [{ from: "p", to: "r" }],
    direction: "LR",
  };
  const cells = byId((await buildFromGraph(graph, "full")).modelXml);
  assert.equal(cells.get("p").geometry.x, cells.get("q").geometry.x);
});

test("from_graph: TB direction snaps sameLayerAs on the Y axis", async () => {
  const graph = {
    nodes: [
      { id: "x", label: "X" },
      { id: "y", label: "Y", sameLayerAs: "x" },
      { id: "z", label: "Z" },
    ],
    edges: [{ from: "z", to: "x" }, { from: "z", to: "y" }],
    direction: "TB", // layer axis = y
  };
  const cells = byId((await buildFromGraph(graph, "full")).modelXml);
  assert.equal(cells.get("x").geometry.y, cells.get("y").geometry.y);
});

// --- Acceptance #3: incremental never moves existing cells --------------------

test("from_graph incremental: adding a node does NOT move existing cells", async () => {
  const existing = new Map([
    ["a", { x: 100, y: 100 }],
    ["b", { x: 400, y: 100 }],
  ]);
  const graph = {
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "cnew", label: "New" },
    ],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "cnew" }],
  };
  const cells = byId((await buildFromGraph(graph, "incremental", existing)).modelXml);
  assert.deepEqual(
    [cells.get("a").geometry.x, cells.get("a").geometry.y],
    [100, 100],
  );
  assert.deepEqual(
    [cells.get("b").geometry.x, cells.get("b").geometry.y],
    [400, 100],
  );
  // The new node was placed and does not overlap the frozen block.
  const cn = cells.get("cnew");
  assert.ok(cn.geometry.y >= 200, "new node placed clear of the existing block");
});

// --- direction honoured -------------------------------------------------------

test("from_graph: LR vs RL flip the layout axis order", async () => {
  const mk = (dir) => ({
    nodes: [{ id: "s", label: "S" }, { id: "t", label: "T" }],
    edges: [{ from: "s", to: "t" }],
    direction: dir,
  });
  const lr = byId((await buildFromGraph(mk("LR"), "full")).modelXml);
  // In LR the target sits to the RIGHT of the source.
  assert.ok(lr.get("t").geometry.x > lr.get("s").geometry.x, "LR: t right of s");
  const rl = byId((await buildFromGraph(mk("RL"), "full")).modelXml);
  assert.ok(rl.get("t").geometry.x < rl.get("s").geometry.x, "RL: t left of s");
});

// --- validation ---------------------------------------------------------------

test("validateGraph: rejects duplicate node ids, unknown group/edge refs", () => {
  assert.throws(
    () => validateGraph({ nodes: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }),
    GraphValidationError,
  );
  assert.throws(
    () => validateGraph({ nodes: [{ id: "a", label: "A", group: "ghost" }] }),
    /unknown group/,
  );
  assert.throws(
    () =>
      validateGraph({
        nodes: [{ id: "a", label: "A" }],
        edges: [{ from: "a", to: "ghost" }],
      }),
    /resolves to no node/,
  );
  assert.throws(() => validateGraph({ nodes: [] }), /non-empty/);
});

test("resolveNodeStyle: kind maps to the preset palette slot for a generic node", () => {
  const preset = getPreset("default");
  const s = resolveNodeStyle(preset, { id: "d", label: "DB", kind: "db" });
  assert.equal(s.iconResolved, false);
  assert.match(s.style, /fillColor=#d5e8d4;strokeColor=#82b366/);
});

// --- the assembled XML is always linter-clean --------------------------------

test("from_graph: a plain cross-container-edge graph is linter-clean", async () => {
  const graph = {
    nodes: [
      { id: "a", label: "A", group: "g1" },
      { id: "b", label: "B", group: "g2" },
    ],
    groups: [
      { id: "g1", label: "G1" },
      { id: "g2", label: "G2" },
    ],
    edges: [{ from: "a", to: "b", label: "x" }],
  };
  const r = await buildFromGraph(graph, "full");
  const prepared = prepareModel(r.modelXml); // throws on any lint error
  assert.equal(prepared.warnings.length, 0, prepared.warnings.join("\n"));
  // A cross-container edge is parented at the layer sentinel "1".
  const edge = cellsOf(r.modelXml).find((c) => c.edge);
  assert.equal(edge.parent, "1");
});

// --- CRITICAL #1: edge / group caps reject FAST (no layout, no OOM) -----------

test("validateGraph: an over-limit EDGE count is rejected before any layout", () => {
  // 2 nodes, 200000 edges: passes node validation, would OOM graphToElk/runElk.
  const edges = [];
  for (let i = 0; i < 200_000; i++) edges.push({ from: "a", to: "b" });
  const graph = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges };
  const t0 = Date.now();
  assert.throws(
    () => validateGraph(graph),
    (e) => e instanceof GraphValidationError && /200000 edges .*max 1000/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 1000, "must reject in well under a second (no layout)");
});

test("validateGraph: an over-limit GROUP count is rejected fast", () => {
  const groups = [];
  for (let i = 0; i < 600; i++) groups.push({ id: "g" + i, label: "G" });
  const t0 = Date.now();
  assert.throws(
    () => validateGraph({ nodes: [{ id: "a", label: "A" }], groups }),
    (e) => e instanceof GraphValidationError && /600 groups .*max 500/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 1000);
});

test("validateGraph: exactly-at-cap edges/groups are accepted", () => {
  const edges = [];
  for (let i = 0; i < 1000; i++) edges.push({ from: "a", to: "b" });
  assert.doesNotThrow(() =>
    validateGraph({ nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges }),
  );
});

// --- WARNING #3: sameLayerAs spread -> 0 quality-warnings by construction -----

test("from_graph: a sameLayerAs chain of 5 yields 0 quality-warnings (cross-axis spread)", async () => {
  const graph = {
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B", sameLayerAs: "a" },
      { id: "c", label: "C", sameLayerAs: "b" },
      { id: "d", label: "D", sameLayerAs: "c" },
      { id: "e", label: "E", sameLayerAs: "d" },
    ],
    edges: [{ from: "a", to: "b" }],
    direction: "LR",
  };
  const r = await buildFromGraph(graph, "full");
  const cells = parseCells(r.modelXml);
  const warnings = computeQualityWarnings(cells);
  assert.equal(warnings.length, 0, warnings.join("\n"));
  // The four chained dependents share one layer-axis (x) coordinate...
  const by = new Map(cells.map((c) => [c.id, c]));
  const xs = ["b", "c", "d", "e"].map((id) => by.get(id).geometry.x);
  assert.equal(new Set(xs).size, 1, "chained nodes must share the layer axis");
  // ...but are spread on the cross axis (y) with distinct coordinates.
  const ys = ["b", "c", "d", "e"].map((id) => by.get(id).geometry.y);
  assert.equal(new Set(ys).size, 4, "chained nodes must not stack on the cross axis");
});

test("from_graph: pinned coords are honored verbatim; a negative pin is clamped non-negative", async () => {
  const graph = {
    nodes: [
      { id: "p1", label: "P1", pinned: { x: 100, y: 100 } },
      // Two user-pinned nodes at (nearly) the same point: user intent, honored.
      { id: "p2", label: "P2", pinned: { x: -500, y: 100 } }, // out-of-bounds x -> clamped to 0
    ],
    direction: "LR",
  };
  const r = await buildFromGraph(graph, "full");
  const by = new Map(parseCells(r.modelXml).map((c) => [c.id, c]));
  assert.equal(by.get("p1").geometry.x, 100);
  assert.equal(by.get("p1").geometry.y, 100);
  assert.equal(by.get("p2").geometry.x, 0, "negative pin x clamped to 0");
  assert.equal(by.get("p2").geometry.y, 100, "pin y honored");
  // A pinned overlap MAY warn — that's user-directed and documented; we only
  // assert the coords are honored (the guarantee softening), not warning count.
});

// --- WARNING #4: incremental MERGE preserves unlisted existing cells ----------

test("from_graph incremental: an existing cell not in the new graph SURVIVES the add", async () => {
  const existingModelXml =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="manual" value="Hand Placed" style="rounded=1;" vertex="1" parent="1">' +
    '<mxGeometry x="900" y="900" width="120" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="old1" value="Old One" style="rounded=1;" vertex="1" parent="1">' +
    '<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";
  const existingCoords = new Map([
    ["manual", { x: 900, y: 900 }],
    ["old1", { x: 40, y: 40 }],
  ]);
  // The model sends ONLY the re-listed old1 + the new node — NOT "manual".
  const graph = {
    nodes: [
      { id: "old1", label: "Old One" },
      { id: "new1", label: "Added Node" },
    ],
    edges: [{ from: "old1", to: "new1" }],
    direction: "LR",
  };
  const r = await buildFromGraph(graph, "incremental", existingCoords, existingModelXml);
  const by = new Map(parseCells(r.modelXml).map((c) => [c.id, c]));
  // The unlisted hand-placed cell survives, verbatim coords.
  assert.ok(by.has("manual"), "unlisted existing cell must not be dropped");
  assert.equal(by.get("manual").geometry.x, 900);
  assert.equal(by.get("manual").geometry.y, 900);
  // The re-listed existing cell keeps its frozen coords; the new node is added.
  assert.equal(by.get("old1").geometry.x, 40);
  assert.equal(by.get("old1").geometry.y, 40);
  assert.ok(by.has("new1"), "the newly added node is present");
});
