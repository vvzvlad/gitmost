// Guard: the GENERATED <tool_inventory> in SERVER_INSTRUCTIONS (issue #448)
// names every tool the server registers. The inventory is BUILT from the
// registry (SHARED_TOOL_SPECS' mcpName/catalogLine + INLINE_MCP_INVENTORY), so
// the shared-registry tools can never drift by construction; this test's job is
// to catch the ONE remaining manual list — INLINE_MCP_INVENTORY — falling out
// of sync with the inline `server.registerTool(...)` calls in index.ts.
//
// It also asserts the composed guide keeps its routing prose (the hand-written
// intent hints) and is a valid non-empty string — the structural guarantees the
// old name-scraper test (server-instructions.test.mjs, now deleted) carried,
// minus its now-redundant per-name prose scrape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SERVER_INSTRUCTIONS,
  ROUTING_PROSE,
  buildToolInventoryLines,
  registeredMcpToolNames,
  unregisteredProseToolMentions,
  PROSE_NON_TOOL_TERMS,
} from "../../build/server-instructions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");

/**
 * Every tool name the MCP server registers, scraped from the SOURCE:
 *  - inline `server.registerTool("name", ...)` calls in index.ts;
 *  - shared specs in tool-specs.ts (`mcpName: 'name'`), EXCEPT `inAppOnly`
 *    specs, which the registry loop in index.ts SKIPS on the MCP host (#411).
 * Same two registration mechanisms the old guard covered.
 */
