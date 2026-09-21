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
  assert.match(failed[0].reason, /patchNode/);
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
// (iv) #410 footnote token: a `replace` containing `^[...]` is refused into
// failed[] (it would be written as a LITERAL string, never a real footnote).
// Nothing is applied; the reason points at insertFootnote.
// ---------------------------------------------------------------------------
test("replace containing a `^[...]` footnote token is refused, not applied", () => {
  const input = doc(paragraph(textNode("The claim stands.")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "The claim stands.", replace: "The claim stands.^[See source, p.42]" },
  ]);

  assert.equal(results.length, 0, "nothing applied");
  assert.equal(failed.length, 1, "one refused edit");
  assert.equal(failed[0].find, "The claim stands.");
  assert.match(failed[0].reason, /insertFootnote/);
  // The document is byte-for-byte untouched — no literal `^[` was written.
  assert.deepEqual(out, snapshot);
});

test("a plain replace with no footnote token still applies (no false positive)", () => {
  const input = doc(paragraph(textNode("a caret ^ and a bracket ] apart")));
  const { results, failed } = applyTextEdits(input, [
    { find: "apart", replace: "separate" },
  ]);
  assert.equal(failed.length, 0, "not refused");
  assert.equal(results.length, 1, "applied");
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
  assert.deepEqual(results, [{ find: "teh", replacements: 1, matchedVia: "exact" }]);
});

// ===========================================================================
// #657 — markers in `replace` (the MIXED-edit corruption class) and the
// literal-marker exception. Bold-marked text helper.
// ===========================================================================
const bold = (text) => textNode(text, { marks: [{ type: "bold" }] });

// (657-a) THE REPRO. A MIXED edit: text change PLUS markdown markers in
// `replace`, over real bold text. `find` is located via the markdown-strip
// fallback (the `**` are not literally in the doc). The old code only refused a
// PURE toggle, so this passed and wrote literal `**жирнейший**` into the page.
// It must now be REFUSED into failed[]; nothing applied, doc untouched.
test("#657 mixed edit (text change + markers in replace) is refused, not applied", () => {
  const input = doc(paragraph(textNode("до "), bold("жирный"), textNode(" после")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "до **жирный** после", replace: "до **жирнейший** после" },
  ]);

  assert.equal(results.length, 0, "nothing applied");
  assert.equal(failed.length, 1, "one refused edit");
  assert.equal(failed[0].find, "до **жирный** после");
  // find matched after markdown-strip: the reason says the markers are NOT in
  // the document and points at patchNode.
  assert.match(failed[0].reason, /literal/i);
  assert.match(failed[0].reason, /patchNode/);
  // No literal `**` was written; the bold mark and text are untouched.
  assert.deepEqual(out, snapshot);
});

// (657-b) THE LITERAL-EXCEPTION. A page that literally contains `**bold**` in
// its PLAIN text (a markdown-docs example, or garbage left by the very bug
// above). A cleanup edit find:"**bold**"/replace:"bold" matches VERBATIM and
// `find` carries the literal marker-pairs -> the exception holds -> it APPLIES
// as ordinary text, AND carries the self-correcting warning.
test("#657 literal-marker cleanup applies verbatim with a warning", () => {
  const input = doc(paragraph(textNode("see **bold** here")));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "**bold**", replace: "bold" },
  ]);

  assert.equal(failed.length, 0, "not refused");
  assert.equal(results.length, 1, "applied");
  assert.equal(results[0].replacements, 1);
  assert.equal(results[0].normalized, undefined, "matched verbatim, not stripped");
  // The literal asterisks are gone from the text.
  assert.equal(out.content[0].content[0].text, "see bold here");
  // A toggle-via-literal-exception carries the wrong-target warning.
  assert.match(results[0].warning, /LITERAL markers found verbatim/);
  assert.match(results[0].warning, /patchNode/);
});

