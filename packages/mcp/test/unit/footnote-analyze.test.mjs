import { test } from "node:test";
import assert from "node:assert/strict";

import {
  footnoteWarningsField,
  hasLegacyFootnoteDefinition,
} from "../../build/lib/footnote-analyze.js";

// #414: the legacy footnote diagnostics were reduced to ONE advisory that fires
// on the PRESENCE of legacy reference-style `[^id]:` definition syntax (inert on
// import since #293), nudging the author to inline `^[...]` footnotes.

test("inline `^[...]` footnotes produce no warning", () => {
  const md = "A note here.^[the body] and reuse elsewhere.^[the body]";
  assert.equal(hasLegacyFootnoteDefinition(md), false);
  assert.deepEqual(footnoteWarningsField(md), {});
});

test("no footnotes at all produce no warning", () => {
  const md = "Just a paragraph with [a link](https://x) and no footnotes.";
  assert.equal(hasLegacyFootnoteDefinition(md), false);
  assert.deepEqual(footnoteWarningsField(md), {});
});

test("a legacy `[^id]:` definition triggers the single advisory", () => {
  const md = ["See[^a].", "", "[^a]: defined"].join("\n");
  assert.equal(hasLegacyFootnoteDefinition(md), true);
  const field = footnoteWarningsField(md);
  assert.equal(field.footnoteWarnings.length, 1);
  assert.match(field.footnoteWarnings[0], /reference-style footnotes/i);
  assert.match(field.footnoteWarnings[0], /\^\[footnote text\]/);
});

test("a bare `[^id]` reference (no definition line) is not flagged", () => {
  // Only the definition syntax `[^id]:` is a reliable signal of legacy authoring;
  // a lone `[^x]` in prose is too ambiguous to warn on.
  const md = "A sentence mentioning [^x] with no definition.";
  assert.equal(hasLegacyFootnoteDefinition(md), false);
  assert.deepEqual(footnoteWarningsField(md), {});
});

test("legacy syntax inside a code fence is ignored (fence-aware)", () => {
  const md = [
    "Intro.",
    "",
    "```",
    "Example[^demo]",
    "[^demo]: not a real definition",
    "```",
    "",
    "Outro with an inline note.^[real]",
  ].join("\n");
  assert.equal(hasLegacyFootnoteDefinition(md), false);
  assert.deepEqual(footnoteWarningsField(md), {});
});

test("a legacy definition OUTSIDE a fence still warns even with a fenced sample", () => {
  const md = [
    "```",
    "[^demo]: example inside a fence",
    "```",
    "",
    "See[^a].",
    "",
    "[^a]: real definition outside the fence",
  ].join("\n");
  assert.equal(hasLegacyFootnoteDefinition(md), true);
  assert.equal(footnoteWarningsField(md).footnoteWarnings.length, 1);
});
