import { test } from "node:test";
import assert from "node:assert/strict";

import { markdownToProseMirror } from "../../build/lib/collaboration.js";

/**
 * CROSS-PACKAGE DRIFT GUARD for the footnote id derivation scheme.
 *
 * `deriveFootnoteId` is duplicated in two places that MUST behave identically:
 *   - packages/editor-ext/src/lib/footnote/footnote-util.ts (exported)
 *   - packages/mcp/src/lib/collaboration.ts                  (internal helper)
 * so the same markdown imported through the editor and through the MCP path
 * derives identical footnote ids.
 *
 * The mcp copy is NOT exported from the compiled build (it is an internal helper
 * of collaboration.js), and production source must not be modified to export it.
 * So this test exercises the REAL compiled `deriveFootnoteId` *indirectly*, the
 * same way production does: through `markdownToProseMirror`, which runs
 * extractFootnotes -> deriveFootnoteId during duplicate-id dedup. We craft the
 * `taken` set via literal pre-existing definition ids and read back the derived
 * footnoteDefinition ids.
 *
 * GOLDEN below mirrors DERIVE_GOLDEN in
 *   packages/editor-ext/src/lib/footnote/footnote-util.derive-id.test.ts
 * (asserted there by a DIRECT call). Same (originalId, occurrence, taken) ->
 * same expected id. If the two copies drift, one of the two suites goes red.
 */

/** The 25 single-letter suffixes the scheme uses (n=1..25): b, c, ..., z. */
function singleLetterSuffixes() {
  return Array.from({ length: 25 }, (_, i) => String.fromCharCode(98 + i));
}

// Identical matrix + expected values to the editor-ext golden table.
const GOLDEN = [
  { originalId: "d", occurrence: 2, taken: [], expected: "d__2" },
  { originalId: "d", occurrence: 3, taken: [], expected: "d__3" },
  { originalId: "d", occurrence: 2, taken: ["d__2"], expected: "d__2b" },
  { originalId: "d", occurrence: 2, taken: ["d__2", "d__2b"], expected: "d__2c" },
  {
    originalId: "d",
    occurrence: 2,
    taken: ["d__2", "d__2b", "d__2c", "d__2d"],
    expected: "d__2e",
  },
  {
    originalId: "d",
    occurrence: 2,
    taken: ["d__2", ...singleLetterSuffixes().map((s) => `d__2${s}`)],
    expected: "d__2bb",
  },
];

/** Recursively collect every node of `type`. */
function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) findAll(c, type, acc);
  return acc;
}

/**
 * Build markdown that drives the real `deriveFootnoteId(originalId, occurrence,
 * taken)`:
 *  - `occurrence` duplicate definitions of `[^originalId]` so the dedup walk
 *    reaches the requested occurrence (occurrence=2 -> 1 keeper + 1 duplicate;
 *    occurrence=3 -> keeper + 2 duplicates, of which the LAST is the one whose
 *    id we read);
 *  - one literal pre-existing definition for every id in `taken`, each with its
 *    own reference marker so it is a real (non-orphan) definition. Those ids are
 *    reserved up-front in the dedup `taken` set, exactly forcing the bump.
 *
 * Returns the derived id of the FINAL duplicate of `originalId`.
 */
async function deriveViaMarkdown(originalId, occurrence, takenIds) {
  // References: one [^originalId] per definition (keeper + duplicates) so each
  // duplicate has a marker to pair with, plus one marker per taken id.
  const dupCount = occurrence; // keeper + (occurrence-1) duplicates = `occurrence` defs
  const refMarkers = [];
  for (let i = 0; i < dupCount; i++) refMarkers.push(`[^${originalId}]`);
  for (const id of takenIds) refMarkers.push(`[^${id}]`);
  const refLine = `Body ${refMarkers.join(" ")}.`;

  // Definitions: `occurrence` copies of [^originalId]: ... then the taken ids.
  const defLines = [];
  for (let i = 0; i < dupCount; i++) {
    defLines.push(`[^${originalId}]: copy ${i}`);
  }
  for (const id of takenIds) {
    defLines.push(`[^${id}]: reserved ${id}`);
  }

  const md = [refLine, "", ...defLines].join("\n");
  const json = await markdownToProseMirror(md);
  const defIds = findAll(json, "footnoteDefinition").map((d) => d.attrs.id);

  // The derived id we want is the one that is neither the keeper (originalId),
  // nor any reserved taken id, nor a lower-occurrence derived id. For
  // occurrence=2 that is the single bumped id; for occurrence=3 it is the
  // highest `${originalId}__3...` id. Compute it generically: among the def ids
  // that start with `${originalId}__${occurrence}`, the expected one is present.
  return { defIds, json };
}

for (const row of GOLDEN) {
  test(`parity: derive("${row.originalId}", ${row.occurrence}, {${row.taken.join(",")}}) -> "${row.expected}"`, async () => {
    const { defIds } = await deriveViaMarkdown(
      row.originalId,
      row.occurrence,
      row.taken,
    );
    // The real compiled deriveFootnoteId must have minted exactly the golden id.
    assert.ok(
      defIds.includes(row.expected),
      `expected derived id "${row.expected}" among def ids ${JSON.stringify(defIds)}`,
    );
    // And every id is distinct: nothing collapsed.
    assert.equal(new Set(defIds).size, defIds.length, "all def ids distinct");
  });
}

test("parity: the simple keeper+two-duplicate case mints d, d__2, d__3", async () => {
  // The canonical no-collision path, asserted as a whole set for clarity.
  const md = [
    "See[^d] one[^d] two[^d].",
    "",
    "[^d]: first",
    "[^d]: second",
    "[^d]: third",
  ].join("\n");
  const json = await markdownToProseMirror(md);
  const defIds = findAll(json, "footnoteDefinition").map((d) => d.attrs.id);
  assert.deepEqual([...defIds].sort(), ["d", "d__2", "d__3"]);
});
