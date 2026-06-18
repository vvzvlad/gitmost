import { test } from "node:test";
import assert from "node:assert/strict";

import { applyTextEdits } from "../../build/lib/json-edit.js";

// Helpers to build small ProseMirror docs.
const textNode = (text, extra = {}) => ({ type: "text", text, ...extra });
const paragraph = (...children) => ({ type: "paragraph", content: children });
const doc = (...children) => ({ type: "doc", content: children });

// ---------------------------------------------------------------------------
// (i) formattingOnly: find and replace differ ONLY by markdown markers
// (find:"~~x~~" / replace:"x"). The text "x" exists, but the edit is a pure
// formatting toggle -> refused into failed[], nothing applied.
// ---------------------------------------------------------------------------
test("formatting-only edit (strip-toggle) is refused, not applied", () => {
  const input = doc(paragraph(textNode("x", { marks: [{ type: "strike" }] })));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "~~x~~", replace: "x" },
  ]);

  assert.equal(results.length, 0, "nothing applied");
  assert.equal(failed.length, 1, "one refused edit");
  assert.equal(failed[0].find, "~~x~~");
  assert.match(failed[0].reason, /cannot add or remove formatting marks/);
  assert.match(failed[0].reason, /patch_node/);
  // The document is untouched (the strike mark is preserved).
  assert.deepEqual(out, snapshot);
});

// ---------------------------------------------------------------------------
// (ii) formattingOnly via add-bold: a plain `find:"x"` whose `replace:"**x**"`
// only adds balanced markers. stripBalancedWrappers(replace) == find, find !=
// replace -> formattingOnly -> refused (it would write a LITERAL `**x**`).
// ---------------------------------------------------------------------------
test("edit that only adds bold markers around plain text is refused", () => {
  const input = doc(paragraph(textNode("x")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "x", replace: "**x**" },
  ]);

  assert.equal(results.length, 0, "nothing applied");
  assert.equal(failed.length, 1, "one refused edit");
  assert.match(failed[0].reason, /cannot add or remove formatting marks/);
  // No literal ** was written into the document.
  assert.deepEqual(out, snapshot);
});

// ---------------------------------------------------------------------------
// (ii-b) More real formatting toggles are still caught by stripBalancedWrappers.
// ---------------------------------------------------------------------------
test("strike-toggle on a price is refused", () => {
  const input = doc(paragraph(textNode("$69", { marks: [{ type: "strike" }] })));
  const snapshot = JSON.parse(JSON.stringify(input));
  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "~~$69~~", replace: "$69" },
  ]);
  assert.equal(results.length, 0, "nothing applied");
  assert.equal(failed.length, 1, "one refused edit");
  assert.match(failed[0].reason, /cannot add or remove formatting marks/);
  assert.deepEqual(out, snapshot);
});

test("nested-wrapper toggle (~~~~**M5Stack**~~~~ -> **M5Stack**) is refused", () => {
  const input = doc(
    paragraph(textNode("M5Stack", { marks: [{ type: "bold" }] })),
  );
  const snapshot = JSON.parse(JSON.stringify(input));
  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "~~~~**M5Stack**~~~~", replace: "**M5Stack**" },
  ]);
  assert.equal(results.length, 0, "nothing applied");
  assert.equal(failed.length, 1, "one refused edit");
  assert.match(failed[0].reason, /cannot add or remove formatting marks/);
  assert.deepEqual(out, snapshot);
});

// ---------------------------------------------------------------------------
// (ii-c) REGRESSION: ordinary plain-text edits that the OLD lenient detector
// wrongly refused (false positives) now APPLY — they land in `results`, never
// in `failed`. Each `find` exists verbatim in the built doc.
// ---------------------------------------------------------------------------
test("plain-text edits formerly mis-flagged as formatting now apply", () => {
  const cases = [
    // trailing-space trim: lenient strip trimmed the space -> equal -> refused.
    { find: "tail ", replace: "tail", before: "head tail more" },
    // snake_case: `_case_` looked like `_x_` emphasis to the lenient detector.
    { find: "oldname", replace: "snake_case_name", before: "the oldname here" },
    // math: `* 3 *` looked like `*x*` emphasis.
    { find: "X", replace: "2 * 3 * 4", before: "value X end" },
    // identifier with underscores.
    { find: "A", replace: "my_var_name", before: "set A now" },
  ];

  for (const c of cases) {
    const input = doc(paragraph(textNode(c.before)));
    const { results, failed } = applyTextEdits(input, [
      { find: c.find, replace: c.replace },
    ]);
    assert.equal(
      failed.length,
      0,
      `"${c.find}" -> "${c.replace}" must NOT be refused (got: ${JSON.stringify(failed)})`,
    );
    assert.equal(results.length, 1, `"${c.find}" must apply once`);
    assert.equal(results[0].find, c.find);
    assert.equal(results[0].replacements, 1);
  }
});

// ---------------------------------------------------------------------------
// (iii) Legit typo fix: find has markdown but replace differs in LETTERS and
// has no markers. stripped find != stripped replace AND replace has no markers
// -> neither flag trips -> the edit applies.
// ---------------------------------------------------------------------------
test("typo fix wrapped in markdown still applies (not refused)", () => {
  // The document renders "M5Stack Atom Eco" with that span bold (misspelled).
  const input = doc(
    paragraph(textNode("M5Stack Atom Eco", { marks: [{ type: "bold" }] })),
  );

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "**M5Stack Atom Eco**", replace: "M5Stack Atom Echo" },
  ]);

  assert.equal(failed.length, 0, "not refused");
  assert.equal(results.length, 1, "applied");
  assert.equal(results[0].find, "**M5Stack Atom Eco**");
  assert.equal(results[0].replacements, 1);
  // It matched via the markdown-strip fallback.
  assert.equal(results[0].normalized, true);
  // The fix is applied AND the bold mark is preserved (text edit, not a
  // formatting change).
  const node = out.content[0].content.find((n) => n.text === "M5Stack Atom Echo");
  assert.ok(node, "the corrected text node exists");
  assert.deepEqual(node.marks, [{ type: "bold" }]);
});

// ---------------------------------------------------------------------------
// A plain text fix is unaffected by the refuse logic.
// ---------------------------------------------------------------------------
test("plain find/replace is not refused", () => {
  const input = doc(paragraph(textNode("teh cat")));
  const { results, failed } = applyTextEdits(input, [
    { find: "teh", replace: "the" },
  ]);
  assert.equal(failed.length, 0);
  assert.deepEqual(results, [{ find: "teh", replacements: 1 }]);
});
