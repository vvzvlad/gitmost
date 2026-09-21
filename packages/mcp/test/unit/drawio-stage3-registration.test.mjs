// Drift guards for the stage-3 drawio tools (issue #425): the three high-level
// tools must be in the shared registry, routed in SERVER_INSTRUCTIONS, expose
// the right schema fields, and carry an `execute` (they call CLIENT methods, so
// unlike drawioShapes/drawioGuide they are NOT inlineBothHosts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_INSTRUCTIONS } from "../../build/index.js";
import { SHARED_TOOL_SPECS } from "../../build/tool-specs.js";

const NEW = ["drawioEditCells", "drawioFromGraph", "drawioFromMermaid"];

test("the three stage-3 tools are in the shared registry (deferred, camelCase)", () => {
  for (const name of NEW) {
    const spec = SHARED_TOOL_SPECS[name];
    assert.ok(spec, `${name} missing from registry`);
    assert.equal(spec.mcpName, name);
    assert.equal(spec.inAppKey, name);
    assert.equal(spec.tier, "deferred");
  }
});

test("the stage-3 tools carry an execute (client-backed, NOT inlineBothHosts)", () => {
  for (const name of NEW) {
    const spec = SHARED_TOOL_SPECS[name];
    assert.equal(typeof spec.execute, "function", `${name} needs an execute`);
    assert.notEqual(spec.inlineBothHosts, true, `${name} must not be inlineBothHosts`);
  }
});

test("the stage-3 tools are routed in SERVER_INSTRUCTIONS", () => {
  for (const name of NEW) {
    assert.match(SERVER_INSTRUCTIONS, new RegExp(`\\b${name}\\b`), `${name} missing from guide`);
  }
});

test("drawioFromGraph exposes graph + direction/preset/layout params", () => {
  const shape = SHARED_TOOL_SPECS.drawioFromGraph.buildShape(makeZodStub());
  for (const key of ["pageId", "graph", "position", "direction", "preset", "layout", "node"]) {
    assert.ok(key in shape, `drawioFromGraph missing ${key}`);
  }
});

test("drawioEditCells exposes operations + baseHash", () => {
  const shape = SHARED_TOOL_SPECS.drawioEditCells.buildShape(makeZodStub());
  for (const key of ["pageId", "node", "operations", "baseHash"]) {
    assert.ok(key in shape, `drawioEditCells missing ${key}`);
  }
});

test("drawioFromMermaid exposes a mermaid param", () => {
  const shape = SHARED_TOOL_SPECS.drawioFromMermaid.buildShape(makeZodStub());
  assert.ok("mermaid" in shape);
});

test("the hard-rules block is injected into edit_cells (raw <mxCell> ops) but NOT from_graph/from_mermaid", () => {
  // edit_cells takes raw <mxCell> xml in add/update ops, so it surfaces the XML
  // rules. from_graph/from_mermaid NEVER expose XML to the model (the whole point
  // is the model never writes a style/coord), so the hard rules would be noise.
  assert.match(SHARED_TOOL_SPECS.drawioEditCells.description, /sentinels are MANDATORY/);
  assert.doesNotMatch(SHARED_TOOL_SPECS.drawioFromGraph.description, /sentinels are MANDATORY/);
  assert.doesNotMatch(SHARED_TOOL_SPECS.drawioFromMermaid.description, /sentinels are MANDATORY/);
});

test("routing prose distinguishes from_graph (architectures) vs from_mermaid (standard)", () => {
  // The EDIT-section routing sentence must mention the semantic tools' intents.
  assert.match(SERVER_INSTRUCTIONS, /drawioFromGraph[\s\S]*architecture|architecture[\s\S]*drawioFromGraph/i);
  assert.match(SERVER_INSTRUCTIONS, /drawioFromMermaid[\s\S]*flowchart|flowchart[\s\S]*drawioFromMermaid/i);
});

// Tiny zod stub (buildShape only calls string/number/enum/array/object +
// chained min/optional/describe — all return `this`; object() returns a chain
// too so nested schemas resolve).
function makeZodStub() {
  const chain = new Proxy(
    {},
    { get: (_t, p) => (p === "parse" ? () => ({}) : () => chain) },
  );
  return {
    string: () => chain,
    number: () => chain,
    enum: () => chain,
    array: () => chain,
    object: () => chain,
  };
}
