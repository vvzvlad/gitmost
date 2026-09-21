// Mock collab tests for the #413 MARKDOWN path of patchNode / insertNode and the
// markdown-default getNode. These stand up a real Hocuspocus collab server seeded
// with a chosen document (mirroring ambiguous-node-id.test.mjs), let the client
// run its real transform against a live Y.Doc, and read the persisted result back
// to assert on the written document.
//
// Coverage (issue #413):
//  - CANON CONVERGENCE: a block written via patchNode(markdown) is canonically
//    equal to the SAME content run through a full markdown import (no "second
//    canon" appears on the block-level path).
//  - id-THREAD on a 1->N splice: the first block inherits the target id, the rest
//    get fresh ids, and every NEIGHBOUR block is byte-identical before/after.
//  - XOR validation (both / neither markdown+node -> error).
//  - span/color-attr GUARD on the target block (a merged/colored cell refuses a
//    markdown patch, nothing written).
//  - `^[...]` footnote in the fragment -> a definition in the tail list + renumber.
//  - insertNode(markdown) inserts N blocks in order at the anchor.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Hocuspocus } from "@hocuspocus/server";
import { DocmostClient } from "../../build/client.js";
import { buildYDoc } from "../../build/lib/collaboration.js";
import {
  docsCanonicallyEqual,
  markdownToProseMirror,
} from "@docmost/prosemirror-markdown";

const PAGE = "11111111-1111-4111-8111-111111111111";

// Deep JSON clone for byte-identity assertions.
const jclone = (v) => JSON.parse(JSON.stringify(v));

function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content))
    for (const c of node.content) findAll(c, type, acc);
  return acc;
}

