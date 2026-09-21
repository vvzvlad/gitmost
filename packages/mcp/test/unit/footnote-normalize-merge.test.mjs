import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeAndMergeFootnotes } from "../../build/lib/footnote-normalize-merge.js";
import { canonicalizeFootnotes } from "../../build/lib/footnote-canonicalize.js";

function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) {
    for (const c of node.content) findAll(c, type, acc);
  }
  return acc;
}
const defs = (doc) => findAll(doc, "footnoteDefinition");
const defIds = (doc) => defs(doc).map((d) => d.attrs.id);
const refIds = (doc) => findAll(doc, "footnoteReference").map((r) => r.attrs.id);
const defText = (d) =>
  findAll(d, "text")
    .map((t) => t.text)
    .join("");

const ref = (id) => ({ type: "footnoteReference", attrs: { id } });
const para = (...inline) => ({ type: "paragraph", content: inline });
const txt = (text, marks) =>
  marks ? { type: "text", text, marks } : { type: "text", text };
const def = (id, ...inline) => ({
  type: "footnoteDefinition",
  attrs: { id },
  content: [para(...inline)],
});
const list = (...defs) => ({ type: "footnotesList", content: defs });
const doc = (...content) => ({ type: "doc", content });

// --- Normalization + merge of glyph forks ----------------------------------

test("typographic double quotes «…» vs \"…\" merge into one", () => {
  const d = doc(
    para(txt("a"), ref("A"), txt(" b"), ref("B")),
    list(def("A", txt("«word»")), def("B", txt('"word"'))),
  );
  const out = normalizeAndMergeFootnotes(d);
  // Both references now point at the first definition's id.
  assert.deepEqual(refIds(out), ["A", "A"]);
  // Surviving text is ASCII-normalized.
  assert.equal(defText(defs(out)[0]), '"word"');
  // Duplicate def kept its id (canonicalizer removes it as an orphan later).
  const canon = canonicalizeFootnotes(out);
  assert.deepEqual(defIds(canon), ["A"]);
  assert.equal(findAll(canon, "footnotesList").length, 1);
});

test("em/en dash and hyphen merge", () => {
  const d = doc(
    para(ref("A"), ref("B"), ref("C")),
    list(
      def("A", txt("see — here")),
      def("B", txt("see – here")),
      def("C", txt("see - here")),
    ),
  );
  const out = normalizeAndMergeFootnotes(d);
  assert.deepEqual(refIds(out), ["A", "A", "A"]);
  assert.equal(defText(defs(out)[0]), "see - here");
});

test("NBSP and extra spaces merge with normal spacing", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(
      def("A", txt("foo bar")), // NBSP
      def("B", txt("foo   bar")), // collapsed spaces
    ),
  );
  const out = normalizeAndMergeFootnotes(d);
  assert.deepEqual(refIds(out), ["A", "A"]);
  assert.equal(defText(defs(out)[0]), "foo bar");
});

test("same text but different styling (bold vs plain) does NOT merge", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(
      def("A", txt("word", [{ type: "bold" }])),
      def("B", txt("word")),
    ),
  );
  const out = normalizeAndMergeFootnotes(d);
  // No re-hang: references keep their own ids.
  assert.deepEqual(refIds(out), ["A", "B"]);
  assert.deepEqual(defIds(out), ["A", "B"]);
  // Marks preserved on the surviving text node.
  assert.deepEqual(defs(out)[0].content[0].content[0].marks, [
    { type: "bold" },
  ]);
});

