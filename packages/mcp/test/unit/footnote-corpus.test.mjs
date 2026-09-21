// Runs the MCP mirror of `canonicalizeFootnotes` against the SHARED golden
// corpus (the same { input -> expected } cases the editor-ext copy is tested
// against in footnote-canonicalize.test.ts). Pinning identical expected outputs
// in both suites makes "the editor-ext copy and the MCP mirror behave
// identically" a checkable property without coupling the two packages
// (architecture item A). The corpus data is mirrored in footnote-corpus.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalizeFootnotes } from "../../build/lib/footnote-canonicalize.js";
import { FOOTNOTE_CORPUS } from "./footnote-corpus.mjs";

for (const { name, input, expected } of FOOTNOTE_CORPUS) {
  test(`shared corpus (MCP mirror): ${name}`, () => {
    assert.deepEqual(canonicalizeFootnotes(input), expected);
    // Idempotent on the corpus too.
    assert.deepEqual(canonicalizeFootnotes(expected), expected);
  });
}
