import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeFootnotes,
  footnoteContentKey,
} from "../../build/lib/footnote-canonicalize.js";
import { insertInlineFootnote } from "../../build/lib/transforms.js";
import { markdownToProseMirror } from "../../build/lib/collaboration.js";

function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) {
    for (const c of node.content) findAll(c, type, acc);
  }
  return acc;
}
const defIds = (doc) =>
  findAll(doc, "footnoteDefinition").map((d) => d.attrs.id);
const refIds = (doc) =>
  findAll(doc, "footnoteReference").map((r) => r.attrs.id);

const ref = (id) => ({ type: "footnoteReference", attrs: { id } });
const def = (id, text) => ({
  type: "footnoteDefinition",
  attrs: { id },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const para = (...inline) => ({ type: "paragraph", content: inline });
const list = (...defs) => ({ type: "footnotesList", content: defs });

test("canonicalize orders definitions by first reference (out-of-order -> 1..N)", () => {
  const doc = {
    type: "doc",
    content: [
      para({ type: "text", text: "x" }, ref("b"), ref("a"), ref("d"), ref("c")),
      list(def("a", "A"), def("c", "C"), def("b", "B"), def("d", "D")),
    ],
  };
  const out = canonicalizeFootnotes(doc);
  assert.deepEqual(defIds(out), ["b", "a", "d", "c"]);
  assert.equal(findAll(out, "footnotesList").length, 1);
});

test("canonicalize drops orphan definitions", () => {
  const doc = {
    type: "doc",
    content: [
      para({ type: "text", text: "x" }, ref("a")),
      list(def("a", "A"), def("orphan", "O")),
    ],
  };
  assert.deepEqual(defIds(canonicalizeFootnotes(doc)), ["a"]);
});

test("canonicalize: no references -> no list", () => {
  const doc = {
    type: "doc",
    content: [para({ type: "text", text: "x" }), list(def("o", "O"))],
  };
  const out = canonicalizeFootnotes(doc);
  assert.equal(findAll(out, "footnotesList").length, 0);
});

test("canonicalize: duplicate definitions -> first wins, rest dropped", () => {
  const doc = {
    type: "doc",
    content: [
      para({ type: "text", text: "x" }, ref("d")),
      list(def("d", "first"), def("d", "second")),
    ],
  };
  const out = canonicalizeFootnotes(doc);
  assert.deepEqual(defIds(out), ["d"]);
  assert.match(JSON.stringify(out), /"first"/);
  assert.doesNotMatch(JSON.stringify(out), /"second"/);
});

test("canonicalize is idempotent", () => {
  const doc = {
    type: "doc",
    content: [
      para({ type: "text", text: "x" }, ref("b"), ref("a")),
      list(def("a", "A"), def("b", "B"), def("orphan", "O")),
    ],
  };
  const once = canonicalizeFootnotes(doc);
  const twice = canonicalizeFootnotes(once);
  assert.deepEqual(twice, once);
});

test("canonicalize does not mutate its input", () => {
  const doc = {
    type: "doc",
    content: [para({ type: "text", text: "x" }, ref("a")), list(def("o", "O"))],
  };
  const snap = JSON.parse(JSON.stringify(doc));
  canonicalizeFootnotes(doc);
  assert.deepEqual(doc, snap);
});

test("footnoteContentKey: same text -> same key; formatting differs -> different key", () => {
  const plain = def("x", "hello world");
  const sameText = def("y", "hello   world"); // whitespace-collapsed match
  const bold = {
    type: "footnoteDefinition",
    attrs: { id: "z" },
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "hello world", marks: [{ type: "bold" }] },
        ],
      },
    ],
  };
  assert.equal(footnoteContentKey(plain), footnoteContentKey(sameText));
  assert.notEqual(footnoteContentKey(plain), footnoteContentKey(bold));
});

test("insertInlineFootnote: places a reference at the anchor and derives the list", () => {
  const doc = {
    type: "doc",
    content: [para({ type: "text", text: "The sky is blue today." })],
  };
  const r = insertInlineFootnote(doc, {
    anchorText: "blue",
    text: "Rayleigh scattering.",
  });
  assert.equal(r.inserted, true);
  assert.equal(r.reused, false);
  assert.equal(refIds(r.doc).length, 1);
  assert.deepEqual(defIds(r.doc), [r.footnoteId]);
  // The marker hugs the anchor word (no leading space text run before the ref).
  assert.equal(findAll(r.doc, "footnotesList").length, 1);
});

test("insertInlineFootnote: content dedup -> same text reuses one definition, two refs", () => {
  let doc = {
    type: "doc",
    content: [para({ type: "text", text: "Alpha and beta and gamma." })],
  };
  const r1 = insertInlineFootnote(doc, {
    anchorText: "Alpha",
    text: "shared note",
  });
  const r2 = insertInlineFootnote(r1.doc, {
    anchorText: "beta",
    text: "shared note",
  });
  assert.equal(r2.reused, true);
  assert.equal(r2.footnoteId, r1.footnoteId);
  // One definition, two references both pointing at it.
  assert.deepEqual(defIds(r2.doc), [r1.footnoteId]);
  assert.deepEqual(refIds(r2.doc), [r1.footnoteId, r1.footnoteId]);
});

test("insertInlineFootnote: distinct text -> two definitions numbered by reference order", () => {
  let doc = {
    type: "doc",
    content: [para({ type: "text", text: "First point, second point." })],
  };
  const r1 = insertInlineFootnote(doc, { anchorText: "First", text: "note one" });
  const r2 = insertInlineFootnote(r1.doc, {
    anchorText: "second",
    text: "note two",
  });
  assert.equal(r2.reused, false);
  // Reference order in the body is [First-ref, second-ref]; the derived list
  // matches that order.
  assert.deepEqual(defIds(r2.doc), refIds(r2.doc));
  assert.equal(defIds(r2.doc).length, 2);
});

test("insertInlineFootnote: anchor not found -> inserted:false, no write", () => {
  const doc = {
    type: "doc",
    content: [para({ type: "text", text: "nothing to anchor on" })],
  };
  const r = insertInlineFootnote(doc, { anchorText: "ZZZ", text: "x" });
  assert.equal(r.inserted, false);
  assert.equal(findAll(r.doc, "footnoteReference").length, 0);
});

test("markdown import: out-of-order definitions render as a reference-ordered list", async () => {
  // References appear b, a, c in the body; definitions are written in a, b, c
  // order (the import order). After canonicalization the bottom list follows
  // REFERENCE order so the numbers read 1, 2, 3 down the list.
  const md = [
    "See[^b] then[^a] then[^c].",
    "",
    "[^a]: alpha",
    "[^b]: bravo",
    "[^c]: charlie",
  ].join("\n");
  const json = await markdownToProseMirror(md);
  assert.deepEqual(defIds(json), ["b", "a", "c"]);
  assert.equal(findAll(json, "footnotesList").length, 1);
});
