import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  SHARED_TOOL_SPECS,
  SHARED_TOOL_WRITE_CLASS,
  isRetryableWriteClass,
  assertEverySpecDeclaresWriteClass,
  assertEverySpecIsRegisterable,
} from "../../build/tool-specs.js";

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

// Since issue #412 the external MCP name equals the in-app key: both are the
// same camelCase identifier (mcpName === inAppKey).
test("mcpName and inAppKey are the same camelCase identifier", () => {
  for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
    assert.match(spec.mcpName, /^[a-z][a-zA-Z0-9]*$/, `${key}: mcpName not camelCase`);
    assert.match(spec.inAppKey, /^[a-z][a-zA-Z0-9]*$/, `${key}: inAppKey not camelCase`);
    assert.equal(spec.mcpName, spec.inAppKey, `${key}: mcpName must equal inAppKey`);
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

// #489 — every spec must declare its write-class so the external-MCP retry path
// can gate a single auto-retry ONLY on a pure read (a blind retry of a write =
// double-apply). The declaration is enforced at registration time.
test("#489: every spec declares a valid writeClass ('readOnly' | 'write')", () => {
  for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
    assert.ok(
      spec.writeClass === "readOnly" || spec.writeClass === "write",
      `${key}: missing/invalid writeClass: ${JSON.stringify(spec.writeClass)}`,
    );
  }
  // The registration-time assert must not throw for the shipped registry.
  assert.doesNotThrow(() => assertEverySpecDeclaresWriteClass());
});

test("#489: SHARED_TOOL_WRITE_CLASS maps every mcpName to its class; helper gates on readOnly", () => {
  const specs = Object.values(SHARED_TOOL_SPECS);
  assert.equal(Object.keys(SHARED_TOOL_WRITE_CLASS).length, specs.length);
  for (const spec of specs) {
    assert.equal(SHARED_TOOL_WRITE_CLASS[spec.mcpName], spec.writeClass);
  }
  // Only a readOnly tool is retry-eligible; a write tool and an unknown tool are not.
  assert.equal(isRetryableWriteClass("readOnly"), true);
  assert.equal(isRetryableWriteClass("write"), false);
  assert.equal(isRetryableWriteClass(undefined), false);
});

test("#489: representative reads are readOnly and representative writes are write", () => {
  for (const name of ["getPage", "getTree", "searchInPage", "listComments"]) {
    assert.equal(SHARED_TOOL_SPECS[name].writeClass, "readOnly", `${name} should be readOnly`);
  }
  for (const name of ["patchNode", "createPage", "deletePage", "createComment", "drawioCreate"]) {
    assert.equal(SHARED_TOOL_SPECS[name].writeClass, "write", `${name} should be write`);
  }
});

// #494 — every non-inline spec MUST carry a callable execute path for each host
// that registers it, or the MCP host throws a call-time TypeError (`execute!`)
// and the in-app host silently drops the tool. A registration-time assert closes
// this mirror. These tests REDDEN if the guard is weakened/removed.
test("#494: assertEverySpecIsRegisterable does not throw for the shipped registry", () => {
  assert.doesNotThrow(() => assertEverySpecIsRegisterable());
  // Sanity: the shipped registry really does satisfy the invariant per-spec.
  for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
    if (spec.inlineBothHosts) continue;
    if (!spec.inAppOnly) {
      assert.ok(
        spec.execute || spec.mcpExecute,
        `${key}: MCP-host spec missing execute/mcpExecute`,
      );
    }
    if (!spec.mcpOnly) {
      assert.ok(
        spec.execute || spec.inAppExecute,
        `${key}: in-app-host spec missing execute/inAppExecute`,
      );
    }
  }
});

test("#494: a non-inline spec with no execute/mcpExecute is rejected (MCP-host arm)", () => {
  // A shared spec (registered on BOTH hosts) with no execute at all.
  const bad = {
    lonely: {
      mcpName: "lonely",
      inAppKey: "lonely",
      writeClass: "readOnly",
      description: "no execute anywhere",
      tier: "core",
      catalogLine: "lonely — nothing",
    },
  };
  assert.throws(
    () => assertEverySpecIsRegisterable(bad),
    /lonely.*neither execute nor mcpExecute/,
  );
});

