import { test } from "node:test";
import assert from "node:assert/strict";

import { applyTextEdits } from "../../build/lib/json-edit.js";

// Invisible characters used across the fold tests.
const SHY = "­"; // soft hyphen
const NBSP = " "; // no-break space
const ZWSP = "​"; // zero-width space

// Small ProseMirror doc builders.
const textNode = (text, extra = {}) => ({ type: "text", text, ...extra });
const paragraph = (...children) => ({ type: "paragraph", content: children });
const doc = (...children) => ({ type: "doc", content: children });
const plain = (block) =>
  (block.content || []).map((n) => (typeof n.text === "string" ? n.text : "￼")).join("");

// ── Acceptance criteria ─────────────────────────────────────────────────────

test("B1 (SHY): fold tier localizes, matchedVia=fold, SHY preserved", () => {
  const input = doc(paragraph(textNode("в люд" + SHY + "ях бывает")));
  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "в людях бывает", replace: "в людях случается" },
  ]);
  assert.equal(failed.length, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].matchedVia, "fold");
  assert.equal(results[0].replacements, 1);
  const text = plain(out.content[0]);
  // SHY survives in the UNCHANGED part of the match.
  assert.ok(text.includes("люд" + SHY + "ях"), JSON.stringify(text));
  assert.ok(text.includes("случается"), JSON.stringify(text));
});

test("B2 (NBSP): fold tier localizes a find with a normal space", () => {
  const input = doc(paragraph(textNode("5" + NBSP + "шт на складе")));
  const { results, failed } = applyTextEdits(input, [
    { find: "5 шт", replace: "5 штук" },
  ]);
  assert.equal(failed.length, 0);
  assert.equal(results[0].matchedVia, "fold");
  assert.equal(results[0].replacements, 1);
});

test("criterion 3: exact WINS over fold (no replaceAll, no ambiguity)", () => {
  const input = doc(
    paragraph(textNode("5 шт here")),
    paragraph(textNode("5" + NBSP + "шт there")),
  );
  const { out, results, failed } = (() => {
    const r = applyTextEdits(input, [{ find: "5 шт", replace: "5 pcs" }]);
    return { out: r.doc, results: r.results, failed: r.failed };
  })();
  assert.equal(failed.length, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].matchedVia, "exact");
  assert.equal(results[0].replacements, 1);
  // Only the exact (plain-space) occurrence changed.
  assert.ok(plain(out.content[0]).includes("5 pcs"));
  assert.ok(plain(out.content[1]).includes("5" + NBSP + "шт"));
});

test("criterion 4: replaceAll merges exact ∪ fold — both occurrences replaced", () => {
  const input = doc(
    paragraph(textNode("5 шт here")),
    paragraph(textNode("5" + NBSP + "шт there")),
  );
  const { doc: out, results } = applyTextEdits(input, [
    { find: "5 шт", replace: "5 штук", replaceAll: true },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].replacements, 2);
  assert.equal(results[0].matchedVia, "exact+fold");
  assert.ok(plain(out.content[0]).includes("5 штук"));
  assert.ok(plain(out.content[1]).includes("5" + NBSP + "штук"));
});

test("B4 (markdown+fold): md-strip THEN fold, matchedVia=markdown+fold, bold kept", () => {
  const input = doc(
    paragraph(
      textNode("до "),
      textNode("жир" + SHY + "ный", { marks: [{ type: "bold" }] }),
      textNode(" после"),
    ),
  );
  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "до **жирный** после", replace: "до жирный потом" },
  ]);
  assert.equal(failed.length, 0);
  assert.equal(results[0].matchedVia, "markdown+fold");
  assert.equal(results[0].normalized, true);
  // The bold node keeps its mark and its SHY.
  const boldNode = out.content[0].content.find(
    (n) => (n.marks || []).some((m) => m.type === "bold"),
  );
  assert.ok(boldNode, "bold node preserved");
  assert.ok(boldNode.text.includes(SHY), "SHY preserved in bold node");
});

test("criterion 6a: append at end of block on the FOLD tier", () => {
  const input = doc(paragraph(textNode("wor" + SHY + "ld")));
  const { doc: out, results } = applyTextEdits(input, [
    { find: "world", replace: "world!" },
  ]);
  assert.equal(results[0].matchedVia, "fold");
  const text = plain(out.content[0]);
  assert.ok(text.endsWith("ld!"), JSON.stringify(text));
  assert.ok(text.includes("wor" + SHY + "ld"), "SHY preserved");
});

test("criterion 6b: an invisible right after the match — insert lands BEFORE it", () => {
  const input = doc(paragraph(textNode("5" + NBSP + "шт" + SHY + "ok")));
  const { doc: out, results } = applyTextEdits(input, [
    { find: "5 шт", replace: "5 штX" },
  ]);
  assert.equal(results[0].matchedVia, "fold");
  // X inserted before the trailing SHY: "...штX<SHY>ok".
  assert.ok(plain(out.content[0]).includes("шт" + "X" + SHY + "ok"), JSON.stringify(plain(out.content[0])));
});

