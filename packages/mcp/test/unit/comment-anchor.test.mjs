import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeForMatch,
  findAnchorInBlock,
  canAnchorInDoc,
  applyAnchorInDoc,
  countAnchorMatches,
  getAnchoredText,
  resolveAnchorSelection,
} from "../../build/lib/comment-anchor.js";

const COMMENT_ID = "cmt-123";

/** Find the (single) comment mark on a node, or null. */
function commentMark(node) {
  const marks = Array.isArray(node.marks) ? node.marks : [];
  return marks.find((m) => m && m.type === "comment") || null;
}

/** Build a one-paragraph doc with the given inline content array. */
function paragraphDoc(content) {
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

test("normalizeForMatch maps a normalized char to its first raw index in a whitespace run", () => {
  const { norm, map } = normalizeForMatch("a  b"); // two spaces collapse to one
  assert.equal(norm, "a b");
  // norm[1] is the single space; it maps to the FIRST raw whitespace (index 1).
  assert.equal(map[1], 1);
  assert.equal(map[2], 3); // 'b' is at raw index 3
});

test("simple single-text-node match inserts the comment mark with correct id", () => {
  const doc = paragraphDoc([{ type: "text", text: "Hello brave world" }]);
  const ok = applyAnchorInDoc(doc, "brave", COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  // "Hello " | "brave" | " world"
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, "Hello ");
  assert.equal(commentMark(parts[0]), null);
  assert.equal(parts[1].text, "brave");
  const m = commentMark(parts[1]);
  assert.ok(m, "marked fragment carries a comment mark");
  assert.equal(m.attrs.commentId, COMMENT_ID);
  assert.equal(m.attrs.resolved, false);
  assert.equal(parts[2].text, " world");
  assert.equal(commentMark(parts[2]), null);
});

test("match spanning two adjacent plain text nodes preserves base marks", () => {
  const doc = paragraphDoc([
    { type: "text", text: "запуска ", marks: [{ type: "italic" }] },
    { type: "text", text: "перед блоком", marks: [{ type: "italic" }] },
  ]);
  const ok = applyAnchorInDoc(doc, "запуска перед", COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  // "запуска " (marked) | "перед" (marked) | " блоком" (after)
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, "запуска ");
  assert.equal(parts[1].text, "перед");
  assert.equal(parts[2].text, " блоком");

  // Marked fragments keep the italic base mark AND get exactly one comment mark.
  for (const p of [parts[0], parts[1]]) {
    assert.ok(p.marks.some((m) => m.type === "italic"));
    const cm = p.marks.filter((m) => m.type === "comment");
    assert.equal(cm.length, 1);
    assert.equal(cm[0].attrs.commentId, COMMENT_ID);
  }
  // The trailing fragment keeps its italic mark and has no comment mark.
  assert.ok(parts[2].marks.some((m) => m.type === "italic"));
  assert.equal(commentMark(parts[2]), null);
});

test("match across an inline-code boundary preserves the code mark on the middle fragment", () => {
  const doc = paragraphDoc([
    { type: "text", text: "run " },
    { type: "text", text: "qemu", marks: [{ type: "code" }] },
    { type: "text", text: " now" },
  ]);
  const ok = applyAnchorInDoc(doc, "run qemu now", COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  // All three nodes are fully inside the match -> three marked fragments.
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, "run ");
  assert.equal(parts[1].text, "qemu");
  assert.equal(parts[2].text, " now");

  // Every fragment carries exactly one comment mark.
  for (const p of parts) {
    const cm = p.marks.filter((m) => m.type === "comment");
    assert.equal(cm.length, 1);
    assert.equal(cm[0].attrs.commentId, COMMENT_ID);
  }
  // The middle fragment retains its code mark.
  assert.ok(parts[1].marks.some((m) => m.type === "code"));
});

test("normalization matches smart quotes / em-dash / nbsp / collapsed spaces", () => {
  // Document uses « », an em-dash, a non-breaking space, and a double space.
  const docText = "He said «hello world»  —  done";
  const doc = paragraphDoc([{ type: "text", text: docText }]);

  // Selection typed with ASCII quotes, single spaces and a hyphen.
  const selection = '"hello world" - done';
  assert.equal(canAnchorInDoc(doc, selection), true);

  const ok = applyAnchorInDoc(doc, selection, COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  const marked = parts.filter((p) => commentMark(p));
  assert.equal(marked.length, 1);
  // The marked raw text starts at the « and ends at the trailing "done".
  assert.ok(marked[0].text.startsWith("«hello"));
  assert.ok(marked[0].text.endsWith("done"));
});

test("canAnchorInDoc/applyAnchorInDoc fail (and do not mutate) when selection absent", () => {
  const doc = paragraphDoc([{ type: "text", text: "Hello brave world" }]);
  const snapshot = JSON.stringify(doc);

  assert.equal(canAnchorInDoc(doc, "missing text"), false);
  assert.equal(applyAnchorInDoc(doc, "missing text", COMMENT_ID), false);
  // Document is unchanged after a failed apply.
  assert.equal(JSON.stringify(doc), snapshot);
});

test("before/after fragments retain original marks; marked has exactly one comment mark", () => {
  const doc = paragraphDoc([
    { type: "text", text: "abc def ghi", marks: [{ type: "bold" }] },
  ]);
  const ok = applyAnchorInDoc(doc, "def", COMMENT_ID);
  assert.equal(ok, true);

  const parts = doc.content[0].content;
  assert.equal(parts.length, 3);
  // before "abc " and after " ghi" keep the bold mark, no comment mark.
  assert.deepEqual(parts[0].marks, [{ type: "bold" }]);
  assert.deepEqual(parts[2].marks, [{ type: "bold" }]);
  // marked "def" keeps bold and has exactly one comment mark.
  assert.ok(parts[1].marks.some((m) => m.type === "bold"));
  assert.equal(parts[1].marks.filter((m) => m.type === "comment").length, 1);
});

test("findAnchorInBlock returns child/offset descriptor for a multi-node run", () => {
  const blockContent = [
    { type: "text", text: "ab" },
    { type: "text", text: "cdef" },
  ];
  const match = findAnchorInBlock(blockContent, "bcd");
  assert.deepEqual(match, {
    startChild: 0,
    startOffset: 1,
    endChild: 1,
    endOffset: 2,
  });
});

test("a pre-existing comment mark on matched text is replaced (single comment mark)", () => {
  const doc = paragraphDoc([
    {
      type: "text",
      text: "Hello world",
      marks: [{ type: "comment", attrs: { commentId: "old", resolved: false } }],
    },
  ]);
  const ok = applyAnchorInDoc(doc, "Hello world", COMMENT_ID);
  assert.equal(ok, true);
  const parts = doc.content[0].content;
  assert.equal(parts.length, 1);
  const cm = parts[0].marks.filter((m) => m.type === "comment");
  assert.equal(cm.length, 1);
  assert.equal(cm[0].attrs.commentId, COMMENT_ID);
});

test("anchoring works inside a nested block (e.g. list item) via DFS recursion", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "nested target here" }],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(canAnchorInDoc(doc, "target"), true);
  const ok = applyAnchorInDoc(doc, "target", COMMENT_ID);
  assert.equal(ok, true);
  const para =
    doc.content[0].content[0].content[0].content;
  const marked = para.filter((p) => commentMark(p));
  assert.equal(marked.length, 1);
  assert.equal(marked[0].text, "target");
});

