// CI guard for architecture item B: the shared golden corpus is duplicated (the
// canonical TS copy in editor-ext + the MCP .mjs mirror), so a typo in one copy
// would otherwise pass BOTH per-package suites green while silently breaking the
// cross-copy invariant. This test loads BOTH copies and asserts they are
// deep-equal, turning "the two corpora stay identical" into a checked property.
//
// The editor-ext copy is a .ts module (not importable from node:test), so it is
// read as text and its array literal — which is pure JSON produced by
// JSON.stringify — is parsed out directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { FOOTNOTE_CORPUS as MCP_CORPUS } from "./footnote-corpus.mjs";

function loadEditorExtCorpus() {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsPath = resolve(
    here,
    "../../../editor-ext/src/lib/footnote/footnote-corpus.ts",
  );
  const src = readFileSync(tsPath, "utf8");
  // The value is `export const FOOTNOTE_CORPUS: FootnoteCorpusCase[] = [ ... ];`
  // where `[ ... ]` is strict JSON (JSON.stringify output). Slice from the
  // assignment's opening bracket to the final closing bracket and parse.
  const assignAt = src.indexOf("] = ");
  assert.ok(assignAt >= 0, "could not locate the editor-ext corpus assignment");
  const jsonStart = src.indexOf("[", assignAt + 3);
  const jsonEnd = src.lastIndexOf("]");
  assert.ok(jsonStart >= 0 && jsonEnd > jsonStart, "could not bound the corpus array");
  return JSON.parse(src.slice(jsonStart, jsonEnd + 1));
}

test("the editor-ext and MCP golden corpora are byte-for-byte identical", () => {
  const editorExt = loadEditorExtCorpus();
  assert.ok(Array.isArray(editorExt) && editorExt.length > 0, "editor-ext corpus is non-empty");
  assert.equal(
    MCP_CORPUS.length,
    editorExt.length,
    "the two corpora must have the same number of cases",
  );
  assert.deepEqual(
    MCP_CORPUS,
    editorExt,
    "the MCP corpus mirror has drifted from the editor-ext canonical copy — re-sync them",
  );
});
