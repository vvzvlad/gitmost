// Unit tests for the Mermaid flowchart -> graph parser (issue #425, acceptance
// #6, OPTIONAL). Verifies a flowchart with a branch + a subgraph parses to a
// graph the from_graph pipeline renders as valid, editable drawio, and that a
// non-flowchart diagram is rejected with a clear error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mermaidToGraph, MermaidParseError } from "../../build/lib/drawio-mermaid.js";
import { buildFromGraph } from "../../build/lib/drawio-graph.js";
import { prepareModel } from "../../build/lib/drawio-xml.js";

test("flowchart with a branch + subgraph -> a valid, editable drawio", async () => {
  const mm = `flowchart LR
    A[Start] --> B{Decision}
    B -->|yes| C[(Database)]
    B -->|no| D[End]
    subgraph backend [Backend Services]
      C
      E([Cache])
    end
    D -.-> E`;
  const graph = mermaidToGraph(mm);

  // Direction + nodes + a group + labelled/dashed edges parsed.
  assert.equal(graph.direction, "LR");
  const nodeIds = graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(nodeIds, ["A", "B", "C", "D", "E"]);
  // The decision `{}` maps to the queue palette; the `[(db)]` to db.
  assert.equal(graph.nodes.find((n) => n.id === "B").kind, "queue");
  assert.equal(graph.nodes.find((n) => n.id === "C").kind, "db");
  // The subgraph became a group and claimed its members.
  assert.equal(graph.groups.length, 1);
  assert.equal(graph.groups[0].id, "backend");
  assert.equal(graph.nodes.find((n) => n.id === "C").group, "backend");
  assert.equal(graph.nodes.find((n) => n.id === "E").group, "backend");
  // A pipe label and a dotted (async) edge.
  const yes = graph.edges.find((e) => e.from === "B" && e.to === "C");
  assert.equal(yes.label, "yes");
  const dotted = graph.edges.find((e) => e.from === "D" && e.to === "E");
  assert.equal(dotted.kind, "async");

  // The whole thing renders linter-clean.
  const built = await buildFromGraph(graph, "full");
  const prepared = prepareModel(built.modelXml);
  assert.equal(prepared.warnings.length, 0, prepared.warnings.join("\n"));
});

test("graph TD header sets a top-down direction", () => {
  const g = mermaidToGraph("graph TD\n X --> Y");
  assert.equal(g.direction, "TB");
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["X", "Y"]);
});

test("a chained connection A --> B --> C yields two edges", () => {
  const g = mermaidToGraph("flowchart LR\n A[a] --> B[b] --> C[c]");
  const pairs = g.edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(pairs, ["A->B", "B->C"]);
});

test("a non-flowchart diagram is rejected with a clear error", () => {
  assert.throws(
    () => mermaidToGraph("sequenceDiagram\n Alice->>Bob: Hi"),
    /only 'flowchart'\/'graph' is supported/,
  );
  assert.throws(() => mermaidToGraph(""), MermaidParseError);
});

// --- CRITICAL #2 / NIT: input-size bounds reject FAST (no OOM) ----------------

test("mermaidToGraph: an over-length input is rejected before parsing (fast)", () => {
  const huge = "flowchart LR\n" + "A-->B\n".repeat(60_000); // ~360 KB > 200 KB cap
  const t0 = Date.now();
  assert.throws(
    () => mermaidToGraph(huge),
    (e) => e instanceof MermaidParseError && /max 200000/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 1000, "must reject in well under a second (no parse)");
});

test("mermaidToGraph: an over-line-count input is rejected fast", () => {
  const many = "flowchart LR\n" + "A\n".repeat(25_000); // > 20000 line cap
  const t0 = Date.now();
  assert.throws(
    () => mermaidToGraph(many),
    (e) => e instanceof MermaidParseError && /max 20000/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 1000);
});

test("mermaidToGraph: too many subgraphs is rejected", () => {
  let src = "flowchart LR\n";
  for (let i = 0; i < 600; i++) src += `subgraph s${i}\nend\n`;
  assert.throws(
    () => mermaidToGraph(src),
    (e) => e instanceof MermaidParseError && /too many subgraphs .*max 500/.test(e.message),
  );
});

test("mermaidToGraph: an over-long connection chain throws (NON-silent truncation)", () => {
  const chain =
    "flowchart LR\n" +
    Array.from({ length: 600 }, (_, i) => "N" + i).join("-->");
  assert.throws(
    () => mermaidToGraph(chain),
    (e) => e instanceof MermaidParseError && /chain exceeds 500 nodes/.test(e.message),
  );
});

test("mermaidToGraph: a chain of 60 nodes parses (no silent 50-node truncation)", () => {
  const chain =
    "flowchart LR\n" +
    Array.from({ length: 60 }, (_, i) => "N" + i).join("-->");
  const g = mermaidToGraph(chain);
  assert.equal(g.nodes.length, 60, "all 60 chained nodes are kept");
});
