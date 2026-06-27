// Wrapper tests for DocmostClient.insertFootnote (issue #228, review #11/#9):
// the page-locked write seam (mutatePage) is overridden so the wrapper's
// transform + response shaping can be exercised WITHOUT a live Hocuspocus collab
// socket. We assert the two guarantees that the pure insertInlineFootnote test
// can NOT prove on its own:
//   - a missing anchor makes the transform throw "anchor text not found" and NO
//     document is persisted (the no-partial-write guarantee), and
//   - a success shapes footnoteId / reused / message / verify and writes a doc
//     carrying the new reference + the derived single list.
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

// A DocmostClient whose auth + page-locked write are stubbed; `mutatePage`
// mirrors collaboration.mutatePageContent (run the transform against a clone of
// the live doc; if it throws, persist NOTHING and rethrow).
function makeClient(liveDoc) {
  const calls = { writes: [] };
  class TestClient extends DocmostClient {
    async ensureAuthenticated() {}
    async getCollabTokenWithReauth() {
      return "collab-token";
    }
    async mutatePage(pageId, token, apiUrl, transform) {
      calls.pageId = pageId;
      calls.token = token;
      const newDoc = transform(structuredClone(liveDoc));
      calls.writes.push(newDoc);
      return { doc: newDoc, verify: { ok: true, marker: "v" } };
    }
  }
  const client = new TestClient("http://127.0.0.1:1/api", "e@x.com", "pw");
  return { client, calls };
}

test("insertFootnote: anchor not found -> throws and persists nothing", async () => {
  const { client, calls } = makeClient({
    type: "doc",
    content: [para({ type: "text", text: "nothing to anchor on" })],
  });
  await assert.rejects(
    () => client.insertFootnote("p1", "ZZZ", "a note"),
    /anchor text not found/i,
  );
  assert.equal(calls.writes.length, 0, "no document may be persisted on a missing anchor");
});

test("insertFootnote: success (new) writes a reference + derived list and shapes the response", async () => {
  const { client, calls } = makeClient({
    type: "doc",
    content: [para({ type: "text", text: "The sky is blue today." })],
  });
  const res = await client.insertFootnote("p1", "blue", "Rayleigh scattering.");
  assert.equal(res.success, true);
  assert.equal(res.modified, true);
  assert.equal(res.pageId, "p1");
  assert.equal(res.reused, false);
  assert.equal(typeof res.footnoteId, "string");
  assert.ok(res.footnoteId.length > 0);
  assert.equal(res.message, "Footnote inserted.");
  assert.deepEqual(res.verify, { ok: true, marker: "v" });
  assert.equal(calls.writes.length, 1, "exactly one write persisted");
  assert.equal(findAll(calls.writes[0], "footnoteReference").length, 1);
  assert.equal(findAll(calls.writes[0], "footnotesList").length, 1);
  assert.equal(calls.pageId, "p1");
});

test("insertFootnote: success (reused) reuses the existing definition and reports it", async () => {
  const liveDoc = {
    type: "doc",
    content: [
      para({ type: "text", text: "Alpha and beta." }, ref("a")),
      list(def("a", "shared note")),
    ],
  };
  const { client, calls } = makeClient(liveDoc);
  const res = await client.insertFootnote("p1", "beta", "shared note");
  assert.equal(res.reused, true);
  assert.equal(res.footnoteId, "a");
  assert.match(res.message, /reused an existing same-content definition/i);
  // Still exactly one definition (the reused one), two references to it.
  assert.equal(findAll(calls.writes[0], "footnoteDefinition").length, 1);
  assert.equal(findAll(calls.writes[0], "footnoteReference").length, 2);
});