// ---------------------------------------------------------------------------
// countAnchorMatches — the uniqueness gate for suggestions. Counts every
// non-overlapping occurrence across the whole document (0 / 1 / N).
// ---------------------------------------------------------------------------
test("countAnchorMatches returns 0 when the selection is absent", () => {
  const doc = paragraphDoc([{ type: "text", text: "hello world" }]);
  assert.equal(countAnchorMatches(doc, "missing"), 0);
});

test("countAnchorMatches returns 1 for a unique selection", () => {
  const doc = paragraphDoc([{ type: "text", text: "Hello brave world" }]);
  assert.equal(countAnchorMatches(doc, "brave"), 1);
});

test("countAnchorMatches counts multiple occurrences within one block", () => {
  const doc = paragraphDoc([{ type: "text", text: "ab ab ab" }]);
  assert.equal(countAnchorMatches(doc, "ab"), 3);
});

test("countAnchorMatches sums occurrences across separate blocks", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "first target here" }] },
      { type: "paragraph", content: [{ type: "text", text: "second target here" }] },
    ],
  };
  assert.equal(countAnchorMatches(doc, "target"), 2);
});

test("countAnchorMatches counts a match spanning adjacent text nodes as one", () => {
  const doc = paragraphDoc([
    { type: "text", text: "запуска ", marks: [{ type: "italic" }] },
    { type: "text", text: "перед блоком", marks: [{ type: "italic" }] },
  ]);
  assert.equal(countAnchorMatches(doc, "запуска перед"), 1);
});

