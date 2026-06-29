import { test } from "node:test";
import assert from "node:assert/strict";

import { convertProseMirrorToMarkdown } from "../../build/lib/markdown-converter.js";

// ProseMirror builders.
const text = (t, marks) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const paragraph = (...content) => ({ type: "paragraph", content });
const doc = (...content) => ({ type: "doc", content });
const listItem = (...content) => ({ type: "listItem", content });
const bulletList = (...items) => ({ type: "bulletList", content: items });
const orderedList = (...items) => ({ type: "orderedList", content: items });

test("nested bulletList with 3 children keeps all children indented under the parent", () => {
  const input = doc(
    bulletList(
      listItem(
        paragraph(text("Parent")),
        bulletList(
          listItem(paragraph(text("A"))),
          listItem(paragraph(text("B"))),
          listItem(paragraph(text("C"))),
        ),
      ),
    ),
  );

  assert.equal(
    convertProseMirrorToMarkdown(input),
    "- Parent\n  - A\n  - B\n  - C",
  );
});

test("nested list under an ordered item indents 3 spaces", () => {
  const input = doc(
    orderedList(
      listItem(
        paragraph(text("Parent")),
        bulletList(listItem(paragraph(text("Child")))),
      ),
    ),
  );

  assert.equal(
    convertProseMirrorToMarkdown(input),
    "1. Parent\n   - Child",
  );
});

test("link with title -> [t](url \"title\")", () => {
  const input = doc(
    paragraph(
      text("click", [
        { type: "link", attrs: { href: "https://example.com", title: "the title" } },
      ]),
    ),
  );

  assert.equal(
    convertProseMirrorToMarkdown(input),
    '[click](https://example.com "the title")',
  );
});

test("hardBreak -> trailing two-spaces+newline", () => {
  const input = doc(
    paragraph(text("line1"), { type: "hardBreak" }, text("line2")),
  );

  assert.equal(convertProseMirrorToMarkdown(input), "line1  \nline2");
});

test("table cell with two block children joined by a space (and a pipe escaped)", () => {
  const input = doc({
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          {
            type: "tableCell",
            content: [paragraph(text("a|b")), paragraph(text("c"))],
          },
        ],
      },
    ],
  });

  // Single-column header row + separator. The cell joins its two paragraphs
  // with a space ("a|b c") then escapes the pipe -> "a\|b c".
  assert.equal(
    convertProseMirrorToMarkdown(input),
    "| a\\|b c |\n| --- |",
  );
});

test("code block trailing newline trimmed", () => {
  const input = doc({
    type: "codeBlock",
    attrs: { language: "js" },
    content: [text("const a = 1;\n")],
  });

  // The single trailing newline inside the code is trimmed; fences add one.
  assert.equal(
    convertProseMirrorToMarkdown(input),
    "```js\nconst a = 1;\n```",
  );
});

test("textAlign value: delimiting double-quote escaped (attribute-safe, idempotent; < > left literal/inert)", () => {
  const input = doc({
    type: "paragraph",
    attrs: { textAlign: 'right"><b' },
    content: [text("body")],
  });

  // Attribute values escape only & and " so the value cannot break out of the
  // quoted attribute. < and > are left literal: parse5/jsdom does NOT decode
  // &lt;/&gt; inside attribute values, so escaping them would corrupt the value
  // and accumulate on every round-trip. The literal < > are inert inside quotes.
  assert.equal(
    convertProseMirrorToMarkdown(input),
    '<div align="right&quot;><b">body</div>',
  );
});

test("highlight color: delimiting double-quote escaped (attribute-safe; < > inert, and import sanitizes the color)", () => {
  const input = doc(
    paragraph(
      text("hi", [{ type: "highlight", attrs: { color: 'red"><script' } }]),
    ),
  );

  assert.equal(
    convertProseMirrorToMarkdown(input),
    '<mark style="background-color: red&quot;><script">hi</mark>',
  );
});

test("empty task item still emits its marker", () => {
  const input = doc({
    type: "taskList",
    content: [
      { type: "taskItem", attrs: { checked: false }, content: [] },
      { type: "taskItem", attrs: { checked: true }, content: [] },
    ],
  });

  assert.equal(convertProseMirrorToMarkdown(input), "- [ ]\n- [x]");
});

// Image captions (issue #221). An image WITHOUT a caption stays the lossy-free
// `![alt](src)`; WITH a caption it is emitted as a raw <img data-caption>
// wrapped in a block <div> (symmetric to video) so the round-trip md -> html ->
// json restores the caption via the image extension's parseHTML.
test("image without a caption emits plain ![alt](src)", () => {
  const input = doc({
    type: "image",
    attrs: { src: "/files/a.png", alt: "cat" },
  });
  assert.equal(convertProseMirrorToMarkdown(input), "![cat](/files/a.png)");
});

test("image with a caption emits a raw <img data-caption> in a block div", () => {
  const input = doc({
    type: "image",
    attrs: { src: "/files/a.png", alt: "cat", caption: "A grey cat" },
  });
  assert.equal(
    convertProseMirrorToMarkdown(input),
    '<div><img src="/files/a.png" alt="cat" data-caption="A grey cat"></div>',
  );
});

test("image caption escapes & and \" in the data-caption attribute", () => {
  const input = doc({
    type: "image",
    attrs: { src: "/files/a.png", caption: 'Tom & "Jerry"' },
  });
  assert.equal(
    convertProseMirrorToMarkdown(input),
    '<div><img src="/files/a.png" data-caption="Tom &amp; &quot;Jerry&quot;"></div>',
  );
});