test("same text but a link mark with different href does NOT merge (data-loss guard)", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(
      def("A", txt("source", [{ type: "link", attrs: { href: "https://a.example/1" } }])),
      def("B", txt("source", [{ type: "link", attrs: { href: "https://b.example/2" } }])),
    ),
  );
  const out = normalizeAndMergeFootnotes(d);
  // No re-hang: each reference keeps its own definition (distinct link target).
  assert.deepEqual(refIds(out), ["A", "B"]);
  assert.deepEqual(defIds(out), ["A", "B"]);
  // Both distinct hrefs survive.
  assert.deepEqual(
    defs(out).map((dn) => dn.content[0].content[0].marks[0].attrs.href),
    ["https://a.example/1", "https://b.example/2"],
  );
  // Canonicalize keeps both as two tail entries (neither is an orphan).
  const canon = canonicalizeFootnotes(out);
  assert.deepEqual(defIds(canon), ["A", "B"]);
  assert.deepEqual(refIds(canon), ["A", "B"]);
});

test("same text and SAME link href still merges (attrs-aware key doesn't over-separate)", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(
      def("A", txt("source", [{ type: "link", attrs: { href: "https://a.example/1" } }])),
      def("B", txt("source", [{ type: "link", attrs: { href: "https://a.example/1" } }])),
    ),
  );
  const out = normalizeAndMergeFootnotes(d);
  assert.deepEqual(refIds(out), ["A", "A"]);
  const canon = canonicalizeFootnotes(out);
  assert.deepEqual(defIds(canon), ["A"]);
  assert.equal(findAll(canon, "footnotesList").length, 1);
});

test("marks are kept on merged (surviving) definition text", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(
      def("A", txt("«x»", [{ type: "italic" }])),
      def("B", txt("«x»", [{ type: "italic" }])),
    ),
  );
  const out = normalizeAndMergeFootnotes(d);
  assert.deepEqual(refIds(out), ["A", "A"]);
  assert.deepEqual(defs(out)[0].content[0].content[0].marks, [
    { type: "italic" },
  ]);
  assert.equal(defText(defs(out)[0]), '"x"');
});

// --- Inline code is verbatim (not typography) ------------------------------

test("text inside a code mark is left verbatim; prose in the same def is normalized", () => {
  const d = doc(
    para(ref("A")),
    list({
      type: "footnoteDefinition",
      attrs: { id: "A" },
      content: [
        para(
          txt("a—b «x»", [{ type: "code" }]),
          txt(" prose «y» — z"),
        ),
      ],
    }),
  );
  const out = normalizeAndMergeFootnotes(d);
  const nodes = findAll(defs(out)[0], "text");
  // Code node: byte-for-byte unchanged (typography preserved).
  assert.equal(nodes[0].text, "a—b «x»");
  // Prose node: dashes/quotes normalized to ASCII.
  assert.equal(nodes[1].text, ' prose "y" - z');
});

test("two notes differing ONLY by glyphs inside a code mark do NOT merge", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(
      def("A", txt("«x»", [{ type: "code" }]), txt(" same prose «q»")),
      def("B", txt('"x"', [{ type: "code" }]), txt(" same prose «q»")),
    ),
  );
  const out = normalizeAndMergeFootnotes(d);
  // Prose is identical after normalization, but the code literals differ raw
  // -> the merge key diverges -> both definitions survive, no re-hang.
  assert.deepEqual(refIds(out), ["A", "B"]);
  assert.deepEqual(defIds(out), ["A", "B"]);
  // Each code literal stays verbatim.
  assert.equal(defs(out)[0].content[0].content[0].text, "«x»");
  assert.equal(defs(out)[1].content[0].content[0].text, '"x"');
  // Both survive canonicalization (neither is an orphan).
  const canon = canonicalizeFootnotes(out);
  assert.deepEqual(defIds(canon), ["A", "B"]);
  assert.deepEqual(refIds(canon), ["A", "B"]);
});

// --- Composition with the canonicalizer ------------------------------------

test("pass + canonicalize: single tail list and sequential numbering", () => {
  const d = doc(
    para(txt("intro "), ref("A"), txt(" middle "), ref("B")),
    list(def("A", txt("«note»")), def("B", txt('"note"'))),
  );
  const canon = canonicalizeFootnotes(normalizeAndMergeFootnotes(d));
  assert.equal(findAll(canon, "footnotesList").length, 1);
  assert.deepEqual(defIds(canon), ["A"]);
  assert.deepEqual(refIds(canon), ["A", "A"]);
});

