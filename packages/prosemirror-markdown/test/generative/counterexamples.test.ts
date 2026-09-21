import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { convertProseMirrorToMarkdown } from '../../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../../src/lib/markdown-to-prosemirror.js';
import { docsCanonicallyEqual } from '../../src/lib/canonicalize.js';

// ---------------------------------------------------------------------------
// #351 committed counterexample — a REAL round-trip bug surfaced by the flat
// generative probing (attribute level). The bug below is now FIXED in src/
// (maintainer-approved), so this case is a permanent PASSING regression pin:
// the exact document that once lost data now round-trips cleanly, and the
// fixture stays in test/fixtures/counterexamples/ forever (per the epic
// guardrail) to guard against a re-regression. The case carries a loud
// `// BUG #351 (FIXED):` note recording the defect and its fix site.
//
// With the bug fixed, the offending attribute is now VALUE-FUZZED by the
// generator (see attr-arbitraries.ts: orderedList.start), not held out — this
// committed document is the minimal, human-readable pin.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '../fixtures/counterexamples');

function loadDoc(file: string): any {
  return JSON.parse(readFileSync(path.join(fixtureDir, file), 'utf8')).doc;
}

describe('#351 counterexamples (round-trip bugs, now FIXED — permanent regression pins)', () => {
  // BUG #351 (FIXED): an `orderedList` with a non-1 `start` lost its start
  // number. CommonMark CAN express this ("5." starts the list at 5), but the
  // converter always emitted "1." and ignored `attrs.start`:
  //   doc.start = 5   ->   md1 = "1. alpha"   (start dropped on export)
  //   re-import stored start = 1   =>   docsCanonicallyEqual(rt, doc) === false
  // A P1 (semantic round-trip) loss of the SAME class as column.width. FIXED in
  // this PR in src/lib/markdown-converter.ts (the orderedList markdown path emits
  // `${start + index}.`; the raw-HTML path emits `<ol start="N">`). tiptap's
  // StarterKit / marked parse the start back, so it round-trips. Permanent P1 pin.
  it('ordered list start number is preserved (P1)', async () => {
    const doc = loadDoc('ordered-list-start.json');
    const md1 = convertProseMirrorToMarkdown(doc);
    const doc2 = await markdownToProseMirror(md1);
    expect(docsCanonicallyEqual(doc2, doc)).toBe(true);
  });
});
