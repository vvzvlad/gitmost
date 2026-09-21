import { test } from "node:test";
import assert from "node:assert/strict";

import { searchInDoc } from "../../build/lib/page-search.js";
import { getNodeByRef } from "@docmost/prosemirror-markdown";

// ---------------------------------------------------------------------------
// Document builders. Mirror the Docmost ProseMirror shape: paragraphs/headings
// carry an attrs.id and hold text nodes; a text node may carry marks, and
// adjacent runs with different marks are GLUED by blockPlainText so a match can
// straddle a mark boundary. Table cells hold id-less paragraphs.
// ---------------------------------------------------------------------------

const text = (t, marks) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const para = (id, ...children) => ({ type: "paragraph", attrs: { id }, content: children });
const heading = (id, level, t) => ({
  type: "heading",
  attrs: { id, level },
  content: [text(t)],
});

function doc(...content) {
  return { type: "doc", content };
}

test("literal substring: finds every occurrence with total/truncated and refs", () => {
  const d = doc(
    para("p1", text("The cat sat on the cat mat.")),
    heading("h1", 2, "Another cat here"),
  );
  const res = searchInDoc(d, "cat");
  assert.equal(res.total, 3);
  assert.equal(res.truncated, false);
  assert.equal(res.matches.length, 3);
  // First hit: paragraph p1, block index 0.
  assert.equal(res.matches[0].nodeId, "p1");
  assert.equal(res.matches[0].blockIndex, 0);
  assert.equal(res.matches[0].type, "paragraph");
  assert.equal(res.matches[0].match, "cat");
  // Third hit is in the heading (block index 1).
  assert.equal(res.matches[2].nodeId, "h1");
  assert.equal(res.matches[2].blockIndex, 1);
  assert.equal(res.matches[2].type, "heading");
});

test("context windows: before/after are drawn from the SAME container", () => {
  const d = doc(para("p1", text("alpha beta gamma delta")));
  const res = searchInDoc(d, "gamma");
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].before, "alpha beta ");
  assert.equal(res.matches[0].match, "gamma");
  assert.equal(res.matches[0].after, " delta");
});

test("context windows are bounded to ~40 chars each side", () => {
  const long = "x".repeat(100);
  const d = doc(para("p1", text(long + "NEEDLE" + long)));
  const res = searchInDoc(d, "NEEDLE");
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].before.length, 40);
  assert.equal(res.matches[0].after.length, 40);
});

test("case-insensitive by default; caseSensitive:true narrows", () => {
  const d = doc(para("p1", text("Cat CAT cat")));
  assert.equal(searchInDoc(d, "cat").total, 3);
  assert.equal(searchInDoc(d, "cat", { caseSensitive: true }).total, 1);
  // Reported match preserves the ORIGINAL casing even under a folded search.
  const res = searchInDoc(d, "cat");
  assert.deepEqual(
    res.matches.map((m) => m.match),
    ["Cat", "CAT", "cat"],
  );
});

test("match survives an inline mark boundary (glued runs)", () => {
  // "т.е." is fractured across three text nodes by bold/italic marks.
  const d = doc(
    para(
      "p1",
      text("вводное слово, "),
      text("т", [{ type: "bold" }]),
      text(".", [{ type: "italic" }]),
      text("е", [{ type: "bold" }]),
      text(". дальше"),
    ),
  );
  const res = searchInDoc(d, "т.е.");
  assert.equal(res.total, 1);
  assert.equal(res.matches[0].match, "т.е.");
  assert.equal(res.matches[0].nodeId, "p1");
});

test("regex engine: character classes and word boundaries", () => {
  const d = doc(para("p1", text("v1 v22 version v3")));
  const res = searchInDoc(d, "\\bv\\d+\\b", { regex: true });
  assert.deepEqual(
    res.matches.map((m) => m.match),
    ["v1", "v22", "v3"],
  );
  // "version" is not matched by \bv\d+\b.
  assert.equal(res.total, 3);
});

test("regex is case-insensitive by default and respects caseSensitive", () => {
  const d = doc(para("p1", text("Foo foo FOO")));
  assert.equal(searchInDoc(d, "foo", { regex: true }).total, 3);
  assert.equal(
    searchInDoc(d, "foo", { regex: true, caseSensitive: true }).total,
    1,
  );
});

