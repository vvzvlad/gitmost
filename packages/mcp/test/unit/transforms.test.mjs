import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blockText,
  walk,
  getList,
  insertMarkerAfter,
  setCalloutRange,
  noteItem,
  mdToInlineNodes,
  commentsToFootnotes,
} from "../../build/lib/transforms.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const para = (id, ...children) => ({
  type: "paragraph",
  attrs: { id },
  content: children,
});
const heading = (id, text) => ({
  type: "heading",
  attrs: { id, level: 2 },
  content: [t(text)],
});
const olist = (...items) => ({ type: "orderedList", content: items });
const li = (text) => ({
  type: "listItem",
  content: [{ type: "paragraph", content: [t(text)] }],
});
const doc = (...children) => ({ type: "doc", content: children });
const snapshot = (v) => JSON.parse(JSON.stringify(v));

// Collect every footnoteReference id under a node, in reading order.
const collectRefIds = (node, acc = []) => {
  if (!node || typeof node !== "object") return acc;
  if (node.type === "footnoteReference") acc.push(node.attrs?.id);
  if (Array.isArray(node.content)) {
    for (const c of node.content) collectRefIds(c, acc);
  }
  return acc;
};
// Plain text of a footnoteDefinition.
const defText = (def) => blockText(def);

// ---------------------------------------------------------------------------
// blockText / walk / getList
// ---------------------------------------------------------------------------
test("blockText concatenates nested inline text", () => {
  assert.equal(blockText(para("p", t("a"), t("b"), t("c"))), "abc");
});

test("walk visits every node depth-first", () => {
  const d = doc(para("p1", t("x")), olist(li("y")));
  const types = [];
  walk(d, (n) => types.push(n.type));
  assert.deepEqual(types, [
    "doc",
    "paragraph",
    "text",
    "orderedList",
    "listItem",
    "paragraph",
    "text",
  ]);
});

test("getList finds an orderedList without an id", () => {
  const d = doc(para("p", t("x")), olist(li("one")));
  const found = getList(d, (n) => n.type === "orderedList");
  assert.ok(found);
  assert.equal(found.type, "orderedList");
});

// ---------------------------------------------------------------------------
// insertMarkerAfter — mark-safe split
// ---------------------------------------------------------------------------
test("insertMarkerAfter splits a marked run and inserts an UNMARKED marker", () => {
  // A paragraph: "see " (plain) + "the link" (link mark) + " here" (plain).
  const link = [{ type: "link", attrs: { href: "http://x" } }];
  const original = doc(
    para("p1", t("see "), t("the link", link), t(" here")),
  );
  const before = snapshot(original);

  const { doc: out, inserted } = insertMarkerAfter(
    original,
    "the link",
    "[1]",
  );
  assert.equal(inserted, true);
  // The caller's object is untouched (deep clone).
  assert.deepEqual(original, before);

  const inline = out.content[0].content;
  // Expect: "see "(plain), "the link"(link), " [1]"(NO marks), " here"(plain).
  const marker = inline.find((n) => n.text === " [1]");
  assert.ok(marker, "marker run present");
  assert.equal(marker.marks, undefined, "marker carries no marks");

  // The link run kept its mark verbatim.
  const linkRun = inline.find((n) => n.text === "the link");
  assert.deepEqual(linkRun.marks, link);

  // Plain text reads correctly with the marker placed right after the anchor.
  assert.equal(blockText(out.content[0]), "see the link [1] here");
});

test("insertMarkerAfter respects beforeBlock and reports not-found", () => {
  const d = doc(para("p1", t("alpha")), para("p2", t("beta")));
  // anchor only in block index 1, but search limited to blocks < 1
  const r = insertMarkerAfter(d, "beta", "[1]", { beforeBlock: 1 });
  assert.equal(r.inserted, false);
});

// ---------------------------------------------------------------------------
// setCalloutRange
// ---------------------------------------------------------------------------
test("setCalloutRange rewrites [1]…[K] to [1]…[n]", () => {
  const d = doc({
    type: "callout",
    attrs: { type: "info" },
    content: [para("c", t("Footnotes [1]…[3] are translator notes."))],
  });
  const { doc: out, changed } = setCalloutRange(d, 7);
  assert.equal(changed, 1);
  assert.equal(blockText(out), "Footnotes [1]…[7] are translator notes.");
});

