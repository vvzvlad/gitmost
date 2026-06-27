import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCollabWsUrl,
  markdownToProseMirror,
  markdownToProseMirrorCanonical,
} from "../../build/lib/collaboration.js";

/** Recursively find the first descendant node (or self) of the given type. */
function find(node, type) {
  if (!node || typeof node !== "object") return null;
  if (node.type === type) return node;
  const kids = Array.isArray(node.content) ? node.content : [];
  for (const k of kids) {
    const r = find(k, type);
    if (r) return r;
  }
  return null;
}

/** Recursively collect every descendant node (and self) of the given type. */
function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  const kids = Array.isArray(node.content) ? node.content : [];
  for (const k of kids) findAll(k, type, acc);
  return acc;
}

/** Collect the set of mark types present anywhere in the document tree. */
function collectMarkTypes(node, set = new Set()) {
  if (!node || typeof node !== "object") return set;
  if (Array.isArray(node.marks)) {
    for (const m of node.marks) set.add(m.type);
  }
  const kids = Array.isArray(node.content) ? node.content : [];
  for (const k of kids) collectMarkTypes(k, set);
  return set;
}

test("buildCollabWsUrl: https + /api -> wss + /collab", () => {
  assert.equal(buildCollabWsUrl("https://h/api"), "wss://h/collab");
});

test("buildCollabWsUrl: http (no /api) -> ws + /collab", () => {
  assert.equal(buildCollabWsUrl("http://h"), "ws://h/collab");
});

test("buildCollabWsUrl: trailing slash on /api/ is handled", () => {
  assert.equal(buildCollabWsUrl("https://h/api/"), "wss://h/collab");
});

test("buildCollabWsUrl: a base with trailing slash maps to /collab", () => {
  assert.equal(buildCollabWsUrl("https://h/"), "wss://h/collab");
});

test("buildCollabWsUrl: query and hash on the base are dropped", () => {
  assert.equal(buildCollabWsUrl("https://h/api?foo=1#bar"), "wss://h/collab");
});

test("markdownToProseMirror: :::warning::: becomes a callout node typed warning", async () => {
  const doc = await markdownToProseMirror(":::warning\nhello\n:::");
  const callout = find(doc, "callout");
  assert.ok(callout, "expected a callout node");
  assert.equal(callout.attrs.type, "warning");
});

test("markdownToProseMirror: a ::: line inside a fenced code block is not a callout delimiter", async () => {
  const doc = await markdownToProseMirror("```\n:::warning\nx\n:::\n```");
  assert.equal(find(doc, "callout"), null, "code-fenced ::: must not open a callout");
  assert.ok(find(doc, "codeBlock"), "the fenced block should stay a codeBlock");
});

test("markdownToProseMirror: GFM checkbox list -> one taskList, two taskItems, no bulletList", async () => {
  const doc = await markdownToProseMirror("- [x] a\n- [ ] b");
  const taskLists = findAll(doc, "taskList");
  assert.equal(taskLists.length, 1, "expected exactly one taskList");
  const items = findAll(doc, "taskItem");
  assert.equal(items.length, 2, "expected two taskItems");
  assert.deepEqual(
    items.map((i) => i.attrs.checked),
    [true, false],
  );
  assert.equal(find(doc, "bulletList"), null, "no bulletList should remain");
});

test("markdownToProseMirror: numbered checklist -> one taskList, no orderedList (ol phantom regression)", async () => {
  const doc = await markdownToProseMirror("1. [x] a\n2. [ ] b");
  const taskLists = findAll(doc, "taskList");
  assert.equal(taskLists.length, 1, "expected exactly one taskList");
  assert.equal(
    find(doc, "orderedList"),
    null,
    "a numbered checklist must not leave a phantom orderedList",
  );
  assert.deepEqual(
    findAll(doc, "taskItem").map((i) => i.attrs.checked),
    [true, false],
  );
});

test("markdownToProseMirror: a plain numbered list stays an orderedList", async () => {
  const doc = await markdownToProseMirror("1. a\n2. b");
  assert.ok(find(doc, "orderedList"), "plain numbered list should be an orderedList");
  assert.equal(find(doc, "taskList"), null, "plain numbered list must not become a taskList");
});

test("markdownToProseMirror: mark/sub/sup produce highlight, subscript, superscript marks", async () => {
  const doc = await markdownToProseMirror("<mark>h</mark> <sub>x</sub> <sup>y</sup>");
  const marks = collectMarkTypes(doc);
  assert.ok(marks.has("highlight"), "expected a highlight mark");
  assert.ok(marks.has("subscript"), "expected a subscript mark");
  assert.ok(marks.has("superscript"), "expected a superscript mark");
});

test("markdownToProseMirror: an aligned GFM table maps header alignment", async () => {
  const doc = await markdownToProseMirror(
    "| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |",
  );
  const headers = findAll(doc, "tableHeader");
  assert.equal(headers.length, 3, "expected three header cells");
  assert.deepEqual(
    headers.map((h) => h.attrs.align),
    ["left", "center", "right"],
  );
});

// Comment-body data-loss guard (#228 review #4): markdownToProseMirror is reused
// for COMMENT bodies (createComment/updateComment), so it must NOT canonicalize —
// a comment may legitimately carry a standalone footnote definition with no
// matching reference, and canonicalization would drop the whole list (the text
// would vanish). The page-write variant DOES canonicalize.
test("markdownToProseMirror (comment path) PRESERVES a reference-less footnote definition", async () => {
  const md = "A comment.\n\n[^1]: a standalone footnote definition";
  const doc = await markdownToProseMirror(md);
  const defs = findAll(doc, "footnoteDefinition");
  assert.equal(defs.length, 1, "the footnote definition must be preserved");
  assert.match(
    JSON.stringify(doc),
    /a standalone footnote definition/,
    "the definition text must survive the comment write path",
  );
});

test("markdownToProseMirrorCanonical (page path) DROPS a reference-less footnote definition", async () => {
  // Same input through the PAGE variant: with no reference, the canonical doc has
  // no footnotesList (this is the page-side behavior the comment path must avoid).
  const md = "A page.\n\n[^1]: a standalone footnote definition";
  const doc = await markdownToProseMirrorCanonical(md);
  assert.equal(findAll(doc, "footnotesList").length, 0);
  assert.equal(findAll(doc, "footnoteDefinition").length, 0);
});

test("markdownToProseMirrorCanonical still canonicalizes a real page footnote (order)", async () => {
  // Page path must STILL canonicalize: refs b,a -> definitions reorder to b,a.
  const md = "See[^b] then[^a].\n\n[^a]: alpha\n[^b]: bravo";
  const doc = await markdownToProseMirrorCanonical(md);
  const defs = findAll(doc, "footnoteDefinition").map((d) => d.attrs.id);
  assert.deepEqual(defs, ["b", "a"]);
  assert.equal(findAll(doc, "footnotesList").length, 1);
});
