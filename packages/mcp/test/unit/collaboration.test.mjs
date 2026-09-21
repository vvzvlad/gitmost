import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCollabWsUrl,
  markdownToProseMirror,
  markdownToProseMirrorCanonical,
  buildYDoc,
  applyDocToFragment,
  assertYjsEncodable,
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
// for COMMENT bodies (createComment/updateComment), so it must NOT canonicalize.
// Under the #293 canon, footnotes are INLINE (`^[body]`), so a comment can no
// longer carry a reference-less definition to be dropped — but the comment path
// must still (a) leave a legacy reference-style `[^id]:` line as harmless literal
// TEXT (never silently deleted) and (b) preserve an inline footnote it does
// contain (no canonicalization stripping it). The page-write variant canonicalizes.
test("markdownToProseMirror (comment path) keeps a legacy `[^id]:` line as literal text", async () => {
  // A reference-style `[^1]:` line is not canonical footnote syntax anymore, so it
  // is not parsed into a footnote node — but its TEXT must survive verbatim (no
  // data loss on the comment write path).
  const md = "A comment.\n\n[^1]: a standalone footnote definition";
  const doc = await markdownToProseMirror(md);
  assert.equal(
    findAll(doc, "footnoteDefinition").length,
    0,
    "reference-style line is not a footnote node",
  );
  assert.match(
    JSON.stringify(doc),
    /a standalone footnote definition/,
    "the text must survive the comment write path",
  );
});

test("markdownToProseMirror (comment path) PRESERVES an inline footnote (no canonicalization)", async () => {
  // An inline `^[body]` footnote in a comment imports to a real footnote node and
  // is NOT dropped: the comment path must never canonicalize away content.
  const md = "A comment.\n\n^[an inline footnote]";
  const doc = await markdownToProseMirror(md);
  assert.equal(findAll(doc, "footnoteDefinition").length, 1);
  assert.equal(findAll(doc, "footnotesList").length, 1);
  assert.match(JSON.stringify(doc), /an inline footnote/);
});

// ---------------------------------------------------------------------------
// Schema-forbidden marks (the July code-block data-loss incident). The docmost
// codeBlock spec declares `marks: ""`, but PMNode.fromJSON does NOT validate
// marks against parent specs, so a doc carrying a comment mark inside a
// codeBlock used to slide through applyDocToFragment into the live Y.Doc —
// where the next schema-full client materialization made y-prosemirror DELETE
// the whole codeBlock. Both write paths must now reject such a doc loudly.
// ---------------------------------------------------------------------------

/** A paragraph + codeBlock doc; `poison` adds a comment mark inside the code. */
function codeBlockDoc(poison) {
  const codeText = poison
    ? [
        { type: "text", text: "static bool " },
        {
          type: "text",
          text: "s_dirty_seen",
          marks: [{ type: "comment", attrs: { commentId: "c1", resolved: false } }],
        },
        { type: "text", text: " = false;" },
      ]
    : [{ type: "text", text: "static bool s_dirty_seen = false;" }];
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "codeBlock", attrs: { language: "c" }, content: codeText },
    ],
  };
}

test("applyDocToFragment rejects a comment mark inside a codeBlock (names node, mark, preview)", () => {
  const ydoc = buildYDoc(codeBlockDoc(false));
  assert.throws(
    () => applyDocToFragment(ydoc, codeBlockDoc(true)),
    (e) => {
      assert.match(e.message, /codeBlock/, "names the forbidding parent type");
      assert.match(e.message, /comment/, "names the offending mark type");
      assert.match(e.message, /s_dirty_seen/, "quotes the child text preview");
      return true;
    },
  );
});

test("assertYjsEncodable rejects the same poisoned doc (preview/apply parity)", () => {
  assert.throws(
    () => assertYjsEncodable(codeBlockDoc(true)),
    (e) => {
      assert.match(e.message, /codeBlock/);
      assert.match(e.message, /comment/);
      return true;
    },
  );
});

test("a clean codeBlock doc passes both write-path validations", () => {
  assert.doesNotThrow(() => assertYjsEncodable(codeBlockDoc(false)));
  const ydoc = buildYDoc(codeBlockDoc(false));
  const edited = codeBlockDoc(false);
  edited.content[0].content[0].text = "before (edited)";
  assert.doesNotThrow(() => applyDocToFragment(ydoc, edited));
});

test("a comment mark in a PARAGRAPH is still accepted (guard is not over-broad)", () => {
  const d = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "anchored prose",
            marks: [{ type: "comment", attrs: { commentId: "c2", resolved: false } }],
          },
        ],
      },
    ],
  };
  assert.doesNotThrow(() => assertYjsEncodable(d));
});

test("markdownToProseMirrorCanonical (page path) yields a single reference-ordered list", async () => {
  // Page path produces the canonical footnote topology: one trailing
  // `footnotesList`, definitions in FIRST-REFERENCE order, ids assigned
  // sequentially. Inline `^[body]` footnotes carry the body at the reference
  // point, so the bottom list is inherently reference-ordered.
  const md = "See^[bravo] then^[alpha].";
  const doc = await markdownToProseMirrorCanonical(md);
  const defs = findAll(doc, "footnoteDefinition");
  assert.deepEqual(
    defs.map((d) => d.attrs.id),
    ["fn-1", "fn-2"],
  );
  assert.equal(findAll(doc, "footnotesList").length, 1);
  // Bodies stay in reference order (bravo referenced before alpha).
  assert.match(JSON.stringify(defs[0]), /bravo/);
  assert.match(JSON.stringify(defs[1]), /alpha/);
});
