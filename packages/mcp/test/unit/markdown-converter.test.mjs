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

  // Block children of a list item are blank-line separated (loose list) since
  // the #351 converter fix; the sublist stays nested at the 2-col marker column.
  assert.equal(
    convertProseMirrorToMarkdown(input),
    "- Parent\n\n  - A\n  - B\n  - C",
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

  // Blank-line separated block children (loose list) per the #351 converter fix.
  assert.equal(
    convertProseMirrorToMarkdown(input),
    "1. Parent\n\n   - Child",
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

test("table cell with two block children falls back to a raw HTML table", () => {
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

  // A pipe-table cell cannot represent two block children, so the canonical
  // converter emits the whole table as raw HTML (lossless) rather than lossily
  // flattening the paragraphs into one cell.
  assert.equal(
    convertProseMirrorToMarkdown(input),
    "<table><tbody><tr><td><p>a|b</p><p>c</p></td></tr></tbody></table>",
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

test("textAlign is carried in a trailing attached-comment directive (JSON-encoded, safe)", () => {
  const input = doc({
    type: "paragraph",
    attrs: { textAlign: 'right"><b' },
    content: [text("body")],
  });

  // #293 canon #9: paragraph textAlign has no native markdown syntax, so it is
  // attached as a trailing `<!--attrs {json}-->` comment on the block. The value
  // is JSON-encoded, so a hostile value (`"`, `<`, `>`) is carried verbatim and
  // inert — it cannot break out of the comment.
  assert.equal(
    convertProseMirrorToMarkdown(input),
    'body <!--attrs {"textAlign":"right\\"><b"}-->',
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

// Image captions (issue #221 / #293 canon #8). An image WITHOUT a caption stays
// the plain `![alt](src)`; WITH a caption (or any other non-src attr) the extra
// attrs ride in a trailing `<!--img {json}-->` discriminator comment on the
// markdown image form, so the round-trip md -> json restores them.
test("image without a caption emits plain ![alt](src)", () => {
  const input = doc({
    type: "image",
    attrs: { src: "/files/a.png", alt: "cat" },
  });
  assert.equal(convertProseMirrorToMarkdown(input), "![cat](/files/a.png)");
});

test("image with a caption emits ![alt](src) plus an <!--img--> directive", () => {
  const input = doc({
    type: "image",
    attrs: { src: "/files/a.png", alt: "cat", caption: "A grey cat" },
  });
  assert.equal(
    convertProseMirrorToMarkdown(input),
    '![cat](/files/a.png) <!--img {"caption":"A grey cat"}-->',
  );
});

test("image caption is JSON-encoded in the <!--img--> directive (& and \" safe)", () => {
  const input = doc({
    type: "image",
    attrs: { src: "/files/a.png", caption: 'Tom & "Jerry"' },
  });
  assert.equal(
    convertProseMirrorToMarkdown(input),
    '![](/files/a.png) <!--img {"caption":"Tom & \\"Jerry\\""}-->',
  );
});
