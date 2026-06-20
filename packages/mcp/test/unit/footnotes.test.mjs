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