function registeredToolNames() {
  const indexSrc = readFileSync(join(SRC, "index.ts"), "utf8");
  const specsSrc = readFileSync(join(SRC, "tool-specs.ts"), "utf8");
  const names = new Set();
  for (const m of indexSrc.matchAll(/registerTool\(\s*"([a-zA-Z0-9_]+)"/g)) {
    names.add(m[1]);
  }
  // Each spec is one `{ ... }` block; scrape its mcpName but skip a block that
  // carries `inAppOnly: true` (not registered on the external MCP host).
  for (const block of specsSrc.split(/\n\s{2}\w+:\s*\{/)) {
    const nameMatch = block.match(/mcpName:\s*['"]([a-zA-Z0-9_]+)['"]/);
    if (!nameMatch) continue;
    if (/inAppOnly:\s*true/.test(block)) continue;
    names.add(nameMatch[1]);
  }
  return names;
}

test("the generated inventory names every registered tool", () => {
  const registered = registeredToolNames();
  // Sanity: if the scrape regressed (regex drift), fail loudly rather than
  // vacuously passing on an empty set.
  assert.ok(
    registered.size >= 40,
    `sanity: expected 40+ registered tools, got ${registered.size} — ` +
      "the extraction regexes in this test likely drifted from the source",
  );
  const inventory = new Set(buildToolInventoryLines().map((l) => l.name));
  const missing = [...registered].filter((n) => !inventory.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    `tools missing from the generated <tool_inventory>: ${missing.join(", ")} — ` +
      "a SHARED spec is covered automatically; an INLINE MCP-only tool needs a " +
      "line added to INLINE_MCP_INVENTORY in src/server-instructions.ts",
  );
});

test("the inventory has no phantom tool (every line is a real registered tool)", () => {
  const registered = registeredToolNames();
  const phantom = buildToolInventoryLines()
    .map((l) => l.name)
    .filter((n) => !registered.has(n))
    .sort();
  assert.deepEqual(
    phantom,
    [],
    `<tool_inventory> lists tools that are NOT registered: ${phantom.join(", ")}`,
  );
});

// #411: the external MCP surface gains updatePageMarkdown and LOSES
// importPageMarkdown (now inAppOnly). The in-app agent still keeps
// importPageMarkdown — asserted in the server-side contract spec. (#412 renamed
// both public MCP tool names to camelCase.)
test("updatePageMarkdown is on the MCP surface; importPageMarkdown is NOT", () => {
  const inventory = new Set(buildToolInventoryLines().map((l) => l.name));
  assert.ok(
    inventory.has("updatePageMarkdown"),
    "updatePageMarkdown should be registered on the external MCP surface",
  );
  assert.ok(
    !inventory.has("importPageMarkdown"),
    "importPageMarkdown must be dropped from the external MCP surface (#411)",
  );
  // And the routing prose no longer points MCP clients at it.
  assert.ok(
    !ROUTING_PROSE.includes("importPageMarkdown"),
    "ROUTING_PROSE still mentions the removed importPageMarkdown",
  );
  assert.ok(
    ROUTING_PROSE.includes("updatePageMarkdown"),
    "ROUTING_PROSE should mention updatePageMarkdown",
  );
});

test("every inventory line has a non-empty purpose", () => {
  for (const line of buildToolInventoryLines()) {
    assert.equal(typeof line.purpose, "string");
    assert.ok(line.purpose.trim().length > 0, `${line.name}: empty purpose`);
  }
});

test("SERVER_INSTRUCTIONS keeps the routing prose and the generated inventory", () => {
  assert.equal(typeof SERVER_INSTRUCTIONS, "string");
  assert.ok(SERVER_INSTRUCTIONS.length > 0, "SERVER_INSTRUCTIONS is empty");
  // Routing prose is spliced in verbatim (the hand-written intent hints).
  assert.ok(
    SERVER_INSTRUCTIONS.startsWith(ROUTING_PROSE),
    "the routing prose is not preserved at the head of the guide",
  );
  // The generated inventory block is present.
  assert.match(SERVER_INSTRUCTIONS, /<tool_inventory>/);
  assert.match(SERVER_INSTRUCTIONS, /<\/tool_inventory>/);
  // The routing families are still present in the prose.
  for (const family of ["READ:", "EDIT:", "PAGES:", "COMMENTS:", "HISTORY:"]) {
    assert.ok(
      SERVER_INSTRUCTIONS.includes(family),
      `routing prose lost its ${family} section`,
    );
  }
});

// #494 — REVERSE drift-guard: every camelCase tool reference in the routing prose
// must be a tool the MCP host actually registers. The forward direction (every
// registered tool is listed) is guarded by the generated inventory above; this
// closes the reverse, where the prose could previously name a nonexistent/renamed
// tool with nothing reddening.
test("#494: ROUTING_PROSE names no unregistered tool", () => {
  const dangling = unregisteredProseToolMentions();
  assert.deepEqual(
    dangling,
    [],
    `routing prose references unregistered tool(s): ${dangling.join(", ")} — ` +
      `rename/remove the reference, or add a genuine non-tool term to PROSE_NON_TOOL_TERMS`,
  );
});

test("#494: the reverse guard REDDENS on a dead tool reference (mutation check)", () => {
  // A prose that mentions a plausible-looking but nonexistent camelCase tool must
  // be flagged — proving the guard is not vacuous.
  const prose = "EDIT: rewrite a block -> getPageContentz (renamed away).";
  assert.deepEqual(unregisteredProseToolMentions(prose), ["getPageContentz"]);
  // A real registered tool in the same shape is NOT flagged.
  assert.deepEqual(
    unregisteredProseToolMentions("use getPageJson to read the raw tree"),
    [],
  );
});

test("#494: PROSE_NON_TOOL_TERMS holds no actually-registered tool name", () => {
  // A term parked in the allowlist that is really a registered tool would MASK a
  // dead reference to that tool — keep the two disjoint.
  const registered = registeredMcpToolNames();
  for (const term of PROSE_NON_TOOL_TERMS) {
    assert.ok(
      !registered.has(term),
      `${term} is a registered tool and must not be in PROSE_NON_TOOL_TERMS`,
    );
  }
});

// #529: the search routing prose must document the new engine contract — the
// operators, OR/morphology default, pagination fields and the relevance-CAP
// caveat — so an agent uses the operators and understands the unreachable tail.
test("SERVER_INSTRUCTIONS documents the #529 search operators, pagination and CAP", () => {
  const read = ROUTING_PROSE.split("EDIT:")[0]; // the READ family section
  // Operators.
  assert.ok(/\+require/.test(read), "search prose missing +require operator");
  assert.ok(/-exclude/.test(read), "search prose missing -exclude operator");
  assert.ok(/phrase/i.test(read), "search prose missing phrase operator");
  // OR default + morphology.
  assert.ok(/\bOR\b/.test(read), "search prose missing OR-default note");
  assert.ok(/morpholog/i.test(read), "search prose missing morphology note");
  // Pagination + exact permission-filtered total.
  assert.ok(/offset/.test(read), "search prose missing offset/pagination");
  assert.ok(/total is exact/i.test(read), "search prose missing exact total");
  assert.ok(/hasMore|truncatedAtCap/.test(read), "search prose missing hasMore/cap flags");
  // The relevance CAP caveat (tail unreachable by pagination).
  assert.ok(
    /cap/i.test(read) && /unreachable/i.test(read),
    "search prose missing the relevance-CAP unreachable-tail caveat",
  );
});
