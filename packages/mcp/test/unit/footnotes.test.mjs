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

test("JSON -> Markdown emits canonical inline footnote syntax (#293 canon #2)", () => {
  // Canonical markdown form is Pandoc/Obsidian INLINE footnotes: the note body is
  // written at the reference point as `^[body]`. There is NO `[^id]` reference
  // marker and NO trailing `[^id]: …` definition list; the schema id never
  // reaches markdown.
  const md = convertProseMirrorToMarkdown(footnoteDoc);
  assert.match(md, /\^\[First note\.\]/);
  assert.match(md, /\^\[Second note\.\]/);
  assert.doesNotMatch(md, /\[\^/); // no reference-style markers
  assert.doesNotMatch(md, /^\[\^.+\]:/m); // no bottom definition lines
});

test("Markdown -> JSON rebuilds footnote nodes with sequential fn-N ids", async () => {
  const md = convertProseMirrorToMarkdown(footnoteDoc);
  const json = await markdownToProseMirror(md);

  const refs = findAll(json, "footnoteReference");
  const list = findAll(json, "footnotesList");
  const defs = findAll(json, "footnoteDefinition");

  // Structure is preserved; ids are (re)assigned sequentially in first-reference
  // order by the importer (fn-1, fn-2, …) — the concrete id is never carried in
  // markdown, so it is derived on import.
  assert.equal(refs.length, 2);
  assert.deepEqual(
    refs.map((r) => r.attrs.id),
    ["fn-1", "fn-2"],
  );
  assert.equal(list.length, 1);
  assert.equal(defs.length, 2);
  assert.deepEqual(
    defs.map((d) => d.attrs.id),
    ["fn-1", "fn-2"],
  );
});

test("JSON -> MD -> JSON is byte-stable and preserves footnote body text", async () => {
  const md = convertProseMirrorToMarkdown(footnoteDoc);
  const json = await markdownToProseMirror(md);
  const md2 = convertProseMirrorToMarkdown(json);

  // The round trip is byte-stable (ids are not written to markdown, so the
  // concrete import id cannot perturb the output) and the bodies survive.
  assert.equal(md2, md);
  assert.match(md2, /\^\[First note\.\]/);
  assert.match(md2, /\^\[Second note\.\]/);
});

test("identical footnote bodies MERGE to one shared definition (#293 canon #2)", async () => {
  // Two references whose bodies are byte-identical import as ONE definition
  // shared by both references (dedup on the exact body text). Two DIFFERENT
  // bodies stay distinct. Deterministic and stable across re-imports.
  const md = "See^[same] and^[same], but^[other].";

  const idsOf = async () => {
    const json = await markdownToProseMirror(md);
    const refs = findAll(json, "footnoteReference").map((r) => r.attrs.id);
    const defs = findAll(json, "footnoteDefinition");
    return {
      refs,
      defIds: defs.map((d) => d.attrs.id),
      defText: defs
        .map((d) => JSON.stringify(d).match(/"text":"([^"]*)"/)?.[1])
        .join("|"),
    };
  };

  const a = await idsOf();
  const b = await idsOf();

  // Stable across runs.
  assert.deepEqual(a, b);
  // Merge: the two "same" references share fn-1; the "other" reference is fn-2.
  assert.deepEqual(a.refs, ["fn-1", "fn-1", "fn-2"]);
  // One definition per unique body, in first-reference order.
  assert.deepEqual(a.defIds, ["fn-1", "fn-2"]);
  assert.equal(a.defText, "same|other");
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