// --- Idempotency -----------------------------------------------------------

test("idempotent: a second run is a no-op", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(def("A", txt("«word»")), def("B", txt('"word"'))),
  );
  const once = normalizeAndMergeFootnotes(d);
  const twice = normalizeAndMergeFootnotes(once);
  assert.deepEqual(twice, once);
});

test("input document is not mutated (pure)", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(def("A", txt("«word»")), def("B", txt('"word"'))),
  );
  const snapshot = JSON.parse(JSON.stringify(d));
  normalizeAndMergeFootnotes(d);
  assert.deepEqual(d, snapshot);
});

// --- Nested definitions ----------------------------------------------------

test("definitions nested in a callout are normalized and merged", () => {
  const callout = (...content) => ({
    type: "callout",
    attrs: { type: "info" },
    content,
  });
  const d = doc(
    para(ref("A"), ref("B")),
    callout(list(def("A", txt("«c»")), def("B", txt('"c"')))),
  );
  const out = normalizeAndMergeFootnotes(d);
  assert.deepEqual(refIds(out), ["A", "A"]);
  assert.equal(defText(defs(out)[0]), '"c"');
});

// --- Empty footnotes -------------------------------------------------------

test("empty footnotes do NOT collapse into each other", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(def("A", txt("")), { type: "footnoteDefinition", attrs: { id: "B" }, content: [{ type: "paragraph" }] }),
  );
  const out = normalizeAndMergeFootnotes(d);
  // Both empty definitions keep distinct ids; references unchanged.
  assert.deepEqual(refIds(out), ["A", "B"]);
  assert.deepEqual(defIds(out), ["A", "B"]);
});

// --- Body text left untouched ----------------------------------------------

test("body text (outside footnotes) is NOT normalized", () => {
  const d = doc(
    para(txt("body «quoted» — dash"), ref("A")),
    list(def("A", txt("«note»"))),
  );
  const out = normalizeAndMergeFootnotes(d);
  // Body paragraph keeps its typographic glyphs verbatim.
  assert.equal(out.content[0].content[0].text, "body «quoted» — dash");
  // Footnote text IS normalized.
  assert.equal(defText(defs(out)[0]), '"note"');
});

// --- Multi-paragraph structure preserved -----------------------------------

test("multi-paragraph definition: text normalized, structure preserved", () => {
  const d = doc(
    para(ref("A")),
    list({
      type: "footnoteDefinition",
      attrs: { id: "A" },
      content: [para(txt("«p1»")), para(txt("p2 — end"))],
    }),
  );
  const out = normalizeAndMergeFootnotes(d);
  const def0 = defs(out)[0];
  assert.equal(def0.content.length, 2);
  assert.equal(def0.content[0].content[0].text, '"p1"');
  assert.equal(def0.content[1].content[0].text, "p2 - end");
});

// --- Multi-reference footnote not broken -----------------------------------

test("one id shared by multiple references is preserved", () => {
  const d = doc(
    para(ref("A"), txt(" x "), ref("A")),
    list(def("A", txt("note"))),
  );
  const out = normalizeAndMergeFootnotes(d);
  assert.deepEqual(refIds(out), ["A", "A"]);
  assert.deepEqual(defIds(out), ["A"]);
});

// --- Whole-definition edge trim --------------------------------------------

test("leading/trailing whitespace is trimmed for the merge and stored text", () => {
  const d = doc(
    para(ref("A"), ref("B")),
    list(def("A", txt("  hello  ")), def("B", txt("hello"))),
  );
  const out = normalizeAndMergeFootnotes(d);
  assert.deepEqual(refIds(out), ["A", "A"]);
  assert.equal(defText(defs(out)[0]), "hello");
});
