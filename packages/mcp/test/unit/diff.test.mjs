import { test } from "node:test";
import assert from "node:assert/strict";

import { diffDocs, summarizeChange } from "../../build/lib/diff.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const para = (...children) => ({ type: "paragraph", content: children });
const doc = (...children) => ({ type: "doc", content: children });

// ---------------------------------------------------------------------------
// Core diff: one inserted word
// ---------------------------------------------------------------------------
test("diffDocs detects a single inserted word", () => {
  const oldDoc = doc(para(t("Hello world")));
  const newDoc = doc(para(t("Hello brave world")));
  const r = diffDocs(oldDoc, newDoc);

  assert.ok(r.summary.inserted > 0, "reports insertion length");
  assert.equal(r.summary.deleted, 0, "no deletions");
  const ins = r.changes.find((c) => c.op === "insert");
  assert.ok(ins, "has an insert change");
  assert.match(ins.text, /brave/);
  assert.match(r.markdown, /inserted/);
});

// ---------------------------------------------------------------------------
// Core diff: one deleted block
// ---------------------------------------------------------------------------
test("diffDocs detects a deleted block", () => {
  const oldDoc = doc(para(t("keep this")), para(t("remove this block")));
  const newDoc = doc(para(t("keep this")));
  const r = diffDocs(oldDoc, newDoc);

  assert.ok(r.summary.deleted > 0, "reports deletion length");
  const del = r.changes.find((c) => c.op === "delete");
  assert.ok(del, "has a delete change");
  assert.match(del.text, /remove this block/);
});

// ---------------------------------------------------------------------------
// Integrity counts
// ---------------------------------------------------------------------------
test("diffDocs reports integrity counts as [old,new] tuples", () => {
  const link = [{ type: "link", attrs: { href: "http://x" } }];
  const image = { type: "image", attrs: { src: "/api/files/a.png" } };
  const callout = {
    type: "callout",
    attrs: { type: "info" },
    content: [para(t("note"))],
  };
  const codeBlock = {
    type: "codeBlock",
    attrs: { language: "js" },
    content: [t("const a = 1;")],
  };

  const oldDoc = doc(
    para(t("a link", link)),
    image,
    callout,
    codeBlock,
    para(t("body with [1] and [2]")),
  );
  // new doc: drop the image AND the code block, drop one footnote marker,
  // keep link + callout.
  const newDoc = doc(
    para(t("a link", link)),
    callout,
    para(t("body with [1]")),
  );

  const r = diffDocs(oldDoc, newDoc);
  assert.deepEqual(r.integrity.images, [1, 0]);
  assert.deepEqual(r.integrity.links, [1, 1]);
  assert.deepEqual(r.integrity.callouts, [1, 1]);
  assert.deepEqual(r.integrity.tables, [0, 0]);
  // codeBlock canary: a vanished code block shows up as [1, 0].
  assert.deepEqual(r.integrity.codeBlocks, [1, 0]);
  // footnote markers parsed in reading order from the body.
  assert.deepEqual(r.integrity.footnoteMarkers, [[1, 2], [1]]);
  // ...and the markdown summary carries the codeBlocks line.
  assert.match(r.markdown, /- codeBlocks: 1 -> 0/);
});

// ---------------------------------------------------------------------------
// #600: a GAINED code block is counted exactly like a gained table — the guard
// is a count delta in BOTH directions, not a loss-only detector.
// ---------------------------------------------------------------------------
test("diffDocs counts an ADDED codeBlock (0 -> 1), like a table", () => {
  const table = {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [{ type: "tableCell", content: [para(t("cell"))] }],
      },
    ],
  };
  const oldDoc = doc(para(t("А можно сделать вот так:")));
  const newDoc = doc(
    para(t("А можно сделать вот так:")),
    { type: "codeBlock", attrs: { language: "c" }, content: [t("int x = 1;")] },
    table,
  );
  const r = diffDocs(oldDoc, newDoc);

  assert.deepEqual(r.integrity.codeBlocks, [0, 1]);
  assert.deepEqual(r.integrity.tables, [0, 1]);
  assert.match(r.markdown, /- codeBlocks: 0 -> 1/);
});