// (657-c) Single-marker ADD is still refused (the exception must NOT revive the
// original bug). find:"жирный"/replace:"*жирный*" matches verbatim, but `find`
// has NO marker-pairs (single `*` is deliberately undetected), so the exception
// does NOT hold and the symmetric formattingOnly toggle refuses it.
test("#657 single-marker add (жирный -> *жирный*) is still refused", () => {
  const input = doc(paragraph(textNode("жирный")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "жирный", replace: "*жирный*" },
  ]);

  assert.equal(results.length, 0, "nothing applied");
  assert.equal(failed.length, 1, "one refused edit");
  assert.match(failed[0].reason, /cannot add or remove formatting marks/);
  assert.match(failed[0].reason, /patchNode/);
  assert.ok(!/updatePageJson/.test(failed[0].reason), "no updatePageJson in the reason");
  assert.deepEqual(out, snapshot);
});

// (657-d) A `[link](url)` in `replace` (plain find, no marker-pairs) is refused:
// it would be written as literal visible text. Verbatim-tier reason.
test("#657 a [link](url) in replace is refused", () => {
  const input = doc(paragraph(textNode("click here")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "click here", replace: "see [link](https://x.dev)" },
  ]);

  assert.equal(results.length, 0, "nothing applied");
  assert.equal(failed.length, 1, "one refused edit");
  assert.match(failed[0].reason, /literal/i);
  assert.match(failed[0].reason, /patchNode/);
  assert.deepEqual(out, snapshot);
});

// (657-e) A dunder `__init__` in `replace` is refused (ACCEPTED false positive)
// with the content hatch pointing at patchNode-with-node-JSON.
test("#657 __init__ in replace is refused with a content hatch", () => {
  const input = doc(paragraph(textNode("the function")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "the function", replace: "def __init__ here" },
  ]);

  assert.equal(results.length, 0, "nothing applied");
  assert.equal(failed.length, 1, "one refused edit");
  assert.match(failed[0].reason, /__init__/);
  assert.match(failed[0].reason, /patchNode with node JSON/);
  assert.deepEqual(out, snapshot);
});

// (657-f) A plain replace with NO markers still applies (no false positive), and
// fail-closed batching: a refused edit lands in failed[] while a sibling plain
// edit still applies and splices.
test("#657 plain replace still applies; refused sibling does not block it", () => {
  const input = doc(paragraph(textNode("teh cat runs")));
  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "teh", replace: "the" },
    { find: "cat", replace: "**cat**" }, // markers in replace -> refused
  ]);
  assert.equal(results.length, 1, "the plain edit applied");
  assert.equal(results[0].find, "teh");
  assert.equal(failed.length, 1, "the marker edit refused");
  assert.equal(failed[0].find, "cat");
  // The plain fix landed; no literal `**` was written.
  assert.equal(out.content[0].content[0].text, "the cat runs");
});

// (657-g) A formatting TOGGLE whose find matched NOTHING now returns not-found +
// diagnostics (honest — the text isn't there), NOT the format advice.
test("#657 a toggle whose find matched nothing returns not-found, not format advice", () => {
  const input = doc(paragraph(textNode("unrelated text")));
  const { results, failed } = applyTextEdits(input, [
    { find: "~~missing~~", replace: "missing" },
  ]);
  assert.equal(results.length, 0);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /not found/i);
  assert.ok(
    !/cannot add or remove formatting marks/.test(failed[0].reason),
    "not-found, not the format toggle advice",
  );
});

// (657-h) The marker detector must be LINEAR: an agent-supplied replace of a long
// unmatched-`[` run must not block the event loop (the old link regex was O(n^2),
// ~28s on 200k). A real `[a](b)` link in replace is still refused; a huge bare
// `[` run carries no real link so the edit applies (nothing to refuse).
test("#657 the marker detector stays linear on a pathological `[` run", () => {
  const input = doc(paragraph(textNode("keep this text here")));
  const t0 = Date.now();
  const { results, failed } = applyTextEdits(input, [
    { find: "keep this text here", replace: "x " + "[".repeat(200000) },
  ]);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `detector must be linear, took ${elapsed}ms`);
  // A bare `[` run is not a link → no marker refusal → the edit applies.
  assert.equal(failed.length, 0);
  assert.equal(results.length, 1);
});

// (657-i) A real link in replace is still refused (parity with the old regex).
test("#657 a real [text](url) link in replace is still refused", () => {
  const input = doc(paragraph(textNode("see the docs")));
  const { results, failed } = applyTextEdits(input, [
    { find: "see the docs", replace: "see [the docs](https://x.com)" },
  ]);
  assert.equal(results.length, 0);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /literal|patchNode/i);
});
