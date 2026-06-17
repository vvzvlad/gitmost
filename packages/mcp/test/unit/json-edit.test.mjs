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

test("zero match is reported via failed[], doc unchanged", () => {
  const input = doc(paragraph(textNode("Hello world")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "absent", replace: "x" },
  ]);

  assert.deepEqual(results, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /not found/);
  // Doc is structurally unchanged (modulo deep-copy identity).
  assert.deepEqual(out, snapshot);
});

test("text split across two text nodes (one bold) now applies, marks preserved", () => {
  // "Hello world" is split: "Hello " (plain) + "world" (bold). No single text
  // node contains "Hello world", but the block-level matcher spans them.
  const input = doc(
    paragraph(
      textNode("Hello "),
      textNode("world", { marks: [{ type: "bold" }] }),
    ),
  );

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "Hello world", replace: "Hello there" },
  ]);

  assert.deepEqual(results, [{ find: "Hello world", replacements: 1 }]);
  assert.deepEqual(failed, []);

  // The unchanged prefix "Hello " stays plain; the changed region "world" was
  // uniformly bold, so the replacement "there" stays bold.
  const para = out.content[0];
  assert.equal(para.content.length, 2);
  assert.equal(para.content[0].text, "Hello ");
  assert.equal(para.content[0].marks, undefined);
  assert.equal(para.content[1].text, "there");
  assert.deepEqual(para.content[1].marks, [{ type: "bold" }]);
});

test("multi-match without replaceAll is reported via failed[], doc unchanged", () => {
  // "ab" appears twice inside a single text node.
  const input = doc(paragraph(textNode("ab cd ab")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "ab", replace: "x" },
  ]);

  assert.deepEqual(results, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /matches/);
  assert.deepEqual(out, snapshot);
});

test("cross-run replace with mixed marks inherits left-neighbor marks", () => {
  // The matched region "BC" is split: "B" bold, "C" italic — non-uniform marks,
  // and the replacement "X" shares no common prefix/suffix with "BC", so the
  // inserted text inherits the left neighbor's marks. Here the left neighbor of
  // the changed region is "A" (plain), so "X" must be plain.
  const input = doc(
    paragraph(
      textNode("A"),
      textNode("B", { marks: [{ type: "bold" }] }),
      textNode("C", { marks: [{ type: "italic" }] }),
      textNode("D"),
    ),
  );

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "BC", replace: "X" },
  ]);

  assert.deepEqual(results, [{ find: "BC", replacements: 1 }]);
  assert.deepEqual(failed, []);

  // "A" + "X"(plain) + "D" coalesce into a single plain text node "AXD".
  const para = out.content[0];
  assert.equal(para.content.length, 1);
  assert.equal(para.content[0].text, "AXD");
  assert.equal(para.content[0].marks, undefined);
});

test("cross-run replace at block start inherits [] marks", () => {
  // The whole block content is the mixed-mark match "BC" with no left neighbor,
  // so inserted text falls through to the right neighbor / [] (block start).
  const input = doc(
    paragraph(
      textNode("B", { marks: [{ type: "bold" }] }),
      textNode("C", { marks: [{ type: "italic" }] }),
    ),
  );

  const { doc: out, results } = applyTextEdits(input, [
    { find: "BC", replace: "X" },
  ]);

  assert.deepEqual(results, [{ find: "BC", replacements: 1 }]);
  const para = out.content[0];
  assert.equal(para.content.length, 1);
  assert.equal(para.content[0].text, "X");
  assert.equal(para.content[0].marks, undefined);
});

test("partial batch: good edits apply, the bad one goes to failed[]", () => {
  const input = doc(paragraph(textNode("alpha beta gamma")));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "alpha", replace: "ALPHA" },
    { find: "absent", replace: "X" },
    { find: "gamma", replace: "GAMMA" },
  ]);

  // The 2 matching edits applied; the missing one is reported.
  assert.deepEqual(results, [
    { find: "alpha", replacements: 1 },
    { find: "gamma", replacements: 1 },
  ]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].find, "absent");
  assert.match(failed[0].reason, /not found/);
  assert.equal(out.content[0].content[0].text, "ALPHA beta GAMMA");
});

test("a match that crosses an atom is refused, doc unchanged", () => {
  // paragraph: "a" <hardBreak> "b". A find of "a￼b" spans the hardBreak atom,
  // so it is not a valid match: a match range may not contain an atom slot.
  // The edit lands in failed[] (reason: atom-specific OR not-found) and the
  // document is left unchanged.
  const input = doc(
    paragraph(
      textNode("a"),
      { type: "hardBreak" },
      textNode("b"),
    ),
  );
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "a￼b", replace: "z" },
  ]);

  assert.deepEqual(results, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /non-text inline node|not found/);
  assert.deepEqual(out, snapshot);
});

test("a TEXT node containing a literal U+FFFC matches/replaces normally", () => {
  // The U+FFFC OBJECT REPLACEMENT CHARACTER is the placeholder for atom slots,
  // but a real text node may legitimately contain that code unit. Such a slot
  // has no `.atom`, so it must match and replace like any other character —
  // proving atoms and literal-U+FFFC text are distinguished.
  const input = doc(paragraph(textNode("x￼y")));

  const { doc: out, results, failed } = applyTextEdits(input, [
    { find: "x￼y", replace: "done" },
  ]);

  assert.deepEqual(results, [{ find: "x￼y", replacements: 1 }]);
  assert.deepEqual(failed, []);
  assert.equal(out.content[0].content[0].text, "done");
});

test("a no-op edit (find === replace) produces a doc deep-equal to the input", () => {
  // find === replace "applies" but changes nothing: the produced document must
  // be structurally identical to the input (this is what lets the client skip
  // the collaboration write and avoid a spurious history version).
  const input = doc(paragraph(textNode("unchanged text")));
  const snapshot = JSON.parse(JSON.stringify(input));

  const { doc: out, results } = applyTextEdits(input, [
    { find: "unchanged", replace: "unchanged" },
  ]);

  assert.deepEqual(results, [{ find: "unchanged", replacements: 1 }]);
  // Deep-equal to the input despite the edit being reported as applied.
  assert.deepEqual(out, snapshot);
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