// ---------------------------------------------------------------------------
// #600: a doc that KEEPS its code blocks must not move the counter (no false
// positive on an ordinary text edit around the code).
// ---------------------------------------------------------------------------
test("diffDocs keeps codeBlocks steady when only prose around them changes", () => {
  const code = (src) => ({
    type: "codeBlock",
    attrs: { language: "c" },
    content: [t(src)],
  });
  const oldDoc = doc(para(t("before")), code("int x = 1;"), code("int y = 2;"));
  const newDoc = doc(para(t("before, edited")), code("int x = 1;"), code("int y = 2;"));
  const r = diffDocs(oldDoc, newDoc);

  assert.deepEqual(r.integrity.codeBlocks, [2, 2], "both code blocks survive");
  assert.ok(r.summary.inserted > 0, "the prose edit is still reported as text");
  assert.match(r.markdown, /- codeBlocks: 2 -> 2/);
});

// ---------------------------------------------------------------------------
// #600 (issue item 5): diagram atoms (drawio / excalidraw) are data carriers
// whose whole payload lives in attrs — deleting one moves no prose and no marks,
// leaving only the 1-char leaf placeholder an atom contributes to the text delta
// (indistinguishable from a typo fix). The count is what NAMES the loss. They
// are counted as TWO kinds, not one bucket — see the cross-kind swap test below.
// ---------------------------------------------------------------------------
test("diffDocs counts drawio/excalidraw as separate integrity kinds", () => {
  const drawio = {
    type: "drawio",
    attrs: { src: "/api/files/d.svg", attachmentId: "d1" },
  };
  const excalidraw = {
    type: "excalidraw",
    attrs: { src: "/api/files/e.svg", attachmentId: "e1" },
  };
  // The excalidraw sits INSIDE a callout: countNodes must walk the whole tree,
  // not just doc.content (drawioCreate can anchor a diagram inside a callout or
  // a table cell, so a container-nested diagram is a real shape, and a
  // top-level-only walk would silently un-guard it).
  const callout = {
    type: "callout",
    attrs: { type: "info" },
    content: [para(t("see the sketch")), excalidraw],
  };
  const oldDoc = doc(para(t("architecture")), drawio, callout);
  // The drawio diagram silently vanishes; the prose and the callout are untouched.
  const newDoc = doc(para(t("architecture")), callout);

  const r = diffDocs(oldDoc, newDoc);
  assert.deepEqual(r.integrity.drawio, [1, 0], "the lost drawio is counted");
  assert.deepEqual(r.integrity.excalidraw, [1, 1], "the excalidraw survived");
  assert.match(r.markdown, /- drawio: 1 -> 0/);
  assert.match(r.markdown, /- excalidraw: 1 -> 1/);
  // Nothing else moved: the loss is unnamed by every OTHER integrity kind,
  // which is exactly why it needs its own counter.
  assert.deepEqual(r.integrity.images, [0, 0]);
  assert.deepEqual(r.integrity.codeBlocks, [0, 0]);
});

// A drawio swapped for an excalidraw: a single "diagrams" BUCKET would report
// this as `1 -> 1` (clean) and omit it from the write report entirely, hiding a
// destroyed diagram behind a same-cardinality total. Two keys name it.
test("diffDocs names a drawio->excalidraw swap (a bucket would report 1 -> 1)", () => {
  const oldDoc = doc(
    para(t("architecture")),
    { type: "drawio", attrs: { src: "/api/files/d.svg", attachmentId: "d1" } },
  );
  const newDoc = doc(
    para(t("architecture")),
    { type: "excalidraw", attrs: { src: "/api/files/e.svg", attachmentId: "e1" } },
  );

  const r = diffDocs(oldDoc, newDoc);
  assert.deepEqual(r.integrity.drawio, [1, 0], "the drawio is gone");
  assert.deepEqual(r.integrity.excalidraw, [0, 1], "an excalidraw took its place");
  assert.match(r.markdown, /- drawio: 1 -> 0/);
  assert.match(r.markdown, /- excalidraw: 0 -> 1/);
});