test("criterion 6c: find==replace after fold is a no-op (doc unchanged)", () => {
  const input = doc(paragraph(textNode("люд" + SHY + "ях")));
  const snapshot = JSON.parse(JSON.stringify(input));
  const { doc: out, results } = applyTextEdits(input, [
    { find: "людях", replace: "людях" },
  ]);
  assert.equal(results[0].matchedVia, "fold");
  assert.equal(results[0].replacements, 1);
  assert.deepEqual(out, snapshot); // fold no-op preserved the SHY, nothing changed
});

test("criterion 6d: insert at a collapsed-run boundary keeps the WHOLE run", () => {
  const input = doc(paragraph(textNode("a  b"))); // two spaces
  const { doc: out, results } = applyTextEdits(input, [
    { find: "a b", replace: "aX b" },
  ]);
  assert.equal(results[0].matchedVia, "fold");
  // X inserted before the run; both spaces survive: "aX  b".
  assert.equal(plain(out.content[0]), "aX  b");
});

test("criterion 6e: whitespace-only NBSP find on a doc without NBSP → not found", () => {
  const input = doc(paragraph(textNode("hello world")));
  const snapshot = JSON.parse(JSON.stringify(input));
  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: NBSP, replace: "X" },
  ]);
  assert.equal(results.length, 0);
  assert.equal(failed.length, 1);
  assert.deepEqual(out, snapshot); // no mass replacement of spaces
});

test("criterion 8: folded-space diff preserves a neighbour's bold marks", () => {
  const input = doc(
    paragraph(
      textNode("люд" + SHY + "ях "),
      textNode("глубокие", { marks: [{ type: "bold" }] }),
      textNode(" мысли"),
    ),
  );
  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "людях глубокие мысли", replace: "людях глубокие идеи" },
  ]);
  assert.equal(failed.length, 0);
  assert.equal(results[0].matchedVia, "fold");
  const boldNode = out.content[0].content.find(
    (n) => (n.marks || []).some((m) => m.type === "bold"),
  );
  assert.ok(boldNode, "bold node still present");
  assert.equal(boldNode.text, "глубокие");
  assert.ok(plain(out.content[0]).includes("идеи"));
});

test("criterion 15: RAW-diff edits of the invisibles themselves still work", () => {
  // Insert an NBSP via exact tier.
  {
    const input = doc(paragraph(textNode("5 шт на складе")));
    const { doc: out, results } = applyTextEdits(input, [
      { find: "5 шт", replace: "5" + NBSP + "шт" },
    ]);
    assert.equal(results[0].matchedVia, "exact");
    assert.ok(plain(out.content[0]).includes("5" + NBSP + "шт"));
  }
  // Remove a SHY via exact tier (find carries the SHY verbatim).
  {
    const input = doc(paragraph(textNode("люд" + SHY + "ях")));
    const { doc: out, results } = applyTextEdits(input, [
      { find: "люд" + SHY + "ях", replace: "людях" },
    ]);
    assert.equal(results[0].matchedVia, "exact");
    assert.equal(plain(out.content[0]), "людях");
  }
});

// ── F1: off-by-one endSlot on a collapsed multi-char run (#658) ──────────────

test("F1: replaceAll over a two-NBSP run consumes the WHOLE run", () => {
  // Two NBSPs collapse to one folded space; exact misses (no plain space), the
  // fold tier matches. The old endSlot (map[last]+1) landed on the SECOND NBSP,
  // leaving it behind ("X<NBSP>b") while still reporting 1.
  const input = doc(paragraph(textNode("a" + NBSP + NBSP + "b")));
  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "a ", replace: "X", replaceAll: true },
  ]);
  assert.equal(failed.length, 0);
  assert.equal(results[0].matchedVia, "fold");
  assert.equal(results[0].replacements, 1);
  assert.equal(plain(out.content[0]), "Xb");
});

test("F1 control: single-NBSP run is fully consumed too", () => {
  const input = doc(paragraph(textNode("a" + NBSP + "b")));
  const { doc: out, results } = applyTextEdits(input, [
    { find: "a ", replace: "X", replaceAll: true },
  ]);
  assert.equal(results[0].matchedVia, "fold");
  assert.equal(results[0].replacements, 1);
  assert.equal(plain(out.content[0]), "Xb");
});

test("F1: an atom right after the collapsed run stays put (boundary is exclusive)", () => {
  // A real atom cannot sit STRICTLY inside a fold-space run (an atom breaks the
  // run), so the atom-scan's run-tail coverage is exercised at the boundary: the
  // whole run is consumed and the trailing atom (hardBreak) is preserved — no
  // wrong splice reaches past the run into the atom.
  const input = doc(
    paragraph(textNode("a" + NBSP + NBSP), { type: "hardBreak" }, textNode("b")),
  );
  const { doc: out, results } = applyTextEdits(input, [
    { find: "a ", replace: "X", replaceAll: true },
  ]);
  assert.equal(results[0].matchedVia, "fold");
  assert.equal(results[0].replacements, 1);
  // Run gone, atom (￼) preserved: "X￼b".
  assert.equal(plain(out.content[0]), "X￼b");
});

