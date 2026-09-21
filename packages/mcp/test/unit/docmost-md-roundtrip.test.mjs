import { test } from "node:test";
import assert from "node:assert/strict";

import {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
} from "../../build/lib/markdown-document.js";
import * as Y from "yjs";
import { convertProseMirrorToMarkdown } from "../../build/lib/markdown-converter.js";
import {
  markdownToProseMirror,
  applyDocToFragment,
} from "../../build/lib/collaboration.js";
import { TiptapTransformer } from "@hocuspocus/transformer";

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

/** Find the first text node carrying a mark of the given type. */
function findTextWithMark(node, markType) {
  for (const t of findAll(node, "text")) {
    if (Array.isArray(t.marks) && t.marks.some((m) => m.type === markType)) {
      return t;
    }
  }
  return null;
}

test("serialize/parse: meta and comments survive a round-trip; body recovered", () => {
  const meta = {
    version: 1,
    pageId: "p1",
    slugId: "s1",
    title: "Hello",
    spaceId: "sp1",
    parentPageId: null,
  };
  const body = "# Title\n\nSome **bold** body text.";
  const comments = [
    { id: "c1", content: "a note", resolved: false },
    { id: "c2", content: "another", resolved: true },
  ];

  const full = serializeDocmostMarkdown(meta, body, comments);
  const parsed = parseDocmostMarkdown(full);

  assert.deepEqual(parsed.meta, meta);
  assert.deepEqual(parsed.comments, comments);
  assert.equal(parsed.body, body);
});

test("serialize: a page with no comments still emits an empty comments block", () => {
  const full = serializeDocmostMarkdown({ version: 1 }, "body", []);
  assert.match(full, /<!--\s*docmost:comments\s*\n\[\]\n-->/);
  const parsed = parseDocmostMarkdown(full);
  assert.deepEqual(parsed.comments, []);
});

test("parse: plain markdown with no blocks -> meta=null, comments=null, body=input", () => {
  const input = "  # Just a heading\n\nplain body  ";
  const parsed = parseDocmostMarkdown(input);
  assert.equal(parsed.meta, null);
  assert.equal(parsed.comments, null);
  assert.equal(parsed.body, input.trim());
});

test("parse: tolerant to CRLF line endings", () => {
  const meta = { version: 1, pageId: "p9" };
  const body = "line one\n\nline two";
  const full = serializeDocmostMarkdown(meta, body, []).replace(/\n/g, "\r\n");
  const parsed = parseDocmostMarkdown(full);
  assert.deepEqual(parsed.meta, meta);
  assert.deepEqual(parsed.comments, []);
  assert.equal(parsed.body, body);
});

test("parse: a malformed present meta block throws a clear error", () => {
  const bad = "<!-- docmost:meta\n{not valid json}\n-->\n\nbody\n";
  assert.throws(() => parseDocmostMarkdown(bad), /docmost:meta JSON/);
});

test("parse: a literal comments-block in the body is left in the body when a real trailing block follows", () => {
  // The body documents the format (e.g. inside a fenced code block) AND there is
  // a real trailing comments block. Only the final, document-ending block is
  // metadata; the literal stays in the body verbatim.
  const meta = { version: 1, pageId: "p-literal" };
  const literal = "```\n<!-- docmost:comments\n[1]\n-->\n```";
  const body = `# Doc\n\nExample of the format:\n\n${literal}`;
  const realComments = [{ id: "c1", content: "real" }];

  const full = serializeDocmostMarkdown(meta, body, realComments);
  const parsed = parseDocmostMarkdown(full);

  // The REAL trailing comments are parsed.
  assert.deepEqual(parsed.comments, realComments);
  // The literal block text is still present in the recovered body.
  assert.ok(
    parsed.body.includes("<!-- docmost:comments\n[1]\n-->"),
    "expected the literal comments block to remain in the body",
  );
  assert.equal(parsed.body, body.trim());
});

test("parse: a body-ending literal comments block (no real trailing block) is treated as the final block", () => {
  // Hand-written file whose ONLY `docmost:comments` opener is a literal that
  // also ends the document. Per the implementation, the final document-ending
  // block IS treated as metadata, so it is parsed and stripped from the body.
  const input = "# Doc\n\nsome text\n\n<!-- docmost:comments\n[1]\n-->\n";
  const parsed = parseDocmostMarkdown(input);
  assert.equal(parsed.meta, null);
  assert.deepEqual(parsed.comments, [1]);
  assert.equal(parsed.body, "# Doc\n\nsome text");
});

test("parse: a literal comments block NOT ending the document stays entirely in the body", () => {
  // The literal opener/closer is followed by more body content, so it does not
  // end the document and is therefore left untouched in the body.
  const input =
    "# Doc\n\n<!-- docmost:comments\n[1]\n-->\n\nmore body after it\n";
  const parsed = parseDocmostMarkdown(input);
  assert.equal(parsed.meta, null);
  assert.equal(parsed.comments, null);
  assert.equal(parsed.body, input.trim());
});