// ---------------------------------------------------------------------------
// #619: block-atom DATA CARRIERS. Each is a top-level block whose whole payload
// lives in attrs (src/attachmentId/sourcePageId/…). Deleting one moves no prose
// and no marks — only the 1-char leaf placeholder an atom contributes to the
// text delta (indistinguishable from a typo fix). The count is what NAMES the
// loss. They get SEPARATE counters (never a "media"/"embeds" bucket) — see the
// cross-kind substitution tests below.
// ---------------------------------------------------------------------------

// Per-type minimal, schema-valid nodes for the 12 carriers, keyed by the
// integrity key. transclusionSource is the only one with required content.
const carrier = {
  attachment: { type: "attachment", attrs: { url: "http://x/f.zip", name: "f.zip" } },
  video: { type: "video", attrs: { src: "http://x/v.mp4" } },
  audio: { type: "audio", attrs: { src: "http://a.mp3" } },
  pdf: { type: "pdf", attrs: { src: "http://p.pdf" } },
  embed: { type: "embed", attrs: { src: "http://e", provider: "iframe" } },
  youtube: { type: "youtube", attrs: { src: "http://y/watch" } },
  htmlEmbed: { type: "htmlEmbed", attrs: { source: "<b>hi</b>", height: 200 } },
  mathBlock: { type: "mathBlock", attrs: { text: "x^2" } },
  pageEmbed: { type: "pageEmbed", attrs: { sourcePageId: "p1" } },
  subpages: { type: "subpages" },
  transclusionSource: {
    type: "transclusionSource",
    attrs: { id: "s1" },
    content: [para(t("shared"))],
  },
  transclusionReference: {
    type: "transclusionReference",
    attrs: { sourcePageId: "p1", transclusionId: "s1" },
  },
};

for (const [key, node] of Object.entries(carrier)) {
  test(`diffDocs counts a lost ${key} block atom (1 -> 0) and names it`, () => {
    const oldDoc = doc(para(t("keep this prose")), node);
    const newDoc = doc(para(t("keep this prose")));
    const r = diffDocs(oldDoc, newDoc);

    assert.deepEqual(
      r.integrity[key],
      [1, 0],
      `the vanished ${key} must be counted`,
    );
    assert.match(
      r.markdown,
      new RegExp(`- ${key}: 1 -> 0`),
      `markdown names the lost ${key}`,
    );
  });

  test(`diffDocs counts a gained ${key} block atom (0 -> 1)`, () => {
    const oldDoc = doc(para(t("keep this prose")));
    const newDoc = doc(para(t("keep this prose")), node);
    const r = diffDocs(oldDoc, newDoc);

    assert.deepEqual(r.integrity[key], [0, 1], `the added ${key} is counted`);
    assert.match(r.markdown, new RegExp(`- ${key}: 0 -> 1`));
  });
}

// A video swapped for an audio: a single "media" BUCKET would report this as
// `1 -> 1` (clean) and omit it from the write report entirely, hiding a
// destroyed carrier behind a same-cardinality total. Separate keys name it, and
// BOTH show up in summarizeChange's structure delta.
test("diffDocs names a video->audio swap (a media bucket would report 1 -> 1)", () => {
  const oldDoc = doc(para(t("clip")), carrier.video);
  const newDoc = doc(para(t("clip")), carrier.audio);
  const r = diffDocs(oldDoc, newDoc);

  assert.deepEqual(r.integrity.video, [1, 0], "the video is gone");
  assert.deepEqual(r.integrity.audio, [0, 1], "an audio took its place");
  assert.match(r.markdown, /- video: 1 -> 0/);
  assert.match(r.markdown, /- audio: 0 -> 1/);

  const rep = summarizeChange(oldDoc, newDoc);
  assert.deepEqual(rep.structure.video, [1, 0], "structure names the lost video");
  assert.deepEqual(rep.structure.audio, [0, 1], "structure names the new audio");
});

