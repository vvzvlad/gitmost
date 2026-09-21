// #413: getNode's markdown-default format, its JSON opt-in, the non-top-level
// AUTO fallback to JSON, and comment-anchor preservation (incl. resolved) on the
// markdown read. getNode only reads (getPageRaw), so a lightweight subclass that
// stubs auth + the page fetch is enough — no collab socket needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocmostClient } from "../../build/client.js";

function makeClient(doc) {
  class TestClient extends DocmostClient {
    async ensureAuthenticated() {}
    async getPageRaw(pageId) {
      return { id: pageId, slugId: "s", title: "P", spaceId: "sp", content: doc };
    }
  }
  return new TestClient("http://127.0.0.1:1/api", "e@x.com", "pw");
}

const P = "p1";

test("getNode defaults to markdown for a paragraph", async () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [{ type: "text", text: "hello world" }],
      },
    ],
  };
  const res = await makeClient(doc).getNode(P, "b1");
  assert.equal(res.format, "markdown");
  assert.equal(typeof res.markdown, "string");
  assert.match(res.markdown, /hello world/);
  assert.equal(res.node, undefined, "markdown result carries no raw node");
});

test("getNode format:'json' returns the raw subtree verbatim", async () => {
  const target = {
    type: "paragraph",
    attrs: { id: "b1" },
    content: [{ type: "text", text: "hello" }],
  };
  const doc = { type: "doc", content: [target] };
  const res = await makeClient(doc).getNode(P, "b1", "json");
  assert.equal(res.format, "json");
  assert.deepEqual(res.node, target);
  assert.equal(res.markdown, undefined);
});

test("getNode AUTO-falls back to JSON for a non-top-level type (tableRow via #index)", async () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1 },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "cp" },
                    content: [{ type: "text", text: "x" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  // "#0.0"-style refs are not supported; the whole table is "#0", a row is only
  // reachable by drilling — but a tableRow IS a non-doc-child type. Address the
  // table itself as "#0": a table CAN be a doc child, so markdown is fine there.
  // To hit the fallback, address the row by walking: getNode resolves "#0" to the
  // table (doc child -> markdown). Instead we verify the schema gate directly by
  // asking for the table (markdown) and a row is exercised via the unit test on
  // canBeDocChild; here confirm a table renders as markdown.
  const tableRes = await makeClient(doc).getNode(P, "#0");
  assert.equal(tableRes.format, "markdown", "a table is a doc child -> markdown");

  // Now build a doc whose top-level block IS a tableRow (schematically invalid but
  // exercises the getNode fallback branch): getNode("#0") resolves it and, because
  // tableRow cannot be a doc child, must fall back to JSON.
  const rowDoc = {
    type: "doc",
    content: [
      {
        type: "tableRow",
        content: [
          {
            type: "tableCell",
            attrs: { colspan: 1, rowspan: 1 },
            content: [{ type: "paragraph", content: [{ type: "text", text: "y" }] }],
          },
        ],
      },
    ],
  };
  const rowRes = await makeClient(rowDoc).getNode(P, "#0");
  assert.equal(rowRes.format, "json", "a tableRow cannot be a doc child -> JSON fallback");
  assert.equal(rowRes.type, "tableRow");
  assert.ok(rowRes.node, "the JSON fallback returns the raw subtree");
});

test("getNode(markdown) PRESERVES comment anchors — active and resolved", async () => {
  // A paragraph with two comment marks: one active, one resolved. get_page strips
  // resolved anchors; getNode must NOT (a read for editing/write-back).
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [
          { type: "text", text: "start " },
          {
            type: "text",
            text: "active",
            marks: [{ type: "comment", attrs: { commentId: "cid-active" } }],
          },
          { type: "text", text: " mid " },
          {
            type: "text",
            text: "resolved",
            marks: [
              {
                type: "comment",
                attrs: { commentId: "cid-resolved", resolved: true },
              },
            ],
          },
          { type: "text", text: " end" },
        ],
      },
    ],
  };
  const res = await makeClient(doc).getNode(P, "b1");
  assert.equal(res.format, "markdown");
  assert.match(
    res.markdown,
    /data-comment-id="cid-active"/,
    "the active comment anchor is preserved",
  );
  assert.match(
    res.markdown,
    /data-comment-id="cid-resolved"/,
    "the RESOLVED comment anchor is ALSO preserved (unlike get_page)",
  );
});