// ── F2: a fold-sensitive invisible in `replace` suppresses the fold tier (#658)

test("F2: replace's SHY cannot be applied through fold → honest miss, doc unchanged", () => {
  // Doc carries a ZWSP so exact misses; the fold tier WOULD localize, but the
  // replace's only difference (a SHY) folds away, so applying via fold would be a
  // silent no-op reported as 1. Fold is suppressed → honest replacements:0.
  const input = doc(paragraph(textNode("лю" + ZWSP + "дях")));
  const snapshot = JSON.parse(JSON.stringify(input));
  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "людях", replace: "лю" + SHY + "дях" },
  ]);
  assert.equal(results.length, 0);
  assert.equal(failed.length, 1);
  assert.deepEqual(out, snapshot);
});

test("F2 positive control: a RAW match still applies the SHY via the exact tier", () => {
  const input = doc(paragraph(textNode("людях")));
  const { doc: out, results } = applyTextEdits(input, [
    { find: "людях", replace: "лю" + SHY + "дях" },
  ]);
  assert.equal(results[0].matchedVia, "exact");
  assert.equal(results[0].replacements, 1);
  assert.equal(plain(out.content[0]), "лю" + SHY + "дях");
});

// ── §2 merge-selection counterexamples (criterion 17) ────────────────────────

test("counterexample x␣␣a / ␣a: one splice, exact preferred", () => {
  const input = doc(paragraph(textNode("x  a"))); // two spaces
  const { doc: out, results } = applyTextEdits(input, [
    { find: " a", replace: " A", replaceAll: true },
  ]);
  assert.equal(results[0].replacements, 1);
  assert.equal(results[0].matchedVia, "exact");
  assert.equal(plain(out.content[0]), "x  A");
});

test("counterexample NBSP intersection a·a a / a a: exact wins, one splice", () => {
  const input = doc(paragraph(textNode("a" + NBSP + "a a")));
  const { doc: out, results } = applyTextEdits(input, [
    { find: "a a", replace: "a-a", replaceAll: true },
  ]);
  assert.equal(results[0].replacements, 1);
  assert.equal(results[0].matchedVia, "exact");
  // Only the plain-space occurrence changed; the NBSP one is untouched.
  assert.equal(plain(out.content[0]), "a" + NBSP + "a-a");
});

test("counterexample ZWSP intersection a‌ a a / a a: fold cand dropped on overlap", () => {
  const input = doc(paragraph(textNode("a" + ZWSP + " a a")));
  const { doc: out, results } = applyTextEdits(input, [
    { find: "a a", replace: "a-a", replaceAll: true },
  ]);
  assert.equal(results[0].replacements, 1);
  assert.equal(results[0].matchedVia, "exact");
  assert.equal(plain(out.content[0]), "a" + ZWSP + " a-a");
});

// ── Miss diagnostics ─────────────────────────────────────────────────────────

test("criterion 9: find crossing two paragraphs → block-boundary reason with top indices", () => {
  const input = doc(
    paragraph(textNode("first line")),
    paragraph(textNode("second line")),
  );
  const { results, failed } = applyTextEdits(input, [
    { find: "first line second", replace: "x" },
  ]);
  assert.equal(results.length, 0);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /block boundaries #0-#1/);
});

test("criterion 7 / B3: find crossing a hardBreak → non-text-inline-node reason", () => {
  const input = doc(
    paragraph(textNode("first line"), { type: "hardBreak" }, textNode("second line")),
  );
  const { failed } = applyTextEdits(input, [
    { find: "first line second line", replace: "x" },
  ]);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /non-text inline node/);
  assert.match(failed[0].reason, /line break/);
  // No real id on this paragraph → no patchNode suggested.
  assert.doesNotMatch(failed[0].reason, /patchNode/);
});

test("B3 variant: a space before the hardBreak still diagnoses the break", () => {
  const input = doc(
    paragraph(textNode("first line "), { type: "hardBreak" }, textNode("second")),
  );
  const { failed } = applyTextEdits(input, [
    { find: "first line second", replace: "x" },
  ]);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /non-text inline node/);
});

test("atom reason offers patchNode ONLY with a real attrs.id (never #idx)", () => {
  const input = doc({
    type: "paragraph",
    attrs: { id: "para-XYZ" },
    content: [textNode("first line"), { type: "hardBreak" }, textNode("second line")],
  });
  const { failed } = applyTextEdits(input, [
    { find: "first line second line", replace: "x" },
  ]);
  assert.match(failed[0].reason, /patchNode para-XYZ/);
  assert.doesNotMatch(failed[0].reason, /patchNode #/);
});

test("criterion 10: typography-only diff → diagnosis quoting escaped invisibles", () => {
  const input = doc(paragraph(textNode("«при" + SHY + "вет»")));
  const { results, failed } = applyTextEdits(input, [
    { find: '"привет"', replace: '"hi"' },
  ]);
  assert.equal(results.length, 0, "typography fold is NOT auto-applied");
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /typograph/);
  assert.match(failed[0].reason, /⟨SHY⟩/);
});