// embed vs youtube are distinct schema node types (not one "embeds" bucket).
test("diffDocs names an embed->youtube swap (both are distinct kinds)", () => {
  const oldDoc = doc(para(t("iframe")), carrier.embed);
  const newDoc = doc(para(t("iframe")), carrier.youtube);
  const r = diffDocs(oldDoc, newDoc);

  assert.deepEqual(r.integrity.embed, [1, 0]);
  assert.deepEqual(r.integrity.youtube, [0, 1]);
  assert.match(r.markdown, /- embed: 1 -> 0/);
  assert.match(r.markdown, /- youtube: 0 -> 1/);
});

// transclusionSource vs transclusionReference stay distinct: a bucket would hide
// a source (that carries live content) being downgraded to a bare reference.
test("diffDocs names a transclusionSource->transclusionReference swap", () => {
  const oldDoc = doc(para(t("doc")), carrier.transclusionSource);
  const newDoc = doc(para(t("doc")), carrier.transclusionReference);
  const r = diffDocs(oldDoc, newDoc);

  assert.deepEqual(r.integrity.transclusionSource, [1, 0]);
  assert.deepEqual(r.integrity.transclusionReference, [0, 1]);
  assert.match(r.markdown, /- transclusionSource: 1 -> 0/);
  assert.match(r.markdown, /- transclusionReference: 0 -> 1/);

  const rep = summarizeChange(oldDoc, newDoc);
  assert.deepEqual(rep.structure.transclusionSource, [1, 0]);
  assert.deepEqual(rep.structure.transclusionReference, [0, 1]);
});

// ---------------------------------------------------------------------------
// Footnote markers stop at the notes heading
// ---------------------------------------------------------------------------
test("diffDocs footnote markers ignore the notes section", () => {
  const oldDoc = doc(
    para(t("body [1]")),
    { type: "heading", attrs: { level: 2 }, content: [t("Примечания переводчика")] },
    {
      type: "orderedList",
      content: [
        { type: "listItem", content: [para(t("note [1] inside list"))] },
      ],
    },
  );
  const r = diffDocs(oldDoc, oldDoc);
  // Only the body [1] is counted, not the [1] inside the notes list.
  assert.deepEqual(r.integrity.footnoteMarkers, [[1], [1]]);
  assert.equal(r.summary.inserted, 0);
  assert.equal(r.summary.deleted, 0);
});

// ---------------------------------------------------------------------------
// Bug 3: links integrity counts UNIQUE links by href, not link-bearing runs.
// A single link split across two runs (link+bold, then link) is one link.
// ---------------------------------------------------------------------------
test("diffDocs counts a link split across two runs as one link", () => {
  const link = [{ type: "link", attrs: { href: "http://x" } }];
  const linkBold = [
    { type: "link", attrs: { href: "http://x" } },
    { type: "bold" },
  ];
  // One logical link to http://x rendered as two adjacent runs.
  const splitDoc = doc(para(t("see ", linkBold), t("the link", link), t(" here")));
  // Same single href represented as a single run.
  const wholeDoc = doc(para(t("see the link", link), t(" here")));

  const r = diffDocs(splitDoc, wholeDoc);
  // Unique-by-href: both sides have exactly one distinct link.
  assert.deepEqual(r.integrity.links, [1, 1]);
});

test("diffDocs counts two distinct hrefs as two links", () => {
  const a = [{ type: "link", attrs: { href: "http://a" } }];
  const b = [{ type: "link", attrs: { href: "http://b" } }];
  const oldDoc = doc(para(t("one", a), t(" two", b)));
  // new doc drops the second link.
  const newDoc = doc(para(t("one", a), t(" two")));
  const r = diffDocs(oldDoc, newDoc);
  assert.deepEqual(r.integrity.links, [2, 1]);
});

// ---------------------------------------------------------------------------
// Identical docs produce no changes
// ---------------------------------------------------------------------------
test("diffDocs on identical docs reports no changes", () => {
  const d = doc(para(t("unchanged")));
  const r = diffDocs(d, d);
  assert.equal(r.changes.length, 0);
  assert.equal(r.summary.blocksChanged, 0);
});