test("countAnchorMatches counts matches inside nested (recursed) blocks", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "outer target" }] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "nested target" }] },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(countAnchorMatches(doc, "target"), 2);
});

test("countAnchorMatches applies the same normalization as anchoring", () => {
  // Smart quotes in the doc match ASCII quotes in the selection.
  const doc = paragraphDoc([{ type: "text", text: "say “hi” now" }]);
  assert.equal(countAnchorMatches(doc, '"hi"'), 1);
});

// #494 — countAnchorMatches now delegates its exact-wins/strip-fallback DECISION
// to the single resolver (resolveAnchorSelection) instead of a parallel copy.
// This parity test REDDENS if the two ever disagree about whether — and in which
// form — a selection anchors (e.g. if countAnchorMatches stops using the resolver
// and the fallback logic drifts).
test("#494: countAnchorMatches and resolveAnchorSelection agree across a corpus", () => {
  const doc = paragraphDoc([
    { type: "text", text: "say “hi” now and **bold** and plain hi" },
  ]);
  const corpus = [
    '"hi"', // strip/normalize fallback (smart quotes)
    "**bold**", // markdown-strip fallback (anchors as "bold")
    "hi", // raw, multiple occurrences
    "absent-string", // anchors nowhere
    "plain hi", // raw, unique
  ];
  for (const sel of corpus) {
    const count = countAnchorMatches(doc, sel);
    const { found, selection: effective } = resolveAnchorSelection(doc, sel);
    // found iff at least one match; and when found, the count is exactly the raw
    // occurrence count of the resolver's WINNING form.
    assert.equal(count > 0, found, `presence disagreement for ${JSON.stringify(sel)}`);
    if (found) {
      // Re-count the resolved form directly and require equality (proves the
      // count is derived from the resolver's chosen form, not a parallel path).
      assert.equal(
        count,
        countAnchorMatches(doc, effective),
        `count/resolver form disagreement for ${JSON.stringify(sel)}`,
      );
    }
  }
});

// -----------------------------------------------------------------------------
// getAnchoredText: returns the RAW document substring the mark would cover (the
// doc's original typographic characters), not the normalized ASCII selection.
// This is what makes a suggestion's stored selection equal the apply-time
// expectedText, so the strict equality in replaceYjsMarkedText holds.
// -----------------------------------------------------------------------------
test("getAnchoredText returns the RAW (typographic) doc substring for an ASCII selection", () => {
  // Doc holds smart quotes; agent selection is the ASCII form.
  const doc = paragraphDoc([{ type: "text", text: "he said “hello” loudly" }]);
  assert.equal(getAnchoredText(doc, '"hello"'), "“hello”");
});

test("getAnchoredText undoes whitespace/dash normalization to the raw span", () => {
  // Em-dash + nbsp in the doc; ASCII hyphen + single space in the selection.
  const doc = paragraphDoc([{ type: "text", text: "a—b c" }]);
  // selection "a-b c" (ascii dash) matches, raw substring keeps the em-dash+nbsp.
  assert.equal(getAnchoredText(doc, "a-b c"), "a—b c");
});