test("export emits comment anchors and they round-trip back to a comment mark", () => {
  // A small ProseMirror doc with a text run carrying a `comment` mark.
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "before " },
          {
            type: "text",
            text: "anchored",
            marks: [{ type: "comment", attrs: { commentId: "cm-123" } }],
          },
          { type: "text", text: " after" },
        ],
      },
    ],
  };

  const body = convertProseMirrorToMarkdown(doc);
  assert.match(body, /data-comment-id="cm-123"/);

  return markdownToProseMirror(body).then((rebuilt) => {
    const commented = findTextWithMark(rebuilt, "comment");
    assert.ok(commented, "expected a text node with a comment mark");
    const mark = commented.marks.find((m) => m.type === "comment");
    assert.equal(mark.attrs.commentId, "cm-123");
  });
});

test("export emits a spoiler span and it round-trips back to a spoiler mark", () => {
  // A small ProseMirror doc with a text run carrying a `spoiler` mark. The MCP
  // schema mirrors the editor-ext mark, so a spoiler must survive json -> md ->
  // json instead of being silently dropped as an unrecognized mark.
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "plot: " },
          {
            type: "text",
            text: "the butler did it",
            marks: [{ type: "spoiler" }],
          },
          { type: "text", text: " end" },
        ],
      },
    ],
  };

  const body = convertProseMirrorToMarkdown(doc);
  assert.match(body, /<span data-spoiler="true">the butler did it<\/span>/);

  return markdownToProseMirror(body).then((rebuilt) => {
    const spoilered = findTextWithMark(rebuilt, "spoiler");
    assert.ok(spoilered, "expected a text node with a spoiler mark");
    assert.equal(spoilered.text, "the butler did it");
  });
});

test("drawio round-trips through export and import", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "drawio",
        attrs: { src: "https://example/diagram.xml", attachmentId: "att-7" },
      },
    ],
  };

  // #293 canon #8: the media family (image/video/audio/drawio/excalidraw)
  // serializes to the markdown image form `![alt](src)` plus a trailing
  // discriminator comment `<!--drawio {json}-->` carrying the non-src attrs.
  const body = convertProseMirrorToMarkdown(doc);
  assert.match(body, /!\[\]\(https:\/\/example\/diagram\.xml\)/);
  assert.match(body, /<!--drawio \{"attachmentId":"att-7"\}-->/);

  return markdownToProseMirror(body).then((rebuilt) => {
    const diagram = find(rebuilt, "drawio");
    assert.ok(diagram, "expected a drawio node after import");
    assert.equal(diagram.attrs.src, "https://example/diagram.xml");
    assert.equal(diagram.attrs.attachmentId, "att-7");
  });
});

// #503: a hardBreak (Shift+Enter) must be REPRESENTABLE end-to-end through the
// MCP canon, not silently cut. The reported symptom was a hardBreak sent via
// updatePageJson vanishing with no error and no line break. This guards all
// three seams of that path at once:
//   1. pm -> md: the serializer emits the CommonMark hard break `  \n` (two
//      trailing spaces), not a bare `\n` (which reimports as a soft break and is
//      lost).
//   2. md -> pm: `  \n` reimports to ONE paragraph carrying text+hardBreak+text
//      (not two paragraphs, break not dropped) — the "непредставим" arm.
//   3. the literal updatePageJson mechanism: PM JSON -> live Yjs fragment via
//      `applyDocToFragment` (PMNode.fromJSON + updateYFragment — the SAME encoder
//      the collab-session write path uses, NOT buildYDoc/toYdoc) -> read back
//      preserves the hardBreak between the two text runs in ONE paragraph.
test("hardBreak survives the MCP canon in BOTH directions (#503)", async () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "line one" },
          { type: "hardBreak" },
          { type: "text", text: "line two" },
        ],
      },
    ],
  };

  // 1. pm -> md: exact CommonMark hard break, not a dropped/soft break.
  const body = convertProseMirrorToMarkdown(doc);
  assert.equal(body, "line one  \nline two");

  // 2. md -> pm: ONE paragraph, text + hardBreak + text preserved (not split).
  const rebuilt = await markdownToProseMirror(body);
  const paras = findAll(rebuilt, "paragraph");
  assert.equal(paras.length, 1, "the break must NOT split the paragraph in two");
  const inline = paras[0].content.map((n) => n.type);
  assert.deepEqual(
    inline,
    ["text", "hardBreak", "text"],
    "the hardBreak must survive the md -> pm import",
  );

  // 2b. byte-fixpoint: a second export is stable (P2).
  assert.equal(convertProseMirrorToMarkdown(rebuilt), body);

  // 3. updatePageJson path: PM JSON -> live Yjs fragment (applyDocToFragment =
  // the real collab write path's PMNode.fromJSON + updateYFragment) -> read back
  // keeps text + hardBreak + text in ONE paragraph.
  const ydoc = new Y.Doc();
  applyDocToFragment(ydoc, doc);
  const fromYjs = TiptapTransformer.fromYdoc(ydoc, "default");
  const yjsParas = findAll(fromYjs, "paragraph");
  assert.equal(
    yjsParas.length,
    1,
    "the Yjs write path must NOT split the paragraph in two",
  );
  assert.deepEqual(
    yjsParas[0].content.map((n) => n.type),
    ["text", "hardBreak", "text"],
    "the hardBreak must survive the updatePageJson (updateYFragment) write path",
  );
});
