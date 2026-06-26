import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { SHARED_TOOL_SPECS } from "../../build/tool-specs.js";

// The shared registry is consumed by BOTH the zod-v3 MCP server and the zod-v4
// in-app AI-SDK service, so every spec must carry the cross-layer wiring
// (mcpName + inAppKey) and its builders must produce the right field set when
// called with a real zod namespace.

test("every spec exposes mcpName + inAppKey, and the key matches inAppKey", () => {
  for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
    assert.equal(typeof spec.mcpName, "string");
    assert.ok(spec.mcpName.length > 0, `${key}: empty mcpName`);
    assert.equal(typeof spec.inAppKey, "string");
    assert.ok(spec.inAppKey.length > 0, `${key}: empty inAppKey`);
    assert.equal(typeof spec.description, "string");
    assert.ok(spec.description.length > 0, `${key}: empty description`);
    // The registry is keyed by inAppKey — keep the two in sync.
    assert.equal(spec.inAppKey, key, `${key}: registry key must equal inAppKey`);
  }
});

test("mcpName uses snake_case and inAppKey uses camelCase", () => {
  for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
    assert.match(spec.mcpName, /^[a-z0-9]+(_[a-z0-9]+)*$/, `${key}: mcpName not snake_case`);
    assert.match(spec.inAppKey, /^[a-z][a-zA-Z0-9]*$/, `${key}: inAppKey not camelCase`);
  }
});

test("mcpName and inAppKey are each unique across the registry", () => {
  const mcpNames = new Set();
  const inAppKeys = new Set();
  for (const spec of Object.values(SHARED_TOOL_SPECS)) {
    assert.ok(!mcpNames.has(spec.mcpName), `duplicate mcpName: ${spec.mcpName}`);
    assert.ok(!inAppKeys.has(spec.inAppKey), `duplicate inAppKey: ${spec.inAppKey}`);
    mcpNames.add(spec.mcpName);
    inAppKeys.add(spec.inAppKey);
  }
});

test("buildShape (when present) returns a usable ZodRawShape with a real zod", () => {
  for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
    if (!spec.buildShape) continue;
    const shape = spec.buildShape(z);
    assert.equal(typeof shape, "object");
    // Each field must be a real zod type so z.object(shape) compiles a schema.
    for (const [field, zt] of Object.entries(shape)) {
      assert.ok(
        zt && typeof zt.parse === "function",
        `${key}.${field}: not a zod type`,
      );
    }
    // The compiled object schema must parse a minimal valid input.
    assert.doesNotThrow(() => z.object(shape));
  }
});

test("editPageText builder produces { pageId, edits } and drops the stale strip-and-retry claim", () => {
  const spec = SHARED_TOOL_SPECS.editPageText;
  assert.equal(spec.mcpName, "edit_page_text");
  const shape = spec.buildShape(z);
  assert.deepEqual(Object.keys(shape).sort(), ["edits", "pageId"]);
  // A valid edits batch parses.
  const schema = z.object(shape);
  const parsed = schema.parse({
    pageId: "p1",
    edits: [{ find: "teh", replace: "the" }],
  });
  assert.equal(parsed.pageId, "p1");
  assert.equal(parsed.edits.length, 1);
  // The canonical description must NOT carry the stale MCP strip-and-retry claim.
  assert.ok(
    !/strip-and-retry/i.test(spec.description),
    "editPageText description still claims strip-and-retry",
  );
  assert.match(spec.description, /REFUSED into\s+failed\[\]/);
});

test("getNode builder produces exactly { pageId, nodeId }", () => {
  const shape = SHARED_TOOL_SPECS.getNode.buildShape(z);
  assert.deepEqual(Object.keys(shape).sort(), ["nodeId", "pageId"]);
});

test("no-arg specs (getWorkspace/listSpaces/listShares) omit buildShape", () => {
  for (const key of ["getWorkspace", "listSpaces", "listShares"]) {
    assert.equal(SHARED_TOOL_SPECS[key].buildShape, undefined, `${key} should be no-arg`);
  }
});
