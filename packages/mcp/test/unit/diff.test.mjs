import { test } from "node:test";
import assert from "node:assert/strict";

import { diffDocs } from "../../build/lib/diff.js";

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

  const oldDoc = doc(
    para(t("a link", link)),
    image,
    callout,
    para(t("body with [1] and [2]")),
  );
  // new doc: drop the image, drop one footnote marker, keep link + callout.
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
  // footnote markers parsed in reading order from the body.
  assert.deepEqual(r.integrity.footnoteMarkers, [[1, 2], [1]]);
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
