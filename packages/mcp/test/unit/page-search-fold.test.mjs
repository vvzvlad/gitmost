import { test } from "node:test";
import assert from "node:assert/strict";

import { searchInDoc } from "../../build/lib/page-search.js";

// ---------------------------------------------------------------------------
// #659: searchInPage (literal mode) must match text THROUGH invisible characters
// — soft hyphen U+00AD, NBSP, zero-width chars and collapsed whitespace runs —
// exactly like editPageText already does after #658, while keeping plain-text
// matches byte-identical to the pre-#659 output. Regex mode does NOT fold.
// ---------------------------------------------------------------------------

const SHY = "­"; // U+00AD soft hyphen (deleted by the fold)
const NBSP = " "; // U+00A0 non-breaking space (collapses to a normal space)
const ZWSP = "​"; // U+200B zero-width space (deleted by the fold)

const text = (t, marks) =>
  marks ? { type: "text", text: t, marks } : { type: "text", text: t };
const para = (id, ...children) => ({
  type: "paragraph",
  attrs: { id },
  content: children,
});

function doc(...content) {
  return { type: "doc", content };
}

// Criterion 1: SHY inside the document text is transparent to a plain query, the
// hit is flagged folded:true, and `match` KEEPS the original SHY byte.
test("#659 soft hyphen: 'в люд­ях' matches query 'в людях' with folded:true and original SHY in match", () => {
  const d = doc(para("p1", text(`в люд${SHY}ях бывает`)));
  const res = searchInDoc(d, "в людях");
  assert.equal(res.total, 1);
  assert.equal(res.matches.length, 1);
  const m = res.matches[0];
  assert.equal(m.folded, true);
  // The match is the ORIGINAL document fragment — the SHY byte is still present.
  assert.equal(m.match, `в люд${SHY}ях`);
  assert.ok(m.match.includes(SHY), "match must contain the original SHY byte");
  // Context is drawn from the original text around the fold-mapped range.
  assert.equal(m.before, "");
  assert.equal(m.after, " бывает");
});

// Criterion 2: NBSP in the document collapses to a normal space, so a query with
// a normal space matches "5 шт".
test("#659 NBSP: '5\\u00A0шт' matches query '5 шт'", () => {
  const d = doc(para("p1", text(`есть 5${NBSP}шт всего`)));
  const res = searchInDoc(d, "5 шт");
  assert.equal(res.total, 1);
  assert.equal(res.matches.length, 1);
  const m = res.matches[0];
  assert.equal(m.folded, true);
  assert.equal(m.match, `5${NBSP}шт`);
  assert.ok(m.match.includes(NBSP), "match keeps the original NBSP");
});

// Zero-width space is also folded (delete-class), same as SHY.
test("#659 zero-width space is folded like SHY", () => {
  const d = doc(para("p1", text(`ab${ZWSP}cd`)));
  const res = searchInDoc(d, "abcd");
  assert.equal(res.total, 1);
  assert.equal(res.matches[0].folded, true);
  assert.equal(res.matches[0].match, `ab${ZWSP}cd`);
});

// Criterion 3 (regression): plain text with no invisibles is byte-identical to
// the current behavior — same hits AND no `folded` field.
test("#659 plain text regression: no invisibles -> byte-identical hits, no folded flag", () => {
  const d = doc(
    para("p1", text("The cat sat on the cat mat.")),
    para("p2", text("Another cat here")),
  );
  const res = searchInDoc(d, "cat");
  assert.equal(res.total, 3);
  assert.equal(res.truncated, false);
  assert.equal(res.matches.length, 3);
  for (const m of res.matches) {
    assert.equal(m.match, "cat");
    // `folded` is OMITTED on a plain match (not merely false).
    assert.equal("folded" in m, false);
    assert.equal(m.folded, undefined);
  }
  // Full-shape assertion: the first hit is unchanged from historic output.
  assert.deepEqual(res.matches[0], {
    nodeId: "p1",
    blockIndex: 0,
    type: "paragraph",
    before: "The ",
    match: "cat",
    after: " sat on the cat mat.",
  });
});

// Criterion 4: caseSensitive:false (default) composes with the fold — an
// uppercase query finds folded lowercase text, and folded:true still fires
// because the DOCUMENT fragment was folded (even though case also differed).
test("#659 case-insensitive default composes with fold: 'ЛЮДЯХ' finds 'люд­ях' with folded:true", () => {
  const d = doc(para("p1", text(`тут люд${SHY}ях живут`)));
  const res = searchInDoc(d, "ЛЮДЯХ");
  assert.equal(res.total, 1);
  const m = res.matches[0];
  assert.equal(m.folded, true);
  assert.equal(m.match, `люд${SHY}ях`);
});

