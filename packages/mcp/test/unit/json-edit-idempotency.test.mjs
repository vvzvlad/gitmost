import { test } from "node:test";
import assert from "node:assert/strict";

import { applyTextEdits } from "../../build/lib/json-edit.js";

const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const para = (...c) => ({ type: "paragraph", content: c });
const doc = (...c) => ({ type: "doc", content: c });

/** Recursively collect every node of `type`. */
function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) findAll(c, type, acc);
  return acc;
}

// ---------------------------------------------------------------------------
// Idempotency: a second application of an edit whose `find` was consumed by the
// first application is a no-op. It must (a) report the edit as failed/not-found
// and (b) leave the document byte-for-byte identical to the first output — i.e.
// no double-apply, no accidental re-match against the inserted replacement.
// ---------------------------------------------------------------------------
test("re-applying a consumed edit is a no-op: reports not-found AND output is deep-equal to the first apply", () => {
  const d0 = doc(para(t("the quick brown fox")));

  const first = applyTextEdits(d0, [{ find: "quick", replace: "slow" }]);
  // First run applied cleanly.
  assert.equal(first.failed.length, 0, "first apply has no failures");
  assert.deepEqual(
    first.results,
    [{ find: "quick", replacements: 1 }],
    "first apply replaced exactly once",
  );
  assert.equal(
    findAll(first.doc, "text")[0].text,
    "the slow brown fox",
    "first apply produced the replaced text",
  );

  // Second run: `quick` no longer exists; the replacement `slow` must NOT be a
  // new target. Edit goes to failed[], nothing applied.
  const second = applyTextEdits(first.doc, [{ find: "quick", replace: "slow" }]);
  assert.equal(second.results.length, 0, "second apply changes nothing");
  assert.equal(second.failed.length, 1, "second apply records one failure");
  assert.equal(second.failed[0].find, "quick");
  assert.match(second.failed[0].reason, /not found/i, "not-found reason");

  // IDEMPOTENCY: second output deep-equals the first output (no double-apply).
  assert.deepEqual(
    second.doc,
    first.doc,
    "re-running the consumed edit must not mutate the document",
  );
});

test("idempotency holds for replaceAll too: second run is not-found and output is stable", () => {
  const d0 = doc(para(t("ab ab ab")));
  const first = applyTextEdits(d0, [{ find: "ab", replace: "X", replaceAll: true }]);
  assert.deepEqual(first.results, [{ find: "ab", replacements: 3 }]);
  assert.equal(findAll(first.doc, "text")[0].text, "X X X");

  const second = applyTextEdits(first.doc, [{ find: "ab", replace: "X", replaceAll: true }]);
  assert.equal(second.results.length, 0);
  assert.equal(second.failed.length, 1);
  assert.deepEqual(second.doc, first.doc, "replaceAll re-run is idempotent");
});

// ---------------------------------------------------------------------------
// replaceAll across TWO distinct blocks: the same needle living in a callout
// paragraph AND a table cell must be spliced in BOTH, with the replacement
// count summed across every block.
// ---------------------------------------------------------------------------
test("replaceAll splices every block: callout paragraph (2 hits) + table cell (1 hit) = 3", () => {
  const callout = {
    type: "callout",
    attrs: { type: "info" },
    content: [para(t("alpha here and alpha again"))],
  };
  const table = {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [para(t("alpha in a cell"))] },
        ],
      },
    ],
  };
  const d0 = doc(callout, table);

  const r = applyTextEdits(d0, [{ find: "alpha", replace: "ZZ", replaceAll: true }]);

  assert.equal(r.failed.length, 0, "no failures");
  // Count across blocks: 2 in the callout paragraph + 1 in the table cell.
  assert.deepEqual(r.results, [{ find: "alpha", replacements: 3 }]);

  // Callout paragraph: both occurrences replaced.
  const calloutPara = r.doc.content[0].content[0];
  assert.equal(calloutPara.content[0].text, "ZZ here and ZZ again");

  // Table cell (table > tableRow > tableCell > paragraph > text): replaced.
  const cellPara = r.doc.content[1].content[0].content[0].content[0];
  assert.equal(cellPara.content[0].text, "ZZ in a cell");

  // No stray "alpha" survives anywhere in the document.
  const allText = findAll(r.doc, "text").map((n) => n.text).join(" ");
  assert.doesNotMatch(allText, /alpha/, "every occurrence across blocks was spliced");
  // Exactly three "ZZ" insertions overall.
  assert.equal((allText.match(/ZZ/g) || []).length, 3, "three replacements total");
});

test("replaceAll across two blocks preserves surrounding text and ids in each block", () => {
  const callout = {
    type: "callout",
    attrs: { type: "info" },
    content: [{ type: "paragraph", attrs: { id: "p-callout" }, content: [t("keep alpha keep")] }],
  };
  const table = {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          {
            type: "tableCell",
            content: [{ type: "paragraph", attrs: { id: "p-cell" }, content: [t("pre alpha post")] }],
          },
        ],
      },
    ],
  };
  const d0 = doc(callout, table);

  const r = applyTextEdits(d0, [{ find: "alpha", replace: "beta", replaceAll: true }]);
  assert.deepEqual(r.results, [{ find: "alpha", replacements: 2 }]);

  const calloutPara = r.doc.content[0].content[0];
  assert.equal(calloutPara.attrs.id, "p-callout", "block id preserved");
  assert.equal(calloutPara.content[0].text, "keep beta keep");

  const cellPara = r.doc.content[1].content[0].content[0].content[0];
  assert.equal(cellPara.attrs.id, "p-cell", "block id preserved");
  assert.equal(cellPara.content[0].text, "pre beta post");
});
