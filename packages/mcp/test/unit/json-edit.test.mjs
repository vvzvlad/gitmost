import { test } from "node:test";
import assert from "node:assert/strict";

import { applyTextEdits } from "../../build/lib/json-edit.js";

// Helpers to build small ProseMirror docs.
const textNode = (text, extra = {}) => ({ type: "text", text, ...extra });
const paragraph = (...children) => ({ type: "paragraph", content: children });
const doc = (...children) => ({ type: "doc", content: children });

test("single-match replace preserves ids/marks and reports replacements===1", () => {
  const input = doc({
    type: "paragraph",
    attrs: { id: "para-1" },
    content: [
      textNode("Hello world", { marks: [{ type: "bold" }] }),
    ],
  });

  const { doc: out, results } = applyTextEdits(input, [
    { find: "world", replace: "there" },
  ]);

  assert.deepEqual(results, [{ find: "world", replacements: 1 }]);

  const para = out.content[0];
  // Paragraph id attribute is preserved.
  assert.equal(para.attrs.id, "para-1");
  const tnode = para.content[0];
  // Text node marks are preserved.
  assert.deepEqual(tnode.marks, [{ type: "bold" }]);
  assert.equal(tnode.text, "Hello there");
});

test("zero match throws not found", () => {
  const input = doc(paragraph(textNode("Hello world")));

  assert.throws(
    () => applyTextEdits(input, [{ find: "absent", replace: "x" }]),
    /not found/,
  );
});

test("text split across two text nodes (one bold) throws spans-multiple-runs", () => {
  // "Hello world" is split: "Hello " (plain) + "world" (bold). No single text
  // node contains "Hello world", but the collected document text does.
  const input = doc(
    paragraph(
      textNode("Hello "),
      textNode("world", { marks: [{ type: "bold" }] }),
    ),
  );

  assert.throws(
    () => applyTextEdits(input, [{ find: "Hello world", replace: "x" }]),
    /spans/,
  );
});

test("multi-match without replaceAll throws matches", () => {
  // "ab" appears twice inside a single text node.
  const input = doc(paragraph(textNode("ab cd ab")));

  assert.throws(
    () => applyTextEdits(input, [{ find: "ab", replace: "x" }]),
    /matches/,
  );
});

test("replaceAll replaces all occurrences", () => {
  const input = doc(
    paragraph(textNode("foo and foo")),
    paragraph(textNode("more foo")),
  );

  const { doc: out, results } = applyTextEdits(input, [
    { find: "foo", replace: "bar", replaceAll: true },
  ]);

  // 2 in the first paragraph, 1 in the second = 3 total.
  assert.deepEqual(results, [{ find: "foo", replacements: 3 }]);
  assert.equal(out.content[0].content[0].text, "bar and bar");
  assert.equal(out.content[1].content[0].text, "more bar");
});

test("replacement containing $&, $1, $$ is inserted LITERALLY (regression)", () => {
  const input = doc(paragraph(textNode("token here")));

  const literal = "price $& cost $1 dollars $$ end";
  const { doc: out } = applyTextEdits(input, [
    { find: "token", replace: literal },
  ]);

  // The replacement must appear verbatim, NOT regex-expanded.
  assert.equal(out.content[0].content[0].text, `${literal} here`);
  // Be explicit that the find text was not re-injected via $&.
  assert.ok(out.content[0].content[0].text.includes("$&"));
  assert.ok(!out.content[0].content[0].text.includes("token"));
});

test("$ patterns are inserted literally under replaceAll too", () => {
  const input = doc(paragraph(textNode("x and x")));

  const { doc: out } = applyTextEdits(input, [
    { find: "x", replace: "$&$1$$", replaceAll: true },
  ]);

  assert.equal(out.content[0].content[0].text, "$&$1$$ and $&$1$$");
});

test("empty replacement prunes the emptied text node", () => {
  // A paragraph whose only text node becomes empty: the node must be pruned.
  const input = doc(
    paragraph(
      textNode("DELETE", { marks: [{ type: "italic" }] }),
      textNode(" kept"),
    ),
  );

  const { doc: out, results } = applyTextEdits(input, [
    { find: "DELETE", replace: "" },
  ]);

  assert.deepEqual(results, [{ find: "DELETE", replacements: 1 }]);
  const para = out.content[0];
  // The emptied first text node is gone; only the " kept" node remains.
  assert.equal(para.content.length, 1);
  assert.equal(para.content[0].text, " kept");
});

test("multi-edit array applied in order", () => {
  const input = doc(paragraph(textNode("alpha beta")));

  const { doc: out, results } = applyTextEdits(input, [
    { find: "alpha", replace: "ALPHA" },
    { find: "beta", replace: "BETA" },
  ]);

  assert.deepEqual(results, [
    { find: "alpha", replacements: 1 },
    { find: "beta", replacements: 1 },
  ]);
  assert.equal(out.content[0].content[0].text, "ALPHA BETA");
});

test("second edit can target text produced by the first (ordered application)", () => {
  const input = doc(paragraph(textNode("one")));

  const { doc: out, results } = applyTextEdits(input, [
    { find: "one", replace: "two" },
    { find: "two", replace: "three" },
  ]);

  assert.deepEqual(results, [
    { find: "one", replacements: 1 },
    { find: "two", replacements: 1 },
  ]);
  assert.equal(out.content[0].content[0].text, "three");
});

test("input doc is not mutated", () => {
  const input = doc(paragraph(textNode("immutable source")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out } = applyTextEdits(input, [
    { find: "immutable", replace: "changed" },
  ]);

  // Original is untouched; the returned doc is a distinct object.
  assert.deepEqual(input, snapshot);
  assert.notEqual(out, input);
  assert.equal(out.content[0].content[0].text, "changed source");
});