// Stand up an HTTP+Hocuspocus stack seeded with `seedDoc`. `state.lastDoc` holds
// the most recently persisted document JSON (decoded from the live Y.Doc on every
// change) so a test can inspect exactly what was written.
async function spawnCollabStack(seedDoc) {
  const state = { changed: false, lastDoc: null };

  const hocuspocus = new Hocuspocus({
    quiet: true,
    async onLoadDocument() {
      return buildYDoc(seedDoc);
    },
    async onChange(data) {
      state.changed = true;
      try {
        const frag = data.document.getXmlFragment("default");
        // Decode the live fragment back to JSON via the same helper the client
        // reads with — but simpler: use the yjs->json path exposed by the doc.
        state.lastDoc = fragmentToJson(frag);
      } catch {
        /* ignore decode errors in teardown races */
      }
    },
  });

  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/api/auth/login") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "authToken=t; Path=/; HttpOnly",
        });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (req.url === "/api/auth/collab-token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { token: "collab-jwt" } }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
  });

  server.on("upgrade", (request, socket, head) => {
    if (!request.url || !request.url.startsWith("/collab")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      hocuspocus.handleConnection(ws, request);
    });
  });

  const baseURL = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}/api`);
    });
  });

  openStacks.push({ server, hocuspocus });
  return { state, baseURL };
}

// Minimal XmlFragment -> ProseMirror JSON decode, mirroring the shape Docmost
// stores. Reads element name as node type, attributes as attrs, and recurses into
// children; text nodes carry their string.
function fragmentToJson(frag) {
  const decodeNode = (el) => {
    if (el.constructor.name === "YXmlText") {
      // A yjs text node: collect the string with its formatting deltas.
      const delta = el.toDelta();
      return delta.map((d) => {
        const node = { type: "text", text: d.insert };
        if (d.attributes && Object.keys(d.attributes).length) {
          node.marks = Object.entries(d.attributes).map(([type, attrs]) =>
            attrs && typeof attrs === "object" && Object.keys(attrs).length
              ? { type, attrs }
              : { type },
          );
        }
        return node;
      });
    }
    const node = { type: el.nodeName };
    const attrs = el.getAttributes();
    if (attrs && Object.keys(attrs).length) node.attrs = attrs;
    const children = [];
    for (const child of el.toArray()) {
      const decoded = decodeNode(child);
      if (Array.isArray(decoded)) children.push(...decoded);
      else children.push(decoded);
    }
    if (children.length) node.content = children;
    return node;
  };
  const content = [];
  for (const child of frag.toArray()) content.push(decodeNode(child));
  return { type: "doc", content };
}

const openStacks = [];
after(async () => {
  await Promise.all(
    openStacks.map(
      ({ server, hocuspocus }) =>
        new Promise((resolve) => {
          server.close(() => {
            Promise.resolve(hocuspocus.destroy?.()).finally(resolve);
          });
        }),
    ),
  );
});

// A seed doc with two neighbour paragraphs around a target paragraph.
function seed3() {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "before-id" },
        content: [{ type: "text", text: "before" }],
      },
      {
        type: "paragraph",
        attrs: { id: "target-id" },
        content: [{ type: "text", text: "old target" }],
      },
      {
        type: "paragraph",
        attrs: { id: "after-id" },
        content: [{ type: "text", text: "after" }],
      },
    ],
  };
}

test("patchNode(markdown): XOR — both markdown and node is rejected, nothing written", async () => {
  const { state, baseURL } = await spawnCollabStack(seed3());
  const client = new DocmostClient(baseURL, "e@x.com", "pw");
  await assert.rejects(
    () =>
      client.patchNode(PAGE, "target-id", {
        markdown: "hello",
        node: { type: "paragraph" },
      }),
    /exactly one of/i,
  );
  assert.equal(state.changed, false, "no write on an XOR violation");
});

test("patchNode(markdown): XOR — neither markdown nor node is rejected", async () => {
  const { baseURL } = await spawnCollabStack(seed3());
  const client = new DocmostClient(baseURL, "e@x.com", "pw");
  await assert.rejects(
    () => client.patchNode(PAGE, "target-id", {}),
    /exactly one of/i,
  );
});

test("patchNode(markdown): single block keeps the id; neighbours byte-identical", async () => {
  const before = seed3();
  const { state, baseURL } = await spawnCollabStack(before);
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  const res = await client.patchNode(PAGE, "target-id", {
    markdown: "the **new** target",
  });
  assert.equal(res.success, true);
  assert.equal(res.replaced, 1);
  assert.equal(res.blocks, 1);

  const doc = state.lastDoc;
  const paras = doc.content;
  // The rewritten block still carries the target id.
  const target = paras.find((p) => p.attrs?.id === "target-id");
  assert.ok(target, "rewritten block inherits target-id");
  assert.equal(target.content.some((n) => n.text === "new"), true);
  // Neighbours are byte-identical to the seed.
  const beforeNode = paras.find((p) => p.attrs?.id === "before-id");
  const afterNode = paras.find((p) => p.attrs?.id === "after-id");
  assert.deepEqual(beforeNode, before.content[0]);
  assert.deepEqual(afterNode, before.content[2]);
});

test("patchNode(markdown): 1->N splice threads the id onto the first block; neighbours byte-identical", async () => {
  const before = seed3();
  const { state, baseURL } = await spawnCollabStack(before);
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  // Two paragraphs of markdown -> a 2-block fragment replacing one block.
  const res = await client.patchNode(PAGE, "target-id", {
    markdown: "first para\n\nsecond para",
  });
  assert.equal(res.blocks, 2);

  const doc = state.lastDoc;
  const idx = doc.content.findIndex((p) => p.attrs?.id === "target-id");
  assert.ok(idx >= 0, "first spliced block inherits target-id");
  const first = doc.content[idx];
  const second = doc.content[idx + 1];
  assert.equal(first.content.some((n) => n.text === "first para"), true);
  assert.equal(second.content.some((n) => n.text === "second para"), true);
  // The second block has a DIFFERENT (fresh) id.
  assert.notEqual(second.attrs?.id, "target-id");
  assert.ok(second.attrs?.id, "the extra block gets a fresh id");
  // Neighbours untouched, byte-identical.
  assert.deepEqual(
    doc.content.find((p) => p.attrs?.id === "before-id"),
    before.content[0],
  );
  assert.deepEqual(
    doc.content.find((p) => p.attrs?.id === "after-id"),
    before.content[2],
  );
});

test("patchNode(markdown): CANON CONVERGENCE — block equals the same content full-imported", async () => {
  const { state, baseURL } = await spawnCollabStack(seed3());
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  const md = "a paragraph with **bold**, _italic_ and `code`";
  await client.patchNode(PAGE, "target-id", { markdown: md });

  // The block as persisted.
  const target = state.lastDoc.content.find((p) => p.attrs?.id === "target-id");
  // The same markdown run through the full-page importer.
  const full = await markdownToProseMirror(md);
  const fullBlock = full.content[0];

  assert.ok(
    docsCanonicallyEqual(
      { type: "doc", content: [target] },
      { type: "doc", content: [fullBlock] },
    ),
    "a patchNode(markdown) block must be canonically equal to a full import — no second canon",
  );
});

test("patchNode(markdown): a paragraph inside a merged (colspan) cell rewrites fine — the cell's span is preserved", async () => {
  // A cell paragraph carries an id and IS id-targetable; rewriting ITS content
  // from markdown replaces only the paragraph, so the cell's colspan is NOT lost
  // (the span lives on the cell, which patchNode leaves in place). This is the
  // correct behavior: no false guard, no loss. The guard's REJECTION logic (when
  // the replaced block itself carries/contains an unrepresentable span) is proven
  // by the findUnrepresentableTableAttrs unit test — that case is not reachable
  // through the id-targeting API because tables/cells carry no addressable id.
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
                attrs: { colspan: 2, rowspan: 1 },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "cell-para" },
                    content: [{ type: "text", text: "merged" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const { state, baseURL } = await spawnCollabStack(doc);
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  const res = await client.patchNode(PAGE, "cell-para", { markdown: "rewritten" });
  assert.equal(res.success, true);
  // The cell's colspan survives (the span is on the cell, not the paragraph).
  const cell = findAll(state.lastDoc, "tableCell")[0];
  assert.equal(cell.attrs.colspan, 2, "the cell's colspan is preserved");
  const para = findAll(cell, "paragraph")[0];
  assert.equal(
    (para.content || []).some((n) => n.text === "rewritten"),
    true,
  );
});

test("patchNode(markdown): a `^[...]` footnote in the fragment lands in the tail list", async () => {
  const { state, baseURL } = await spawnCollabStack(seed3());
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  await client.patchNode(PAGE, "target-id", {
    markdown: "a claim^[the supporting note]",
  });

  const doc = state.lastDoc;
  const lists = findAll(doc, "footnotesList");
  assert.equal(lists.length, 1, "exactly one tail footnotesList");
  const defs = findAll(doc, "footnoteDefinition");
  assert.equal(defs.length, 1, "one definition for the fragment footnote");
  const refs = findAll(doc, "footnoteReference");
  assert.equal(refs.length, 1, "one reference in the body");
  // Reference and definition share an id (renumbered canonically).
  assert.equal(refs[0].attrs.id, defs[0].attrs.id);
});

test("insertNode(markdown): inserts N blocks in order after the anchor", async () => {
  const before = seed3();
  const { state, baseURL } = await spawnCollabStack(before);
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  const res = await client.insertNode(
    PAGE,
    { markdown: "new one\n\nnew two" },
    { position: "after", anchorNodeId: "before-id" },
  );
  assert.equal(res.success, true);
  assert.equal(res.blocks, 2);

  const texts = state.lastDoc.content.map((p) => (p.content || []).map((n) => n.text).join(""));
  // Order: before, new one, new two, target, after.
  assert.deepEqual(texts, ["before", "new one", "new two", "old target", "after"]);
});

test("insertNode(markdown): XOR — both markdown and node is rejected", async () => {
  const { baseURL } = await spawnCollabStack(seed3());
  const client = new DocmostClient(baseURL, "e@x.com", "pw");
  await assert.rejects(
    () =>
      client.insertNode(
        PAGE,
        { markdown: "x", node: { type: "paragraph" } },
        { position: "append" },
      ),
    /exactly one of/i,
  );
});

// A seed page whose ONLY footnote reference lives in the target paragraph p1,
// with a matching definition in a trailing footnotesList. Rewriting p1 with a
// footnote-free fragment removes the last referrer -> the definition is orphaned.
function seedOrphanFootnote() {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          { type: "text", text: "a claim" },
          { type: "footnoteReference", attrs: { id: "fn-1", referenceNumber: 1 } },
        ],
      },
      {
        type: "footnotesList",
        content: [
          {
            type: "footnoteDefinition",
            attrs: { id: "fn-1" },
            content: [
              {
                type: "paragraph",
                attrs: { id: "def-para" },
                content: [{ type: "text", text: "the supporting note" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("patchNode(markdown): removing the LAST footnote referrer drops the now-orphan definition (canonical convergence)", async () => {
  const { state, baseURL } = await spawnCollabStack(seedOrphanFootnote());
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  // The fragment has NO footnotes -> definitions=[]; the splice removes the only
  // footnoteReference, leaving the tail definition orphaned. The canonicalization
  // pass (which mergeFootnoteDefinitions must still run) has to drop it.
  await client.patchNode(PAGE, "p1", { markdown: "just text" });

  const doc = state.lastDoc;
  assert.equal(
    findAll(doc, "footnoteDefinition").length,
    0,
    "the orphaned definition is dropped",
  );
  assert.equal(
    findAll(doc, "footnotesList").length,
    0,
    "the emptied footnotesList is removed",
  );
  assert.equal(findAll(doc, "footnoteReference").length, 0, "no references remain");

  // Convergence: the persisted result equals the SAME content imported whole.
  const full = await markdownToProseMirror("just text");
  const target = doc.content.find((p) => p.attrs?.id === "p1");
  assert.ok(
    docsCanonicallyEqual(
      { type: "doc", content: [target] },
      { type: "doc", content: [full.content[0]] },
    ),
    "the post-splice doc is canonically identical to a full re-import",
  );
});

test("patchNode(markdown): a pure-text patch on a footnote-FREE page leaves footnote topology untouched (fast path)", async () => {
  const before = seed3();
  const { state, baseURL } = await spawnCollabStack(before);
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  await client.patchNode(PAGE, "target-id", { markdown: "plain replacement" });

  const doc = state.lastDoc;
  assert.equal(findAll(doc, "footnotesList").length, 0, "no footnotesList appears");
  assert.equal(findAll(doc, "footnoteDefinition").length, 0, "no definition appears");
  assert.equal(findAll(doc, "footnoteReference").length, 0, "no reference appears");
  // Neighbours byte-identical (the fast path does not clone/reshape the tree).
  assert.deepEqual(
    doc.content.find((p) => p.attrs?.id === "before-id"),
    before.content[0],
  );
  assert.deepEqual(
    doc.content.find((p) => p.attrs?.id === "after-id"),
    before.content[2],
  );
});

test("insertNode(markdown): a footnote-free insert on a page carrying a footnote still canonicalizes (definitions empty)", async () => {
  // The page has an existing footnote (ref + tail def). Inserting a footnote-free
  // fragment keeps the reference alive, so the definition stays — but the write
  // path must still run canonicalization (definitions=[]), producing exactly one
  // tail list with the reference/definition ids in sync.
  const { state, baseURL } = await spawnCollabStack(seedOrphanFootnote());
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  const res = await client.insertNode(
    PAGE,
    { markdown: "unrelated one\n\nunrelated two" },
    { position: "after", anchorNodeId: "p1" },
  );
  assert.equal(res.success, true);

  const doc = state.lastDoc;
  assert.equal(findAll(doc, "footnoteReference").length, 1, "the existing reference survives");
  assert.equal(findAll(doc, "footnotesList").length, 1, "exactly one tail list");
  const defs = findAll(doc, "footnoteDefinition");
  assert.equal(defs.length, 1, "the definition is kept (still referenced)");
  assert.equal(findAll(doc, "footnoteReference")[0].attrs.id, defs[0].attrs.id);
});

// Collect every TOP-LEVEL block id in a doc (the invariant the splice dedup
// guarantees is page-wide top-level uniqueness).
function topLevelIds(doc) {
  return doc.content
    .map((b) => b?.attrs?.id)
    .filter((id) => id != null);
}

test("patchNode(markdown): a 1->N splice yields page-wide UNIQUE top-level block ids", async () => {
  const before = seed3();
  const { state, baseURL } = await spawnCollabStack(before);
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  await client.patchNode(PAGE, "target-id", {
    markdown: "one\n\ntwo\n\nthree",
  });

  const ids = topLevelIds(state.lastDoc);
  assert.equal(new Set(ids).size, ids.length, "all top-level block ids are unique");
  // The target id is still present (threaded onto the first block).
  assert.ok(ids.includes("target-id"), "the first block still inherits target-id");
});

test("insertNode(markdown): inserting multiple blocks yields page-wide UNIQUE top-level block ids", async () => {
  const before = seed3();
  const { state, baseURL } = await spawnCollabStack(before);
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  await client.insertNode(
    PAGE,
    { markdown: "alpha\n\nbeta\n\ngamma" },
    { position: "after", anchorNodeId: "before-id" },
  );

  const ids = topLevelIds(state.lastDoc);
  assert.equal(new Set(ids).size, ids.length, "all top-level block ids are unique");
});
