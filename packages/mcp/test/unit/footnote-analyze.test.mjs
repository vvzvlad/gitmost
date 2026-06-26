import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeFootnotes } from "../../build/lib/footnote-analyze.js";

test("clean footnotes produce no diagnostics", () => {
  const md = ["A[^a] and B[^b].", "", "[^a]: first", "[^b]: second"].join("\n");
  const d = analyzeFootnotes(md);
  assert.deepEqual(d.danglingReferences, []);
  assert.deepEqual(d.emptyDefinitions, []);
  assert.deepEqual(d.duplicateDefinitions, []);
  assert.deepEqual(d.referencesInTables, []);
  assert.deepEqual(d.warnings, []);
});

test("reuse (repeated references to one definition) is NOT a warning", () => {
  const md = ["A[^a] B[^a] C[^a].", "", "[^a]: shared"].join("\n");
  const d = analyzeFootnotes(md);
  assert.deepEqual(d.danglingReferences, []);
  assert.deepEqual(d.warnings, []);
});

test("dangling reference (no definition) is reported", () => {
  const md = ["See[^missing] and[^a].", "", "[^a]: defined"].join("\n");
  const d = analyzeFootnotes(md);
  assert.deepEqual(d.danglingReferences, ["missing"]);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /no matching definition/);
  assert.match(d.warnings[0], /\[\^missing\]/);
});

test("empty definition text is reported", () => {
  const md = ["See[^a].", "", "[^a]:   "].join("\n");
  const d = analyzeFootnotes(md);
  assert.deepEqual(d.emptyDefinitions, ["a"]);
  assert.match(d.warnings.join("\n"), /empty text/);
});

test("duplicate definition id is reported (first-wins)", () => {
  const md = ["See[^d].", "", "[^d]: first", "[^d]: second"].join("\n");
  const d = analyzeFootnotes(md);
  assert.deepEqual(d.duplicateDefinitions, ["d"]);
  assert.match(d.warnings.join("\n"), /defined more than once/);
});

test("reference inside a GFM table row is reported (heuristic)", () => {
  const md = [
    "| Col |",
    "| --- |",
    "| cell[^t] |",
    "",
    "[^t]: table note",
  ].join("\n");
  const d = analyzeFootnotes(md);
  assert.deepEqual(d.referencesInTables, ["t"]);
  assert.match(d.warnings.join("\n"), /table/);
  // It is defined, so it is NOT also dangling.
  assert.deepEqual(d.danglingReferences, []);
});

test("footnote syntax inside a code fence is ignored", () => {
  const md = [
    "Intro.",
    "",
    "```",
    "Example[^demo]",
    "[^demo]: not a real definition",
    "```",
    "",
    "Outro[^a].",
    "",
    "[^a]: real",
  ].join("\n");
  const d = analyzeFootnotes(md);
  // `[^demo]` lives only in the fenced block, so it is neither a reference nor a
  // dangling one, and `[^demo]:` is not counted as a definition.
  assert.deepEqual(d.danglingReferences, []);
  assert.deepEqual(d.duplicateDefinitions, []);
  assert.deepEqual(d.warnings, []);
});

test("a reference that only appears inside a definition's text is not dangling", () => {
  // `[^b]` is referenced from within [^a]'s text and has its own definition.
  const md = ["See[^a].", "", "[^a]: see also [^b]", "[^b]: the other"].join(
    "\n",
  );
  const d = analyzeFootnotes(md);
  assert.deepEqual(d.danglingReferences, []);
});

test("multiple problem classes accumulate distinct warnings", () => {
  const md = [
    "Ref[^x] and[^dup].",
    "",
    "[^dup]: one",
    "[^dup]: two",
    "[^empty]:",
  ].join("\n");
  const d = analyzeFootnotes(md);
  // x has no definition; dup is defined twice; empty is empty AND has no ref.
  assert.ok(d.danglingReferences.includes("x"));
  assert.deepEqual(d.duplicateDefinitions, ["dup"]);
  assert.deepEqual(d.emptyDefinitions, ["empty"]);
  // One warning line per problem class present.
  assert.ok(d.warnings.length >= 3);
});
