// Drift guards for the stage-2 drawio tools (issue #424): the new tools must be
// wired into the shared registry AND routed in SERVER_INSTRUCTIONS, and the
// hard-rules block must be injected into the create/update descriptions. These
// complement the generic server-instructions.test.mjs / tool-specs.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_INSTRUCTIONS } from "../../build/index.js";
import { SHARED_TOOL_SPECS } from "../../build/tool-specs.js";

test("drawioShapes and drawioGuide are in the shared registry", () => {
  assert.equal(SHARED_TOOL_SPECS.drawioShapes.mcpName, "drawioShapes");
  assert.equal(SHARED_TOOL_SPECS.drawioGuide.mcpName, "drawioGuide");
  // Deferred tier, matching the stage-1 drawio tools.
  assert.equal(SHARED_TOOL_SPECS.drawioShapes.tier, "deferred");
  assert.equal(SHARED_TOOL_SPECS.drawioGuide.tier, "deferred");
});

test("the new tools are routed in SERVER_INSTRUCTIONS", () => {
  for (const name of ["drawioShapes", "drawioGuide"]) {
    assert.match(SERVER_INSTRUCTIONS, new RegExp(`\\b${name}\\b`), `${name} missing from guide`);
  }
});

test("the hard-rules block is injected into create/update descriptions", () => {
  for (const key of ["drawioCreate", "drawioUpdate"]) {
    const d = SHARED_TOOL_SPECS[key].description;
    assert.match(d, /sentinels are MANDATORY/);
    assert.match(d, /vertex="1" XOR edge="1"/);
    assert.match(d, /call drawioShapes first/);
    assert.match(d, /adaptiveColors="auto"/);
    assert.match(d, /&#xa;/);
  }
});

test("create/update expose the layout:\"elk\" parameter", () => {
  const { z } = { z: makeZodStub() };
  for (const key of ["drawioCreate", "drawioUpdate"]) {
    const shape = SHARED_TOOL_SPECS[key].buildShape(z);
    assert.ok("layout" in shape, `${key} missing layout param`);
  }
});

// Tiny zod stub: buildShape only calls z.string/enum/number + chained
// .min/.optional/.describe, all of which return `this`.
function makeZodStub() {
  const chain = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "parse") return () => ({});
        return () => chain;
      },
    },
  );
  return {
    string: () => chain,
    number: () => chain,
    enum: () => chain,
    array: () => chain,
    object: () => chain,
  };
}