test("regex empty/zero-length matches are skipped, not flooded", () => {
  const d = doc(para("p1", text("abc")));
  // `a*` can match the empty string at every position; we must not emit those.
  const res = searchInDoc(d, "a*", { regex: true });
  assert.equal(res.total, 1);
  assert.equal(res.matches[0].match, "a");
});

test("nodeId for a table cell paragraph WITHOUT an id falls back to #<topLevelIndex>", () => {
  // A table at top-level block index 1; its cell paragraphs carry no attrs.id.
  const cellPara = (t) => ({ type: "paragraph", content: [text(t)] });
  const d = doc(
    para("intro", text("before the table")),
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [cellPara("needle in a cell")] },
            { type: "tableHeader", content: [cellPara("another needle")] },
          ],
        },
      ],
    },
  );
  const res = searchInDoc(d, "needle");
  assert.equal(res.total, 2);
  // Both cell hits report the table's top-level #<index> (block 1) since the
  // cell paragraphs have no id.
  for (const m of res.matches) {
    assert.equal(m.nodeId, "#1");
    assert.equal(m.blockIndex, 1);
  }
  // Context is scoped to the specific cell, not the whole table's glued text.
  assert.equal(res.matches[0].after, " in a cell");
  assert.equal(res.matches[1].before, "another ");
});

test("nodeId uses attrs.id when the container has one (paragraph & heading)", () => {
  const d = doc(heading("h9", 1, "heading needle"), para("p9", text("para needle")));
  const res = searchInDoc(d, "needle");
  assert.equal(res.matches[0].nodeId, "h9");
  assert.equal(res.matches[1].nodeId, "p9");
});

test("limit caps the returned matches but total and truncated stay honest", () => {
  const d = doc(para("p1", text("x ".repeat(10).trim()))); // 10 'x'
  const res = searchInDoc(d, "x", { limit: 3 });
  assert.equal(res.total, 10);
  assert.equal(res.matches.length, 3);
  assert.equal(res.truncated, true);
});

test("limit is clamped to the [1, 200] range", () => {
  const d = doc(para("p1", text("a".repeat(5))));
  // A limit above the ceiling still returns all 5 (< 200) without truncation.
  const hi = searchInDoc(d, "a", { limit: 9999 });
  assert.equal(hi.matches.length, 5);
  assert.equal(hi.truncated, false);
  // A non-positive limit clamps up to 1.
  const lo = searchInDoc(d, "a", { limit: 0 });
  assert.equal(lo.matches.length, 1);
  assert.equal(lo.total, 5);
  assert.equal(lo.truncated, true);
});

test("invalid regex throws a clear tool error", () => {
  const d = doc(para("p1", text("hi")));
  assert.throws(
    () => searchInDoc(d, "(", { regex: true }),
    /invalid or unsupported regular expression/i,
  );
});

test("RE2: a catastrophic-backtracking pattern completes FAST and correctly (no ReDoS)", () => {
  // (a+)+$ against a long run of 'a' followed by a non-'a' is the classic
  // catastrophic-backtracking case that wedges the JS RegExp engine for
  // seconds/forever. Under RE2 (linear time) it returns effectively instantly.
  const d = doc(para("p1", text("a".repeat(50_000) + "b")));
  const t0 = Date.now();
  const res = searchInDoc(d, "(a+)+$", { regex: true });
  const elapsed = Date.now() - t0;
  // No '$'-anchored all-'a' run exists (there's a trailing 'b'), so no match.
  assert.equal(res.total, 0);
  assert.equal(res.matches.length, 0);
  // Generous ceiling: the JS engine would take orders of magnitude longer.
  assert.ok(elapsed < 1000, `expected fast completion, took ${elapsed}ms`);
});

test("RE2: catastrophic pattern that DOES match still completes fast and finds it", () => {
  // (a+)+b matches the whole "aaa…b"; RE2 finds it in linear time.
  const d = doc(para("p1", text("a".repeat(20_000) + "b")));
  const t0 = Date.now();
  const res = searchInDoc(d, "(a+)+b", { regex: true });
  const elapsed = Date.now() - t0;
  assert.equal(res.total, 1);
  assert.equal(res.matches[0].match, "a".repeat(20_000) + "b");
  assert.ok(elapsed < 1000, `expected fast completion, took ${elapsed}ms`);
});

