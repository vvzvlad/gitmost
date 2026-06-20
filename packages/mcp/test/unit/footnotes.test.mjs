import { test } from "node:test";
import assert from "node:assert/strict";

import { convertProseMirrorToMarkdown } from "../../build/lib/markdown-converter.js";
import { markdownToProseMirror } from "../../build/lib/collaboration.js";

/** Recursively collect every node of `type`. */
function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) {
    for (const c of node.content) findAll(c, type, acc);
  }
  return acc;
}

const footnoteDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Water" },
        { type: "footnoteReference", attrs: { id: "fn1" } },
        { type: "text", text: " and clay" },
        { type: "footnoteReference", attrs: { id: "fn2" } },
        { type: "text", text: "." },
      ],
    },
    {
      type: "footnotesList",
      content: [
        {
          type: "footnoteDefinition",
          attrs: { id: "fn1" },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "First note." }] },
          ],
        },
        {
          type: "footnoteDefinition",
          attrs: { id: "fn2" },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Second note." }] },
          ],
        },
      ],
    },
  ],
};

test("JSON -> Markdown emits pandoc footnote syntax", () => {
  const md = convertProseMirrorToMarkdown(footnoteDoc);
  assert.match(md, /\[\^fn1\]/);
  assert.match(md, /\[\^fn2\]/);
  assert.match(md, /\[\^fn1\]: First note\./);
  assert.match(md, /\[\^fn2\]: Second note\./);
});

test("Markdown -> JSON rebuilds footnote nodes", async () => {
  const md = convertProseMirrorToMarkdown(footnoteDoc);
  const json = await markdownToProseMirror(md);

  const refs = findAll(json, "footnoteReference");
  const list = findAll(json, "footnotesList");
  const defs = findAll(json, "footnoteDefinition");

  assert.equal(refs.length, 2);
  assert.deepEqual(
    refs.map((r) => r.attrs.id),
    ["fn1", "fn2"],
  );
  assert.equal(list.length, 1);
  assert.equal(defs.length, 2);
  assert.deepEqual(
    defs.map((d) => d.attrs.id),
    ["fn1", "fn2"],
  );
});

test("JSON -> MD -> JSON preserves footnote ids and text", async () => {
  const md = convertProseMirrorToMarkdown(footnoteDoc);
  const json = await markdownToProseMirror(md);
  const md2 = convertProseMirrorToMarkdown(json);

  // The second markdown serialization carries the same markers + definitions.
  assert.match(md2, /\[\^fn1\]/);
  assert.match(md2, /\[\^fn2\]/);
  assert.match(md2, /\[\^fn1\]: First note\./);
  assert.match(md2, /\[\^fn2\]: Second note\./);
});

test("duplicate-id markdown dedups DETERMINISTICALLY (same input -> same ids)", async () => {
  // The MCP import must derive duplicate ids deterministically (NOT random) so
  // the same markdown imported here and via the editor produces identical ids,
  // and re-importing is stable. This is the test that would FAIL on the old
  // Math.random()/Date.now() implementation.
  const md = [
    "See[^d] one[^d] two[^d].",
    "",
    "[^d]: first",
    "[^d]: second",
    "[^d]: third",
  ].join("\n");

  const idsOf = async () => {
    const json = await markdownToProseMirror(md);
    const refs = findAll(json, "footnoteReference").map((r) => r.attrs.id);
    const defs = findAll(json, "footnoteDefinition").map((d) => d.attrs.id);
    return { refs, defs };
  };

  const a = await idsOf();
  const b = await idsOf();

  // Identical across runs.
  assert.deepEqual(a.refs, b.refs);
  assert.deepEqual(a.defs, b.defs);
  // Deterministic derived scheme: keeper "d", duplicates "d__2", "d__3".
  assert.deepEqual([...a.defs].sort(), ["d", "d__2", "d__3"]);
  // 1:1 reference <-> definition pairing, all distinct.
  assert.equal(new Set(a.defs).size, 3);
  assert.deepEqual([...a.refs].sort(), [...a.defs].sort());
});

test("a [^id]: line inside a fenced code block is NOT treated as a definition", async () => {
  // Markdown that DOCUMENTS footnote syntax inside a code fence. The example
  // definition line must be preserved verbatim inside the code block and not
  // pulled out into a real footnotesList / footnoteDefinition.
  const md = [
    "Intro text.",
    "",
    "```markdown",
    "Body[^demo]",
    "",
    "[^demo]: example definition",
    "```",
    "",
    "Outro.",
  ].join("\n");

  const json = await markdownToProseMirror(md);

  // No real footnote nodes were extracted from the code block.
  assert.equal(findAll(json, "footnotesList").length, 0);
  assert.equal(findAll(json, "footnoteDefinition").length, 0);

  // The example definition line survives somewhere in the code block text.
  const codeBlocks = findAll(json, "codeBlock");
  assert.ok(codeBlocks.length >= 1, "code block present");
  const codeText = JSON.stringify(json);
  assert.match(codeText, /\[\^demo\]: example definition/);
});
