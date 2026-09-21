// #502: the two layered markdown extensions (`$…$` math, schemeless fuzzy
// autolink) are decided PER CALLER of the shared write importer, not hardcoded in
// the wrapper — because the callers need OPPOSITE behavior:
//   - AGENT-authored plain markdown (updatePageMarkdown, patch_node/insert_node)
//     -> extensions OFF: a `$…$` config span stays literal, a bare `www.host` is
//     not autolinked, an explicit `https://…` still links.
//   - FULL-FILE round-trip import (import_page_markdown, #328 lossless) ->
//     DEFAULTS (extensions ON): an exported math node's `$x^2$` re-imports AS a
//     math node, so the export→import pair is NOT broken.
// This unit file pins the importer contract at each of those semantics. The
// caller-WIRING (that each client method passes the right options) is pinned by
// the collab-backed test in mock/write-path-extensions-wiring.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToProseMirrorCanonical } from "../../build/lib/collaboration.js";
import { importMarkdownFragment } from "../../build/lib/markdown-fragment.js";
import {
  markdownToProseMirror,
  convertProseMirrorToMarkdown,
} from "@docmost/prosemirror-markdown";

const OFF = { parseMath: false, fuzzyLinkify: false };

function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) findAll(c, type, acc);
  return acc;
}
function allText(node, acc = []) {
  if (!node || typeof node !== "object") return acc.join("");
  if (node.type === "text" && typeof node.text === "string") acc.push(node.text);
  if (Array.isArray(node.content)) for (const c of node.content) allText(c, acc);
  return acc.join("");
}
function hasLink(node) {
  return findAll(node, "text").some((t) => t.marks?.some((m) => m.type === "link"));
}

// --- AGENT-write semantics (updatePageMarkdown): extensions OFF -----------------

test("agent-write importer (OFF): `$…$` config stays literal, no math node", async () => {
  const doc = await markdownToProseMirrorCanonical("export A=$FOO and B=$BAR done", OFF);
  assert.equal(findAll(doc, "mathInline").length, 0);
  assert.equal(allText(doc), "export A=$FOO and B=$BAR done");
});

test("agent-write importer (OFF): schemeless www NOT linked; explicit https STILL linked", async () => {
  const bare = await markdownToProseMirrorCanonical("see www.example.com here", OFF);
  assert.equal(hasLink(bare), false);
  assert.equal(allText(bare), "see www.example.com here");

  const explicit = await markdownToProseMirrorCanonical("see https://example.com here", OFF);
  assert.equal(hasLink(explicit), true);
});

test("agent-write importer (OFF): heading + list structure preserved", async () => {
  const doc = await markdownToProseMirrorCanonical("## Heading\n\n- one\n- two", OFF);
  assert.equal(findAll(doc, "heading").length, 1);
  assert.equal(findAll(doc, "bulletList").length, 1);
});

test("fragment importer (patch_node/insert_node) is OFF: `$x=1$` literal, https links", async () => {
  const { blocks } = await importMarkdownFragment("cfg $x=1$ and https://ex.com");
  const doc = { type: "doc", content: blocks };
  assert.equal(findAll(doc, "mathInline").length, 0);
  assert.equal(hasLink(doc), true);
  assert.ok(allText(doc).includes("$x=1$"));
});

// --- FULL-FILE import semantics (import_page_markdown): DEFAULTS (math ON) ------

test("import_page_markdown importer (DEFAULTS): `$x^2$` DOES create a math node", async () => {
  // markdownToProseMirrorCanonical WITHOUT options == what import_page_markdown
  // passes. Math must survive (this is the REAL importer, not the package default).
  const doc = await markdownToProseMirrorCanonical("$x^2$");
  assert.equal(findAll(doc, "mathInline").length, 1);
  assert.equal(findAll(doc, "mathInline")[0].attrs.text, "x^2");
});

test("import_page_markdown (DEFAULTS): #328 lossless export->import keeps math (round-trip)", async () => {
  // The exporter serializes a math node as readable `$x^2$`; re-importing through
  // the REAL import_page_markdown importer (markdownToProseMirrorCanonical, no
  // options) must yield a math node again and be byte-stable. Under the BUGGY code
  // (canonical hardcoded parseMath:false) doc2 would be literal text -> this test
  // would REDDEN.
  const source = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "mathInline", attrs: { text: "x^2" } }] }],
  };
  const md1 = convertProseMirrorToMarkdown(source);
  const doc2 = await markdownToProseMirrorCanonical(md1); // real import path, defaults
  assert.equal(findAll(doc2, "mathInline").length, 1, "math survives the round-trip import");
  const md2 = convertProseMirrorToMarkdown(doc2);
  assert.equal(md2, md1, "export is byte-stable across the round-trip");
});

test("import_page_markdown (DEFAULTS): a schemeless www IS autolinked", async () => {
  const doc = await markdownToProseMirrorCanonical("see www.example.com here");
  assert.equal(hasLink(doc), true);
});

// --- Package default importer (editor/file-import/git-sync) is UNCHANGED --------

test("PACKAGE default importer keeps math ON (editor/file/git-sync path)", async () => {
  const doc = await markdownToProseMirror("$x^2$");
  assert.equal(findAll(doc, "mathInline").length, 1);
});
