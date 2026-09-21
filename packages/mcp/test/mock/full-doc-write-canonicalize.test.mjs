// Footnote-canonicalization binding tests for the MCP FULL-document write tools
// (issue #228, review #4): updatePageJson and copyPageContent must persist a
// footnote-canonical doc. These override the `replacePage` seam (symmetric to the
// `mutatePage` seam used by the insert-footnote-wrapper test) to capture the
// persisted doc WITHOUT a live Hocuspocus collab socket. Symmetric to the
// server-side focus specs for createPage / updatePage (markdown 'replace').
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocmostClient } from "../../build/client.js";

const para = (...c) => ({ type: "paragraph", content: c });
const ref = (id) => ({ type: "footnoteReference", attrs: { id } });
const def = (id, text) => ({
  type: "footnoteDefinition",
  attrs: { id },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const list = (...d) => ({ type: "footnotesList", content: d });

function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) findAll(c, type, acc);
  return acc;
}
const defIds = (doc) => findAll(doc, "footnoteDefinition").map((d) => d.attrs.id);

function makeClient(sourceDoc) {
  const calls = { replaced: [] };
  class TestClient extends DocmostClient {
    async ensureAuthenticated() {}
    async getCollabTokenWithReauth() {
      return "collab-token";
    }
    async getPageRaw(pageId) {
      return { id: pageId, slugId: "s", title: "P", spaceId: "sp", content: sourceDoc };
    }
    async replacePage(pageId, doc, token, apiUrl) {
      calls.replaced.push({ pageId, doc });
      return { doc, verify: { ok: true } };
    }
    // #647 §G — updatePageJson now writes through the server-side guarded replace;
    // capture the final doc here (symmetric to the old replacePage seam).
    async guardedReplacePage(pageId, content, format, baseHash) {
      calls.replaced.push({ pageId, doc: content, format, baseHash });
      return { applied: true, newHash: "h-new" };
    }
  }
  const client = new TestClient("http://127.0.0.1:1/api", "e@x.com", "pw");
  return { client, calls };
}

test("updatePageJson canonicalizes the persisted full doc (out-of-order -> reference order)", async () => {
  const { client, calls } = makeClient();
  const outOfOrder = {
    type: "doc",
    content: [
      para({ type: "text", text: "x" }, ref("b"), ref("a")),
      list(def("a", "A"), def("b", "B")),
    ],
  };
  await client.updatePageJson("p1", outOfOrder, undefined, "base-hash");
  assert.equal(calls.replaced.length, 1);
  // Definitions reordered to reference order [b, a] before persisting.
  assert.deepEqual(defIds(calls.replaced[0].doc), ["b", "a"]);
  assert.equal(findAll(calls.replaced[0].doc, "footnotesList").length, 1);
});

test("updatePageJson REJECTS a doc carrying a sandbox /api/sb/ src (#629)", async () => {
  const { client, calls } = makeClient();
  // A stashPage publication view (drawio -> image pointing at a RAM-only blob)
  // must never be written back as page content — it would 404 once the TTL laps.
  const stashed = {
    type: "doc",
    content: [
      { type: "image", attrs: { src: "https://sb.test/api/sb/id-0", alt: "diagram" } },
    ],
  };
  await assert.rejects(
    () => client.updatePageJson("p1", stashed),
    /blob sandbox|\/api\/sb\//,
  );
  // Nothing was persisted.
  assert.equal(calls.replaced.length, 0);
});

test("copyPageContent canonicalizes the persisted copy (orphan definition dropped)", async () => {
  const sourceDoc = {
    type: "doc",
    content: [
      para({ type: "text", text: "x" }, ref("a")),
      list(def("a", "A"), def("orphan", "O")),
    ],
  };
  const { client, calls } = makeClient(sourceDoc);
  const res = await client.copyPageContent("src", "dst");
  assert.equal(calls.replaced.length, 1);
  assert.equal(calls.replaced[0].pageId, "dst");
  // The orphan definition is dropped by canonicalization before the copy lands.
  assert.deepEqual(defIds(calls.replaced[0].doc), ["a"]);
  assert.equal(res.success, true);
});
