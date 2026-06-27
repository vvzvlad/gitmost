// Footnote-marker extraction in the integrity diff (diff.ts `footnoteMarkers`,
// surfaced via diffDocs(...).integrity.footnoteMarkers).
//
// The existing diff.test.mjs covers the basic legacy `[N]` body markers and the
// default notes-heading split. These add the cases it does not:
//  - real footnoteReference nodes take precedence over legacy `[N]` text,
//  - the notesHeading parameter is configurable,
//  - footnoteReference nodes are numbered 1..n by reading position.
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffDocs } from "../../build/lib/diff.js";

// Builders.
const doc = (...content) => ({ type: "doc", content });
const para = (...content) => ({ type: "paragraph", content });
const t = (text) => ({ type: "text", text });
const heading = (level, text) => ({ type: "heading", attrs: { level }, content: [t(text)] });
const fref = () => ({ type: "footnoteReference" });

// ---------------------------------------------------------------------------
// footnoteReference nodes take precedence over legacy [N] text markers.
// ---------------------------------------------------------------------------
test("footnoteReference nodes are numbered 1..n by reading position", () => {
  const d = doc(para(t("a"), fref(), t(" b "), fref(), t(" c "), fref()));
  const r = diffDocs(d, d);
  // Three refs -> [1, 2, 3] regardless of any stored number.
  assert.deepEqual(r.integrity.footnoteMarkers, [[1, 2, 3], [1, 2, 3]]);
});

test("when real footnoteReference nodes exist, legacy [N] text markers are ignored", () => {
  // Body has TWO footnoteReference nodes AND a literal "[9]" text marker.
  // The refs win: the literal [9] must NOT contribute a marker.
  const d = doc(para(t("intro "), fref(), t(" middle [9] tail "), fref()));
  const r = diffDocs(d, d);
  assert.deepEqual(
    r.integrity.footnoteMarkers,
    [[1, 2], [1, 2]],
    "literal [9] is dropped when footnoteReference nodes are present",
  );
});

// ---------------------------------------------------------------------------
// The notesHeading split is configurable; the body/notes boundary follows it.
// ---------------------------------------------------------------------------
test("a custom notesHeading splits body from notes for legacy markers", () => {
  const d = doc(
    para(t("body [1] [2]")),
    heading(2, "Notes"),
    para(t("note text [1] inside notes")),
  );
  // With notesHeading="Notes" only the body markers [1],[2] are counted; the
  // [1] under the heading is excluded.
  const r = diffDocs(d, d, "Notes");
  assert.deepEqual(r.integrity.footnoteMarkers, [[1, 2], [1, 2]]);
});

test("a notesHeading that does not match any heading counts the whole doc", () => {
  const d = doc(
    para(t("body [1] [2]")),
    heading(2, "Notes"),
    para(t("note text [1] inside notes")),
  );
  // The default heading ("Примечания переводчика") does not match "Notes", so
  // there is no body/notes split and ALL three markers are counted in order.
  const r = diffDocs(d, d);
  assert.deepEqual(r.integrity.footnoteMarkers, [[1, 2, 1], [1, 2, 1]]);
});

// ---------------------------------------------------------------------------
// Legacy markers preserve their literal value and reading order; the diff
// surfaces added/removed markers between two docs.
// ---------------------------------------------------------------------------
test("legacy [N] markers keep their literal numbers in reading order", () => {
  // Out-of-sequence literal numbers must be preserved verbatim (not renumbered).
  const d = doc(para(t("see [3] then [1] then [10]")));
  const r = diffDocs(d, d);
  assert.deepEqual(r.integrity.footnoteMarkers, [[3, 1, 10], [3, 1, 10]]);
});

test("a dropped legacy marker shows up as an [old,new] difference", () => {
  const oldDoc = doc(para(t("a [1] b [2] c [3]")));
  const newDoc = doc(para(t("a [1] b [3]")));
  const r = diffDocs(oldDoc, newDoc);
  assert.deepEqual(r.integrity.footnoteMarkers, [[1, 2, 3], [1, 3]]);
});
