// Unit test: listPages tree mode must propagate the `truncated` flag (#486).
//
// enumerateSpacePages returns { pages, truncated } — truncated is true ONLY when
// the stdio-fallback BFS hit its node cap (the primary /pages/tree path is
// uncapped). The old tree-mode listPages destructured only `pages` and returned a
// bare tree, dropping `truncated`, so a caller handed an INCOMPLETE tree had no
// way to know pages were missing. The fix returns { tree, truncated } (same
// pattern check_new_comments uses).
//
// Reaching the real cap (MAX_NODES = 10000) in a mock is impractical, so we stub
// enumerateSpacePages directly to assert the flag is threaded through verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocmostClient } from "../../build/client.js";

function stubClient() {
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "access",
  });
  // No network: the tree path only calls ensureAuthenticated + enumerateSpacePages.
  client.ensureAuthenticated = async () => {};
  return client;
}

const onePage = [{ id: "r1", title: "Root", parentPageId: null }];

test("tree mode carries truncated:true when the enumeration truncated (#486)", async () => {
  const client = stubClient();
  client.enumerateSpacePages = async () => ({ pages: onePage, truncated: true });

  const res = await client.listPages("space-1", 50, true);

  assert.equal(res.truncated, true, "the truncated flag is threaded through");
  assert.ok(Array.isArray(res.tree), "the built tree rides alongside the flag");
  assert.equal(res.tree[0].id, "r1");
});

test("tree mode carries truncated:false for a complete enumeration", async () => {
  const client = stubClient();
  client.enumerateSpacePages = async () => ({ pages: onePage, truncated: false });

  const res = await client.listPages("space-1", 50, true);

  assert.equal(res.truncated, false);
  assert.equal(res.tree[0].id, "r1");
});

test("tree mode still requires a spaceId", async () => {
  const client = stubClient();
  await assert.rejects(
    client.listPages(undefined, 50, true),
    /tree mode requires a spaceId/,
  );
});