test("#494: an inAppOnly spec with no execute/inAppExecute is rejected (in-app-host arm)", () => {
  const bad = {
    lonely: {
      mcpName: "lonely",
      inAppKey: "lonely",
      writeClass: "readOnly",
      description: "in-app only, but no runner",
      tier: "core",
      catalogLine: "lonely — nothing",
      inAppOnly: true,
    },
  };
  assert.throws(
    () => assertEverySpecIsRegisterable(bad),
    /lonely.*neither execute nor inAppExecute/,
  );
});

test("#494: an mcpExecute-only spec passes the MCP arm; an inAppExecute-only spec passes the in-app arm", () => {
  // mcpOnly spec with only mcpExecute — the MCP arm is satisfied, the in-app arm
  // is skipped (mcpOnly), so it must NOT throw.
  const mcpOnly = {
    t: {
      mcpName: "t", inAppKey: "t", writeClass: "readOnly",
      description: "x", tier: "core", catalogLine: "t — x",
      mcpOnly: true, mcpExecute: async () => ({}),
    },
  };
  assert.doesNotThrow(() => assertEverySpecIsRegisterable(mcpOnly));
  // inAppOnly spec with only inAppExecute — symmetric.
  const inAppOnly = {
    t: {
      mcpName: "t", inAppKey: "t", writeClass: "readOnly",
      description: "x", tier: "core", catalogLine: "t — x",
      inAppOnly: true, inAppExecute: async () => ({}),
    },
  };
  assert.doesNotThrow(() => assertEverySpecIsRegisterable(inAppOnly));
});