test("RE2: unsupported lookaround/backreference patterns yield the clear unsupported-regex error", () => {
  const d = doc(para("p1", text("hello")));
  // Lookahead / lookbehind / backreference are backtracking-only features RE2
  // rejects at compile time — a clean tool error, never a hang.
  assert.throws(
    () => searchInDoc(d, "foo(?=bar)", { regex: true }),
    /invalid or unsupported regular expression/i,
  );
  assert.throws(
    () => searchInDoc(d, "(?<=foo)bar", { regex: true }),
    /invalid or unsupported regular expression/i,
  );
  assert.throws(
    () => searchInDoc(d, "(a)\\1", { regex: true }),
    /invalid or unsupported regular expression/i,
  );
});

test("F3 round-trip: every match's nodeId resolves through the REAL getNodeByRef consumer", () => {
  // A doc mixing an attrs.id paragraph and an id-less table-cell paragraph, so
  // both ref formats (block id and "#<index>") are exercised end-to-end.
  const cellPara = (t) => ({ type: "paragraph", content: [text(t)] });
  const d = doc(
    para("intro", text("find needle here")), // attrs.id ref -> "intro"
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [cellPara("cell needle")] }, // id-less -> "#1"
          ],
        },
      ],
    },
  );
  const res = searchInDoc(d, "needle");
  assert.equal(res.total, 2);

  // Match 0: an attrs.id ref must resolve to that exact paragraph.
  assert.equal(res.matches[0].nodeId, "intro");
  const byId = getNodeByRef(d, res.matches[0].nodeId);
  assert.ok(byId, "attrs.id ref must resolve via getNodeByRef");
  assert.equal(byId.type, "paragraph");
  assert.equal(byId.node.attrs.id, "intro");

  // Match 1: an id-less table cell falls back to the table's "#<index>", which
  // getNodeByRef resolves to the TOP-LEVEL block (the table) by index.
  assert.equal(res.matches[1].nodeId, "#1");
  const byIndex = getNodeByRef(d, res.matches[1].nodeId);
  assert.ok(byIndex, "#<index> ref must resolve via getNodeByRef");
  assert.equal(byIndex.type, "table");
});

test("F4: before/after are pinned correctly at string edges (clamp not dropped)", () => {
  // Match within the first CONTEXT (40) chars of a container LONGER than
  // CONTEXT: before is only the chars that exist, never a negative-index slice.
  const head = doc(para("p1", text("ab NEEDLE" + "x".repeat(100))));
  const r1 = searchInDoc(head, "NEEDLE");
  assert.equal(r1.matches.length, 1);
  assert.equal(r1.matches[0].before, "ab ");
  assert.equal(r1.matches[0].after.length, 40); // plenty of trailing 'x'

  // Match at index 0: before is empty.
  const atStart = doc(para("p1", text("NEEDLE tail")));
  const r2 = searchInDoc(atStart, "NEEDLE");
  assert.equal(r2.matches[0].before, "");
  assert.equal(r2.matches[0].after, " tail");

  // Match at the container END: after is empty.
  const atEnd = doc(para("p1", text("lead NEEDLE")));
  const r3 = searchInDoc(atEnd, "NEEDLE");
  assert.equal(r3.matches[0].before, "lead ");
  assert.equal(r3.matches[0].after, "");
});

test("empty or whitespace-only query is rejected", () => {
  const d = doc(para("p1", text("hi")));
  assert.throws(() => searchInDoc(d, ""), /query is empty/i);
  assert.throws(() => searchInDoc(d, "   "), /query is empty/i);
  assert.throws(() => searchInDoc(d, undefined), /query is empty/i);
});

test("an over-long pattern is rejected (anti-ReDoS pattern cap)", () => {
  const d = doc(para("p1", text("hi")));
  assert.throws(() => searchInDoc(d, "a".repeat(1001)), /too long/i);
});

test("no matches yields an empty, non-truncated result", () => {
  const d = doc(para("p1", text("nothing to see")));
  const res = searchInDoc(d, "zebra");
  assert.deepEqual(res, { total: 0, truncated: false, matches: [] });
});

test("null-safe on a missing/empty doc", () => {
  assert.deepEqual(searchInDoc(null, "x"), {
    total: 0,
    truncated: false,
    matches: [],
  });
  assert.deepEqual(searchInDoc({ type: "doc" }, "x"), {
    total: 0,
    truncated: false,
    matches: [],
  });
});