// A case-ONLY difference must NOT set folded (fold flag is independent of case).
test("#659 case-only difference does NOT set folded", () => {
  const d = doc(para("p1", text("тут людях живут")));
  const res = searchInDoc(d, "ЛЮДЯХ");
  assert.equal(res.total, 1);
  const m = res.matches[0];
  assert.equal("folded" in m, false);
  assert.equal(m.match, "людях");
});

// Criterion 5: regex mode does NOT fold — a plain pattern does not match across
// a SHY-separated string (behaves exactly as before #659).
test("#659 regex mode does not fold: plain pattern misses a SHY-separated run", () => {
  const d = doc(para("p1", text(`в люд${SHY}ях`)));
  // Literal mode finds it (fold); regex mode does not.
  assert.equal(searchInDoc(d, "людях").total, 1);
  assert.equal(searchInDoc(d, "людях", { regex: true }).total, 0);
  // A regex that matches the SHY explicitly still works.
  const explicit = searchInDoc(d, "люд[\\x{00ad}]?ях", { regex: true });
  assert.equal(explicit.total, 1);
  // Regex hits never carry a folded flag.
  assert.equal("folded" in explicit.matches[0], false);
});

// Criterion 6: total/truncated with limit keep prior semantics — fold does not
// change counting/truncation logic. Three SHY-folded occurrences, limit 2.
test("#659 total/truncated/limit unchanged with folded hits", () => {
  const d = doc(
    para("p1", text(`abc ab${SHY}c a${SHY}bc`)),
  );
  const res = searchInDoc(d, "abc", { limit: 2 });
  assert.equal(res.total, 3);
  assert.equal(res.truncated, true);
  assert.equal(res.matches.length, 2);
  // First is the clean occurrence (no folded), the second is folded.
  assert.equal("folded" in res.matches[0], false);
  assert.equal(res.matches[1].folded, true);
});

// Empty fold-guard: a query made only of fold-DELETE invisibles folds to empty
// and is rejected via the SAME "empty query" error as a raw-empty query.
test("#659 empty fold-guard: a SHY-only query raises the empty-query error", () => {
  const d = doc(para("p1", text("anything")));
  assert.throws(() => searchInDoc(d, SHY), /query is empty/i);
  assert.throws(() => searchInDoc(d, `${SHY}${ZWSP}`), /query is empty/i);
});

// Consistency with editPageText (#658): a single folded pass finds plain AND
// folded occurrences without double-counting overlaps. A query that occurs once
// clean and once folded in a block reports total:2 (not 3).
test("#659 no exact-vs-fold double counting within a block", () => {
  const d = doc(para("p1", text(`abc ab${SHY}c`)));
  const res = searchInDoc(d, "abc");
  assert.equal(res.total, 2);
  assert.equal("folded" in res.matches[0], false);
  assert.equal(res.matches[1].folded, true);
});

// Locks the TRAILING fold-boundary of `match`/`folded`: an invisible sitting at
// the END of the matched range (folded offset fi+flen) must be INCLUDED in
// `match` and set `folded`. The mid-word tests never exercise this because a real
// char always follows the last matched char there (so map[fi+flen-1]+1 coincides
// with map[fi+flen]); here `a` is immediately followed by the SHY, so both classic
// off-by-one mutations of `oj` (interior map[fi+flen]->map[fi+flen-1]+1 AND the
// end-clamp text.length->map[fi+flen-1]+1) drop the SHY and turn this RED.
test("#659 trailing invisible at the fold boundary is kept in match + sets folded", () => {
  // Interior boundary: `a` matched, SHY right after it, then a real char.
  const d1 = doc(para("p1", text(`Xa${SHY}bY`)));
  const r1 = searchInDoc(d1, "a");
  assert.equal(r1.total, 1);
  assert.equal(r1.matches[0].match, `a${SHY}`);
  assert.equal(r1.matches[0].folded, true);

  // End-of-string boundary: the SHY is the last char, exercising the text.length clamp.
  const d2 = doc(para("p1", text(`a${SHY}`)));
  const r2 = searchInDoc(d2, "a");
  assert.equal(r2.total, 1);
  assert.equal(r2.matches[0].match, `a${SHY}`);
  assert.equal(r2.matches[0].folded, true);
});