test("#494: an inlineBothHosts spec is exempt from the execute requirement", () => {
  const inline = {
    t: {
      mcpName: "t", inAppKey: "t", writeClass: "readOnly",
      description: "x", tier: "core", catalogLine: "t — x",
      inlineBothHosts: true, // no execute — registered inline by both hosts
    },
  };
  assert.doesNotThrow(() => assertEverySpecIsRegisterable(inline));
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
  assert.equal(spec.mcpName, "editPageText");
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

// #413: getNode gained an optional `format` (markdown default / json opt-in).
test("getNode builder produces { pageId, nodeId, format? } with format optional", () => {
  const spec = SHARED_TOOL_SPECS.getNode;
  const shape = spec.buildShape(z);
  assert.deepEqual(Object.keys(shape).sort(), ["format", "nodeId", "pageId"]);
  const schema = z.object(shape);
  // format is optional (markdown default lives in the client).
  assert.doesNotThrow(() => schema.parse({ pageId: "p1", nodeId: "n1" }));
  assert.doesNotThrow(() =>
    schema.parse({ pageId: "p1", nodeId: "n1", format: "json" }),
  );
  assert.throws(() =>
    schema.parse({ pageId: "p1", nodeId: "n1", format: "yaml" }),
  );
  // The description advertises the markdown default and the json opt-in.
  assert.match(spec.description, /markdown/i);
  assert.match(spec.description, /json/i);
});

// #413: patchNode takes XOR { markdown | node } (both schema-optional).
test("patchNode spec exists, describes markdown+node XOR, builds { pageId, nodeId, markdown?, node? }", () => {
  const spec = SHARED_TOOL_SPECS.patchNode;
  assert.ok(spec, "patchNode spec missing");
  assert.equal(spec.mcpName, "patchNode");
  assert.equal(spec.inAppKey, "patchNode");

  // The canonical description must carry the #413 guidance.
  assert.match(spec.description, /WITHOUT/i);
  assert.match(spec.description, /EXACTLY ONE of `markdown` or `node`/);
  assert.match(spec.description, /RECOMMENDED/);
  assert.match(spec.description, /keeps the same block id/i);
  assert.match(spec.description, /Reversible/i);
  assert.match(spec.description, /page history/i);

  const shape = spec.buildShape(z);
  assert.deepEqual(
    Object.keys(shape).sort(),
    ["markdown", "node", "nodeId", "pageId"],
  );
  // markdown and node are BOTH optional in the schema (XOR enforced at runtime).
  const schema = z.object(shape);
  const parsedMd = schema.parse({ pageId: "p1", nodeId: "n1", markdown: "hi" });
  assert.equal(parsedMd.markdown, "hi");
  const parsedNode = schema.parse({
    pageId: "p1",
    nodeId: "n1",
    node: { type: "paragraph" },
  });
  assert.equal(parsedNode.pageId, "p1");
  // Neither given parses at the schema level (the client throws the XOR error).
  assert.doesNotThrow(() => schema.parse({ pageId: "p1", nodeId: "n1" }));
});

// #413: insertNode also takes XOR { markdown | node } plus the anchor shape.
test("insertNode spec exists, describes markdown+node XOR, builds the full anchor+content shape", () => {
  const spec = SHARED_TOOL_SPECS.insertNode;
  assert.ok(spec, "insertNode spec missing");
  assert.equal(spec.mcpName, "insertNode");
  assert.equal(spec.inAppKey, "insertNode");

  assert.match(spec.description, /EXACTLY ONE of anchorNodeId or anchorText/);
  assert.match(spec.description, /EXACTLY ONE of `markdown` or `node`/);
  assert.match(spec.description, /tableRow/);
  assert.match(spec.description, /append is top-level only/);
  assert.match(spec.description, /Reversible via page history/);

  const shape = spec.buildShape(z);
  assert.deepEqual(
    Object.keys(shape).sort(),
    ["anchorNodeId", "anchorText", "markdown", "node", "pageId", "position"],
  );
  // before/after/append are the only accepted positions; markdown/node/anchors optional.
  const schema = z.object(shape);
  assert.doesNotThrow(() =>
    schema.parse({ pageId: "p1", markdown: "hi", position: "append" }),
  );
  assert.doesNotThrow(() =>
    schema.parse({ pageId: "p1", node: { type: "paragraph" }, position: "append" }),
  );
  assert.throws(() =>
    schema.parse({ pageId: "p1", markdown: "x", position: "sideways" }),
  );
});

// #443: getTree — a space's page hierarchy (or a subtree) in one request.
test("getTree spec exists on both hosts, builds { spaceId, rootPageId?, maxDepth? }", () => {
  const spec = SHARED_TOOL_SPECS.getTree;
  assert.ok(spec, "getTree spec missing");
  assert.equal(spec.mcpName, "getTree");
  assert.equal(spec.inAppKey, "getTree");
  // Shared spec: registered on BOTH hosts.
  assert.notEqual(spec.inAppOnly, true);
  assert.notEqual(spec.mcpOnly, true);

  const shape = spec.buildShape(z);
  assert.deepEqual(Object.keys(shape).sort(), ["maxDepth", "rootPageId", "spaceId"]);
  const schema = z.object(shape);
  // spaceId required; rootPageId + maxDepth optional.
  assert.doesNotThrow(() => schema.parse({ spaceId: "sp1" }));
  assert.throws(() => schema.parse({}));
  assert.doesNotThrow(() =>
    schema.parse({ spaceId: "sp1", rootPageId: "p1", maxDepth: 2 }),
  );
  // maxDepth is an integer >= 1.
  assert.throws(() => schema.parse({ spaceId: "sp1", maxDepth: 0 }));
  assert.throws(() => schema.parse({ spaceId: "sp1", maxDepth: 1.5 }));

  // The description advertises the output node shape, rootPageId, maxDepth, and
  // steers away from the deprecated listPages tree:true.
  assert.match(spec.description, /pageId/);
  assert.match(spec.description, /rootPageId/);
  assert.match(spec.description, /maxDepth/);
  assert.match(spec.description, /hasChildren/);
  assert.match(spec.description, /listPages tree:true/);
});

// #443: getPageContext — a page's breadcrumbs + direct children in one call.
test("getPageContext spec exists on both hosts, builds { pageId }", () => {
  const spec = SHARED_TOOL_SPECS.getPageContext;
  assert.ok(spec, "getPageContext spec missing");
  assert.equal(spec.mcpName, "getPageContext");
  assert.equal(spec.inAppKey, "getPageContext");
  // Shared spec: registered on BOTH hosts.
  assert.notEqual(spec.inAppOnly, true);
  assert.notEqual(spec.mcpOnly, true);

  const shape = spec.buildShape(z);
  assert.deepEqual(Object.keys(shape).sort(), ["pageId"]);
  const schema = z.object(shape);
  // pageId required.
  assert.doesNotThrow(() => schema.parse({ pageId: "p1" }));
  assert.throws(() => schema.parse({}));

  // The description advertises the output shape (page/breadcrumbs/children) and
  // the root-page empty-breadcrumbs contract.
  assert.match(spec.description, /breadcrumbs/);
  assert.match(spec.description, /children/);
  assert.match(spec.description, /hasChildren/);
  assert.match(spec.description, /getTree/);
});

// #443: listPages tree:true is deprecated in favour of getTree.
test("listPages description deprecates tree:true and points at getTree", () => {
  const spec = SHARED_TOOL_SPECS.listPages;
  assert.match(spec.description, /DEPRECATED/i);
  assert.match(spec.description, /getTree/);
});

test("no-arg specs (getWorkspace/listSpaces/listShares) omit buildShape", () => {
  for (const key of ["getWorkspace", "listSpaces", "listShares"]) {
    assert.equal(SHARED_TOOL_SPECS[key].buildShape, undefined, `${key} should be no-arg`);
  }
});

// #411: plain-Markdown full-body replace tool, paired with updatePageJson.
test("updatePageMarkdown spec exists, pairs with updatePageJson, builds { pageId, content, title }", () => {
  const spec = SHARED_TOOL_SPECS.updatePageMarkdown;
  assert.ok(spec, "updatePageMarkdown spec missing");
  assert.equal(spec.mcpName, "updatePageMarkdown");
  assert.equal(spec.inAppKey, "updatePageMarkdown");
  // Registered on BOTH hosts (a shared spec, no inAppOnly/mcpOnly flag).
  assert.notEqual(spec.inAppOnly, true);
  assert.notEqual(spec.mcpOnly, true);
  // Same tier as its JSON sibling.
  assert.equal(spec.tier, SHARED_TOOL_SPECS.updatePageJson.tier);
  const shape = spec.buildShape(z);
  // #647 §H — baseHash is now part of the shape and MANDATORY (content is always
  // written by updatePageMarkdown, so the guarded write always needs a base).
  assert.deepEqual(Object.keys(shape).sort(), ["baseHash", "content", "pageId", "title"]);
  // pageId + content + baseHash required, title optional.
  const schema = z.object(shape);
  assert.doesNotThrow(() =>
    schema.parse({ pageId: "p1", content: "# Hi", baseHash: "h" }),
  );
  assert.throws(() => schema.parse({ pageId: "p1" }));
  // baseHash is mandatory: a write missing it is rejected at the schema.
  assert.throws(() => schema.parse({ pageId: "p1", content: "# Hi" }));
  // The description must flag the `^[...]` inline-footnote parse path so the
  // markdown->footnote canonicalization guarantee stays documented (#411).
  assert.match(spec.description, /\^\[/);
});

// #411: importPageMarkdown is dropped from the EXTERNAL MCP surface but stays
// available to the in-app agent — encoded as inAppOnly on the shared spec.
test("importPageMarkdown spec is inAppOnly (removed from the external MCP surface, kept in-app)", () => {
  const spec = SHARED_TOOL_SPECS.importPageMarkdown;
  assert.ok(spec, "importPageMarkdown spec missing");
  assert.equal(spec.inAppOnly, true);
  // The spec + its client method are NOT deleted — only hidden from the MCP host.
  assert.equal(spec.mcpName, "importPageMarkdown");
  assert.equal(spec.inAppKey, "importPageMarkdown");
});