// ---------------------------------------------------------------------------
// noteItem / mdToInlineNodes
// ---------------------------------------------------------------------------
test("noteItem wraps inline nodes in a listItem with a fresh paragraph id", () => {
  const item = noteItem([t("hello")]);
  assert.equal(item.type, "listItem");
  assert.equal(item.content[0].type, "paragraph");
  assert.ok(item.content[0].attrs.id, "has a fresh id");
  assert.deepEqual(item.content[0].content, [t("hello")]);
});

test("mdToInlineNodes splits a bold lead and strips a prefix", () => {
  const nodes = mdToInlineNodes("комментарий: **Lead.** body text");
  // bold lead node + plain remainder
  assert.equal(nodes[0].text, "Lead.");
  assert.deepEqual(nodes[0].marks, [{ type: "bold" }]);
  assert.ok(nodes[1].text.includes("body text"));
  assert.equal(nodes[1].marks, undefined);
});

test("mdToInlineNodes strips a 'N. ' numeric prefix", () => {
  const nodes = mdToInlineNodes("3. plain note");
  assert.equal(nodes.map((n) => n.text).join(""), "plain note");
});

// ---------------------------------------------------------------------------
// commentsToFootnotes — renumber by reading position on a small fixture
// ---------------------------------------------------------------------------
test("commentsToFootnotes anchors comments and renumbers by position", () => {
  // Body has an EXISTING footnote [1] in the second paragraph; we add two
  // inline comments anchored to text in the first and third paragraphs. After
  // running, markers must be renumbered 1,2,3 in reading order and the notes
  // list reordered to match.
  const callout = {
    type: "callout",
    attrs: { type: "info" },
    content: [para("c", t("Notes [1]…[1] follow."))],
  };
  const d = doc(
    callout,
    para("p1", t("First mentions apple.")),
    para("p2", t("Second already has a note [1] here.")),
    para("p3", t("Third mentions banana.")),
    heading("h", "Примечания переводчика"),
    olist(li("existing note one")), // matches the existing [1]
  );

  const comments = [
    { id: "cA", content: "apple note", selection: "apple" },
    { id: "cB", content: "banana note", selection: "banana" },
  ];

  const { doc: out, consumed } = commentsToFootnotes(d, comments);
  assert.deepEqual(consumed.sort(), ["cA", "cB"]);

  // Real footnoteReference nodes were inserted at p1 (apple), p2 (existing),
  // p3 (banana), in reading order — the old `[N]` text markers are gone.
  const refIds = collectRefIds(out);
  assert.equal(refIds.length, 3);
  // Body paragraphs p1..p3 no longer carry literal [N] text markers.
  assert.doesNotMatch(blockText(out.content[1]), /\[\d+\]/);
  assert.doesNotMatch(blockText(out.content[2]), /\[\d+\]/);
  assert.doesNotMatch(blockText(out.content[3]), /\[\d+\]/);

  // No stray NUL placeholders remain.
  assert.doesNotMatch(blockText(out), /\u0000/);

  // The bottom footnotesList holds the definitions in reading order, each keyed
  // by the matching reference id.
  const list = out.content.find((n) => n.type === "footnotesList");
  assert.ok(list, "footnotesList present");
  assert.equal(list.content.length, 3);
  assert.deepEqual(
    list.content.map((d) => d.attrs.id),
    refIds,
  );
  assert.equal(defText(list.content[0]), "apple note");
  assert.equal(defText(list.content[1]), "existing note one");
  assert.equal(defText(list.content[2]), "banana note");

  // Callout range synced to 3 notes.
  assert.match(blockText(out.content[0]), /\[1\]…\[3\]/);
});

test("commentsToFootnotes throws when the notes heading is missing", () => {
  const d = doc(para("p", t("no notes section")));
  assert.throws(
    () => commentsToFootnotes(d, [{ id: "x", content: "y", selection: "no" }]),
    /heading .* not found/,
  );
});