test("getAnchoredText spans consecutive text nodes and returns their raw slices", () => {
  const doc = paragraphDoc([
    { type: "text", text: "Hello " },
    { type: "text", text: "“brave”", marks: [{ type: "bold" }] },
    { type: "text", text: " world" },
  ]);
  assert.equal(getAnchoredText(doc, '"brave" wor'), "“brave” wor");
});

test("getAnchoredText returns null when the selection does not anchor", () => {
  const doc = paragraphDoc([{ type: "text", text: "hello world" }]);
  assert.equal(getAnchoredText(doc, "not present"), null);
});

// ---------------------------------------------------------------------------
// #408 MARKDOWN-STRIP FALLBACK. A selection copied with inline markdown still
// carries `**`/`` ` ``/`[t](u)` markers the plain document text lacks. When the
// verbatim selection anchors nowhere, all four entry points retry with the
// markdown stripped — consistently, so the suggestion-uniqueness gate stays
// coherent — while what gets STORED remains the raw document substring.
// ---------------------------------------------------------------------------
test("a markdown-styled selection anchors against plain doc text via the strip fallback", () => {
  const doc = paragraphDoc([{ type: "text", text: "a bold word here" }]);
  // The agent quoted "**bold** word" from a styled view; the doc is plain text.
  const sel = "**bold** word";
  const resolved = resolveAnchorSelection(doc, sel);
  assert.equal(resolved.found, true, "strip fallback finds the anchor");
  assert.equal(resolved.normalized, true, "reports the soft-warning flag");
  assert.equal(canAnchorInDoc(doc, sel), true);
  assert.equal(countAnchorMatches(doc, sel), 1);

  const ok = applyAnchorInDoc(doc, sel, COMMENT_ID);
  assert.equal(ok, true);
  const marked = doc.content[0].content.filter((p) => commentMark(p));
  assert.equal(marked.map((m) => m.text).join(""), "bold word",
    "the mark lands on the plain-text span");
});

test("getAnchoredText stores the RAW doc substring even when matched via the strip fallback", () => {
  // Doc uses a smart apostrophe; the agent typed ASCII + markdown emphasis.
  const doc = paragraphDoc([{ type: "text", text: "it’s bold now" }]);
  const stored = getAnchoredText(doc, "it's **bold**");
  assert.equal(stored, "it’s bold",
    "stored selection is the raw document text, not the stripped/ASCII locator");
});

test("the strip fallback does not flip a raw-unique selection to ambiguous", () => {
  // "config" appears twice, but the raw phrase "config value" appears once.
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "the config value here" }] },
      { type: "paragraph", content: [{ type: "text", text: "another config here" }] },
    ],
  };
  // Raw phrase is unique -> exactly 1, and no strip happens (nothing to strip).
  assert.equal(countAnchorMatches(doc, "config value"), 1);
  assert.equal(resolveAnchorSelection(doc, "config value").normalized, false);
});

test("EXACT WINS: a raw match short-circuits the strip fallback (count reflects raw)", () => {
  // A literal "**" run exists raw once; its stripped form would also appear.
  const doc = paragraphDoc([{ type: "text", text: "use **stars** and stars" }]);
  // Raw "**stars**" occurs once -> count 1 from the verbatim locator; the
  // fallback (which would find two "stars") never runs.
  assert.equal(countAnchorMatches(doc, "**stars**"), 1);
  assert.equal(resolveAnchorSelection(doc, "**stars**").normalized, false);
});

test("a markdown selection whose stripped form is ambiguous is counted as ambiguous", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "first config here" }] },
      { type: "paragraph", content: [{ type: "text", text: "second config here" }] },
    ],
  };
  // Verbatim "**config**" matches nothing; stripped "config" matches twice.
  assert.equal(countAnchorMatches(doc, "**config**"), 2);
});
