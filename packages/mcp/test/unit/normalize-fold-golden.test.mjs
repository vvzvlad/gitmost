import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeForMatch,
  foldForMatch,
} from "../../build/lib/comment-anchor.js";
import {
  getAnchoredText,
  resolveAnchorSelection,
  countAnchorMatches,
} from "../../build/lib/comment-anchor.js";

// ── GOLDEN: the rebuilt normalizeForMatch must be byte-for-byte equal to the
//    HISTORIC implementation on a probe covering the whitespace/quote/dash canon
//    (incl. U+1680, U+2007, U+2028, U+2029, U+FEFF) and typography (#658). ──────

// Frozen copy of the OLD normalizer (pre-#658), inlined so this test is a true
// golden reference independent of the canon it now shares with.
function isWhitespaceCharOld(ch) {
  // Historic explicit list (U+00A0 U+2007 U+202F U+2009 U+200A U+2002 U+2003),
  // all already in JS \s; escapes make this golden reference exact.
  return (
    /\s/.test(ch) ||
    ch === "\u00A0" ||
    ch === "\u2007" ||
    ch === "\u202F" ||
    ch === "\u2009" ||
    ch === "\u200A" ||
    ch === "\u2002" ||
    ch === "\u2003"
  );
}
const DOUBLE_QUOTES_OLD = "«»„“”‟〝〞＂";
const SINGLE_QUOTES_OLD = "‘’‚‛";
const DASHES_OLD = "–—―−‐‑‒";
function normalizeForMatchOld(s) {
  let norm = "";
  const map = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isWhitespaceCharOld(ch)) {
      const runStart = i;
      while (i < s.length && isWhitespaceCharOld(s[i])) i++;
      norm += " ";
      map.push(runStart);
      continue;
    }
    let mapped = ch;
    if (DOUBLE_QUOTES_OLD.indexOf(ch) !== -1) mapped = '"';
    else if (SINGLE_QUOTES_OLD.indexOf(ch) !== -1) mapped = "'";
    else if (DASHES_OLD.indexOf(ch) !== -1) mapped = "-";
    norm += mapped;
    map.push(i);
    i++;
  }
  return { norm, map };
}

const PROBES = [
  "hello world",
  "a\u1680b",
  "5\u2007шт",
  "line1\u2028line2",
  "line1\u2029line2",
  "a\uFEFFb",
  "\u00AB\u0451\u043B\u043E\u0447\u043A\u0438\u00BB \u2014 \u2018apos\u2019",
  "tabs\t\t and   runs",
  "trailing     end",
  "a\u00A0b\u202Fc\u2009d",
];

test("GOLDEN: normalizeForMatch ≡ the historic implementation", () => {
  for (const p of PROBES) {
    assert.deepEqual(
      normalizeForMatch(p),
      normalizeForMatchOld(p),
      `normalizeForMatch drift on probe: ${JSON.stringify(p)}`,
    );
  }
});

test("U+FEFF is a SPACE on pass-1 (legacy) — proves the class split is fold-only", () => {
  assert.equal(normalizeForMatch("a\uFEFFb").norm, "a b");
  // ...while the fold tier DELETES it.
  assert.equal(foldForMatch("a\uFEFFb").norm, "ab");
});

// ── createComment fold-tier anchoring (criterion 11) ────────────────────────

const textNode = (text, extra = {}) => ({ type: "text", text, ...extra });
const paragraph = (...c) => ({ type: "paragraph", content: c });
const docOf = (...c) => ({ type: "doc", content: c });
const SHY = "­";

test("criterion 11: a plain selection anchors on a SHY document span (fold tier)", () => {
  const d = docOf(paragraph(textNode("в люд" + SHY + "ях бывает")));
  // pass-1 (verbatim) cannot anchor "людях" against "люд<SHY>ях"; the fold tier can.
  const anchored = getAnchoredText(d, "людях");
  assert.equal(anchored, "люд" + SHY + "ях"); // stored text = the RAW document span
  const resolved = resolveAnchorSelection(d, "людях");
  assert.equal(resolved.found, true);
  assert.equal(resolved.foldPass, true);
  // Uniqueness counting runs in the SAME (fold) tier's space, so count agrees.
  assert.equal(countAnchorMatches(d, "людях"), 1);
});

test("createComment: pass-1 first match is NOT shifted by the fold tier", () => {
  const d = docOf(paragraph(textNode("plain людях here")));
  const resolved = resolveAnchorSelection(d, "людях");
  assert.equal(resolved.found, true);
  assert.notEqual(resolved.foldPass, true); // pass-1 wins, byte-for-byte unchanged
  assert.equal(getAnchoredText(d, "людях"), "людях");
});