// ---------------------------------------------------------------------------
// Bug 1: the placeholder sentinel must not collide with real "F<digits>" /
// "FN<digits>" text. Body text "F1"/"FN2"/"F12" near a real comment anchor must
// be left untouched; only the real comment becomes a footnote. "FN2" is the key
// case: the old printable " FN<i> " sentinel could collide with prose like "FN2",
// which the NUL-delimited "\u0000FN<i>\u0000" sentinel makes impossible.
// ---------------------------------------------------------------------------
test("commentsToFootnotes leaves literal 'F1'/'FN2'/'F12' body text untouched", () => {
  const d = doc(
    para("p1", t("Press F1 for help, model FN2 and F12 for tools near apple here.")),
    heading("h", "Примечания переводчика"),
    olist(), // empty notes list; the single comment supplies the only note
  );

  const comments = [{ id: "cA", content: "apple note", selection: "apple" }];

  const { doc: out, consumed } = commentsToFootnotes(d, comments);
  assert.deepEqual(consumed, ["cA"]);

  const bodyText = blockText(out.content[0]);
  // The literal "F1"/"FN2"/"F12" prose is preserved verbatim (no bogus
  // footnotes, no eaten spaces around them).
  assert.match(bodyText, /Press F1 for help, model FN2 and F12 for tools/);
  // Exactly one real footnoteReference node was produced, at the anchored word.
  const refIds = collectRefIds(out);
  assert.equal(refIds.length, 1);

  // Exactly one note in the list — "F1"/"FN2"/"F12" did not spawn extra notes.
  const list = out.content.find((n) => n.type === "footnotesList");
  assert.ok(list, "footnotesList present");
  assert.equal(list.content.length, 1);
  assert.equal(list.content[0].attrs.id, refIds[0]);
  assert.equal(defText(list.content[0]), "apple note");

  // No stray placeholder sentinel remains anywhere: the NUL-delimited sentinel
  // is fully consumed by the renumber pass, so no raw NUL control char persists
  // in the returned doc. We deliberately do NOT assert absence of the printable
  // " FN<i> " shape: the body intentionally contains real prose "model FN2 and",
  // which must survive verbatim (see the match assertion above) - that is exactly
  // why the old printable sentinel was unsafe and the NUL sentinel is not.
  assert.doesNotMatch(blockText(out), /\u0000/);
});

// ---------------------------------------------------------------------------
// Bug 2: an out-of-range body marker must throw, not silently drop the note.
// ---------------------------------------------------------------------------
test("commentsToFootnotes throws on an out-of-range body marker", () => {
  // Body marker [9] but the notes list has only 1 item -> inconsistent doc.
  const d = doc(
    para("p1", t("Some text with a dangling marker [9] here.")),
    heading("h", "Примечания переводчика"),
    olist(li("the only note")),
  );

  assert.throws(
    () => commentsToFootnotes(d, []),
    /footnote \[9\] has no matching note \(notes list has 1 items\); document is inconsistent/,
  );
});

// ---------------------------------------------------------------------------
// Bug 4: a non-disclaimer callout in the body gets its [N] markers renumbered;
// a disclaimer callout carrying a "[1]…[K]" range is left out of renumbering.
// ---------------------------------------------------------------------------
test("commentsToFootnotes renumbers body callouts but skips the disclaimer range", () => {
  const disclaimer = {
    type: "callout",
    attrs: { type: "info" },
    content: [para("d", t("Notes [1]…[2] follow."))],
  };
  const bodyCallout = {
    type: "callout",
    attrs: { type: "warning" },
    content: [para("bc", t("Important point already noted [1] above."))],
  };
  const d = doc(
    disclaimer,
    bodyCallout,
    para("p2", t("Then a second mention with [2] too.")),
    heading("h", "Примечания переводчика"),
    olist(li("first note"), li("second note")),
  );

  const { doc: out, consumed } = commentsToFootnotes(d, []);
  assert.deepEqual(consumed, []);

  // The disclaimer's "[1]…[K]" range is NOT treated as body markers: it stays
  // a range and is synced to the note count (2), not turned into references.
  assert.match(blockText(out.content[0]), /\[1\]…\[2\]/);

  // The body callout's [1] and the paragraph's [2] became footnoteReference
  // nodes in reading order (the literal text markers are gone).
  const refIds = collectRefIds(out);
  assert.equal(refIds.length, 2);
  assert.match(blockText(out.content[1]), /noted +above/); // [1] -> node, no text
  assert.match(blockText(out.content[2]), /with +too/); // [2] -> node, no text

  // The footnotesList holds the two original notes in reading order, keyed to
  // the new reference ids.
  const list = out.content.find((n) => n.type === "footnotesList");
  assert.ok(list, "footnotesList present");
  assert.equal(list.content.length, 2);
  assert.deepEqual(
    list.content.map((d) => d.attrs.id),
    refIds,
  );
  assert.equal(defText(list.content[0]), "first note");
  assert.equal(defText(list.content[1]), "second note");
});
