// Contract tests for the drawioGet / drawioCreate / drawioUpdate client
// methods (issue #423). Follows the repo's seam-override pattern (see
// full-doc-write-canonicalize.test.mjs): a DocmostClient subclass stubs the I/O
// seams (auth, collab token, page read, attachment upload/fetch, the mutatePage
// write) so the tool logic is exercised without a live Docmost or collab socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import pako from "pako";
import { DocmostClient } from "../../build/client.js";
import {
  buildDrawioSvg,
  encodeDrawioFile,
  normalizeXml,
  mxHash,
  decodeDrawioSvg,
} from "../../build/lib/drawio-xml.js";

const MODEL =
  '<mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Hi" style="rounded=1;" vertex="1" parent="1">' +
  '<mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell>' +
  '</root></mxGraphModel>';

// Build a Docmost-style `.drawio.svg` (base64 content) for a model.
function svgFor(model) {
  return buildDrawioSvg(normalizeXml(model), "<g/>", { width: 200, height: 120 });
}

// Build a human/compressed-export `.drawio.svg` (base64 content wrapping a
// compressed <diagram> payload), mimicking a diagram a person saved.
function compressedSvgFor(model) {
  const compressed = Buffer.from(
    pako.deflateRaw(encodeURIComponent(normalizeXml(model))),
  ).toString("base64");
  const file = `<mxfile host="Electron"><diagram id="a" name="Page-1">${compressed}</diagram></mxfile>`;
  const content = Buffer.from(file, "utf-8").toString("base64");
  return `<svg xmlns="http://www.w3.org/2000/svg" content="${content}"><image href="x"/></svg>`;
}

// The vendored `drawio` node schema (diagramAttributes) declares ONLY these
// attributes; PMNode.fromJSON drops anything else on save. Mirror that here so
// the mock write path behaves like the real one — in particular, a block `id`
// set on a drawio node does NOT survive the save, so a handle keyed on it is
// un-resolvable. This is exactly what the production bug (issue #423 Fix 1) was.
const DRAWIO_SCHEMA_ATTRS = new Set([
  "src",
  "title",
  "alt",
  "width",
  "height",
  "size",
  "aspectRatio",
  "align",
  "attachmentId",
]);

function applyDrawioSchemaDrop(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "drawio" && node.attrs && typeof node.attrs === "object") {
    for (const key of Object.keys(node.attrs)) {
      if (!DRAWIO_SCHEMA_ATTRS.has(key)) delete node.attrs[key];
    }
  }
  if (Array.isArray(node.content)) for (const c of node.content) applyDrawioSchemaDrop(c);
}

function makeClient({ pageDoc, attachmentSvg } = {}) {
  const calls = { uploads: [], mutations: [] };
  class TestClient extends DocmostClient {
    async ensureAuthenticated() {}
    async getCollabTokenWithReauth() {
      return "collab-token";
    }
    async resolvePageId(pageId) {
      return `uuid-${pageId}`;
    }
    async getPageRaw(pageId) {
      return {
        id: pageId,
        slugId: "s",
        title: "P",
        spaceId: "sp",
        content: pageDoc ?? { type: "doc", content: [] },
      };
    }
    async uploadAttachmentBuffer(pageId, buffer, fileName, mime) {
      const id = `att-${calls.uploads.length + 1}`;
      calls.uploads.push({ pageId, fileName, mime, svg: buffer.toString("utf-8") });
      return { id, fileName, fileSize: buffer.length };
    }
    async fetchAttachmentText(src) {
      return attachmentSvg;
    }
    mutatePage(pageId, token, apiUrl, transform) {
      // Run the transform against a clone of the source doc, capture the result.
      const clone = structuredClone(pageDoc ?? { type: "doc", content: [] });
      const doc = transform(clone);
      // Mirror the real schema: unknown drawio attrs (e.g. a block `id`) are
      // dropped on save, so callers can never rely on them to address the node.
      if (doc) applyDrawioSchemaDrop(doc);
      calls.mutations.push({ pageId, doc });
      return Promise.resolve({ doc, verify: { changed: doc != null } });
    }
  }
  const client = new TestClient("http://127.0.0.1:1/api", "e@x.com", "pw");
  return { client, calls };
}

function findDrawio(node, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === "drawio") acc.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) findDrawio(c, acc);
  return acc;
}

// --- drawioCreate ---------------------------------------------------------

test("drawioCreate: lints, builds the .drawio.svg, uploads and inserts a node", async () => {
  const pageDoc = {
    type: "doc",
    content: [{ type: "paragraph", attrs: { id: "p1" }, content: [] }],
  };
  const { client, calls } = makeClient({ pageDoc });
  const res = await client.drawioCreate("page1", { position: "append" }, MODEL, "My diagram");

  assert.equal(res.success, true);
  // The returned handle is an index-based "#<index>" ref (drawio nodes carry no
  // persisted attrs.id), addressing the appended top-level block (index 1, after
  // the existing paragraph).
  assert.equal(res.nodeId, "#1");
  assert.equal(res.attachmentId, "att-1");
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.uploads[0].fileName, "diagram.drawio.svg");
  assert.equal(calls.uploads[0].mime, "image/svg+xml");
  // The uploaded SVG carries the model back (round-trips through the decode chain).
  assert.equal(decodeDrawioSvg(calls.uploads[0].svg), normalizeXml(MODEL));

  // A drawio node was appended with src/attachmentId/dimensions and the title.
  const drawios = findDrawio(calls.mutations[0].doc);
  assert.equal(drawios.length, 1);
  const n = drawios[0];
  // No `id` attribute is set/persisted on the node (schema has none).
  assert.equal(n.attrs.id, undefined);
  assert.equal(n.attrs.attachmentId, "att-1");
  assert.match(n.attrs.src, /^\/api\/files\/att-1\//);
  assert.ok(n.attrs.width > 0 && n.attrs.height > 0);
  assert.equal(n.attrs.title, "My diagram");
});

test("drawioCreate: a lint violation throws before any upload", async () => {
  const { client, calls } = makeClient({ pageDoc: { type: "doc", content: [] } });
  // Edge with no child geometry -> edge-geometry rule.
  const bad =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '<mxCell id="3" edge="1" parent="1" source="2" target="2"/></root></mxGraphModel>';
  await assert.rejects(
    () => client.drawioCreate("page1", { position: "append" }, bad, undefined),
    /edge-geometry/,
  );
  assert.equal(calls.uploads.length, 0, "no attachment uploaded on lint failure");
});

test("drawioCreate: before/after requires exactly one anchor", async () => {
  const { client } = makeClient({ pageDoc: { type: "doc", content: [] } });
  await assert.rejects(
    () => client.drawioCreate("page1", { position: "before" }, MODEL),
    /exactly one of anchorNodeId or anchorText/,
  );
});

// #494 — a NESTED insert (anchored inside a callout/table cell) lands a write
// that "#<index>" cannot address. The tool used to THROW here even though the
// diagram was already committed, so a retry-prone agent re-created a DUPLICATE.
// It must now report SUCCESS (nodeId:null + a warning) so the agent never
// blind-retries a landed write. This REDDENS if the throw is restored (the
// assert.doesNotReject + success asserts would fail).
test("drawioCreate: a NESTED insert succeeds with nodeId:null + a warning (no throw, no duplicate)", async () => {
  const pageDoc = {
    type: "doc",
    content: [
      {
        type: "callout",
        attrs: { id: "co1" },
        content: [
          {
            type: "paragraph",
            attrs: { id: "inner" },
            content: [{ type: "text", text: "hello inner" }],
          },
        ],
      },
    ],
  };
  const { client, calls } = makeClient({ pageDoc });

  let res;
  await assert.doesNotReject(async () => {
    res = await client.drawioCreate(
      "page1",
      { position: "after", anchorNodeId: "inner" },
      MODEL,
    );
  });

  // The write is acknowledged as a SUCCESS...
  assert.equal(res.success, true);
  // ...but with NO addressable "#<index>" handle (it is nested).
  assert.equal(res.nodeId, null);
  assert.equal(res.attachmentId, "att-1");
  // A warning tells the agent it is saved (do not re-create) and how to re-read.
  assert.ok(
    res.warnings.some((w) => /NESTED|do NOT re-create/i.test(w)),
    "missing the nested-write warning",
  );

  // The diagram was written EXACTLY ONCE, nested inside the callout (not a
  // top-level block) — proving it really landed (so a retry would duplicate).
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.mutations.length, 1);
  const topLevel = calls.mutations[0].doc.content;
  assert.ok(
    !topLevel.some((b) => b && b.type === "drawio"),
    "the diagram must be nested, not a top-level block",
  );
  const nested = findDrawio(calls.mutations[0].doc);
  assert.equal(nested.length, 1, "exactly one diagram written");
  assert.equal(nested[0].attrs.attachmentId, "att-1");
});

// --- drawioGet ------------------------------------------------------------

test("drawioGet: decodes the model and returns meta with a hash", async () => {
  const pageDoc = {
    type: "doc",
    content: [
      {
        type: "drawio",
        attrs: {
          id: "d1",
          src: "/api/files/att-1/diagram.drawio.svg",
          attachmentId: "att-1",
          title: "T",
          width: 200,
          height: 120,
        },
      },
    ],
  };
  const { client } = makeClient({ pageDoc, attachmentSvg: svgFor(MODEL) });
  const res = await client.drawioGet("page1", "d1", "xml");
  assert.equal(res.content, normalizeXml(MODEL));
  assert.equal(res.meta.attachmentId, "att-1");
  assert.equal(res.meta.title, "T");
  assert.equal(res.meta.cellCount, 1);
  assert.equal(res.meta.hash, mxHash(normalizeXml(MODEL)));
});

test("drawioGet: format=svg returns the raw .drawio.svg", async () => {
  const svg = svgFor(MODEL);
  const pageDoc = {
    type: "doc",
    content: [
      { type: "drawio", attrs: { id: "d1", src: "/api/files/att-1/x.svg", attachmentId: "att-1" } },
    ],
  };
  const { client } = makeClient({ pageDoc, attachmentSvg: svg });
  const res = await client.drawioGet("page1", "d1", "svg");
  assert.equal(res.content, svg);
});

test("drawioGet: format=svg strips data-raster and reports meta.hasRaster (#629)", async () => {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const rasterB64 = Buffer.concat([PNG_SIG, Buffer.from([1, 2, 3])]).toString("base64");
  const base = svgFor(MODEL);
  // Inject a browser-embedded raster onto the root <svg> (as Part A would).
  const withRaster = base.replace(
    /^<svg /,
    `<svg data-raster="data:image/png;base64,${rasterB64}" `,
  );
  const pageDoc = {
    type: "doc",
    content: [
      { type: "drawio", attrs: { id: "d1", src: "/api/files/att-1/x.svg", attachmentId: "att-1" } },
    ],
  };
  const { client } = makeClient({ pageDoc, attachmentSvg: withRaster });
  const res = await client.drawioGet("page1", "d1", "svg");
  // The returned svg carries NO data-raster (it never bloats model context)...
  assert.ok(!res.content.includes("data-raster"));
  // ...but content= is byte-intact, so the model still decodes.
  assert.equal(res.content, base);
  assert.equal(res.meta.hasRaster, true);
});

test("drawioGet: meta.hasRaster is false on a plain diagram; huge raster does not crash (#629)", async () => {
  const pageDoc = {
    type: "doc",
    content: [
      { type: "drawio", attrs: { id: "d1", src: "/api/files/att-1/x.svg", attachmentId: "att-1" } },
    ],
  };
  // Plain diagram (no raster).
  const plain = makeClient({ pageDoc, attachmentSvg: svgFor(MODEL) });
  const r1 = await plain.client.drawioGet("page1", "d1", "svg");
  assert.equal(r1.meta.hasRaster, false);
  assert.equal(r1.content, svgFor(MODEL));

  // A HUGE (invalid) data-raster must not crash the jsdom parse — it is stripped
  // before decode and reported as no valid raster.
  const huge = "A".repeat(300000);
  const withHuge = svgFor(MODEL).replace(
    /^<svg /,
    `<svg data-raster="data:image/png;base64,${huge}" `,
  );
  const big = makeClient({ pageDoc, attachmentSvg: withHuge });
  const r2 = await big.client.drawioGet("page1", "d1", "svg");
  assert.equal(r2.meta.hasRaster, false); // invalid -> not a usable raster
  assert.ok(!r2.content.includes("data-raster"));
  assert.equal(r2.content, svgFor(MODEL));
});

test("drawioGet: reads a HUMAN-saved compressed diagram losslessly (pako)", async () => {
  const pageDoc = {
    type: "doc",
    content: [
      { type: "drawio", attrs: { id: "d1", src: "/api/files/att-1/x.svg", attachmentId: "att-1" } },
    ],
  };
  const { client } = makeClient({ pageDoc, attachmentSvg: compressedSvgFor(MODEL) });
  const res = await client.drawioGet("page1", "d1", "xml");
  assert.equal(res.content, normalizeXml(MODEL));
});

// --- drawioUpdate ---------------------------------------------------------

const UPDATED_MODEL =
  '<mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Changed" style="rounded=1;" vertex="1" parent="1">' +
  '<mxGeometry x="20" y="20" width="300" height="200" as="geometry"/></mxCell>' +
  '</root></mxGraphModel>';

function updatePageDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "drawio",
        attrs: {
          id: "d1",
          src: "/api/files/att-1/diagram.drawio.svg",
          attachmentId: "att-1",
          width: 200,
          height: 120,
        },
      },
    ],
  };
}

test("drawioUpdate: stale baseHash -> conflict, no upload", async () => {
  const { client, calls } = makeClient({
    pageDoc: updatePageDoc(),
    attachmentSvg: svgFor(MODEL),
  });
  await assert.rejects(
    () => client.drawioUpdate("page1", "d1", UPDATED_MODEL, "deadbeef-stale"),
    /conflict/,
  );
  assert.equal(calls.uploads.length, 0, "no upload on conflict");
});

test("drawioUpdate: current baseHash -> uploads new attachment and repoints node dims", async () => {
  const currentHash = mxHash(normalizeXml(MODEL));
  const { client, calls } = makeClient({
    pageDoc: updatePageDoc(),
    attachmentSvg: svgFor(MODEL),
  });
  const res = await client.drawioUpdate("page1", "d1", UPDATED_MODEL, currentHash);
  assert.equal(res.success, true);
  assert.equal(res.attachmentId, "att-1"); // fresh id from the stub sequence
  assert.equal(calls.uploads.length, 1);
  // The uploaded SVG carries the NEW model.
  assert.equal(decodeDrawioSvg(calls.uploads[0].svg), normalizeXml(UPDATED_MODEL));
  // The node was repointed with the new bounding-box dimensions:
  // vertex maxX=320,maxY=220 + the 20px preview margin -> 340 x 240.
  const n = findDrawio(calls.mutations[0].doc)[0];
  assert.equal(n.attrs.attachmentId, "att-1");
  assert.equal(n.attrs.width, 340);
  assert.equal(n.attrs.height, 240);
  // The block `id` used as the legacy resolution handle is dropped on save
  // (schema declares no `id`); the update still targeted the correct node.
  assert.equal(n.attrs.id, undefined);
});

test("drawioUpdate: baseHash is mandatory", async () => {
  const { client } = makeClient({ pageDoc: updatePageDoc(), attachmentSvg: svgFor(MODEL) });
  await assert.rejects(
    () => client.drawioUpdate("page1", "d1", UPDATED_MODEL, ""),
    /baseHash is mandatory/,
  );
});

// --- Fix 1: the create handle must resolve on the SAVED doc (no id) ---------

test("drawioCreate -> get/update: returned #<index> handle resolves on the saved doc (id dropped)", async () => {
  // Create appends a drawio node after the existing paragraph.
  const createDoc = {
    type: "doc",
    content: [{ type: "paragraph", attrs: { id: "p1" }, content: [] }],
  };
  const create = makeClient({ pageDoc: createDoc });
  const res = await create.client.drawioCreate(
    "page1",
    { position: "append" },
    MODEL,
    "T",
  );
  // The handle is index-based, not a block id.
  assert.equal(res.nodeId, "#1");

  // Take the document EXACTLY as it was saved: the schema drop stripped the
  // node's id, so no id-based handle could ever resolve against it.
  const savedDoc = create.calls.mutations[0].doc;
  assert.equal(findDrawio(savedDoc)[0].attrs.id, undefined);

  // drawioGet with the returned handle resolves the just-created node.
  const getClient = makeClient({ pageDoc: savedDoc, attachmentSvg: svgFor(MODEL) });
  const got = await getClient.client.drawioGet("page1", res.nodeId, "xml");
  assert.equal(got.nodeId, res.nodeId);
  assert.equal(got.content, normalizeXml(MODEL));

  // drawioUpdate with the same handle + the hash from get repoints that node.
  const upClient = makeClient({ pageDoc: savedDoc, attachmentSvg: svgFor(MODEL) });
  const upd = await upClient.client.drawioUpdate(
    "page1",
    res.nodeId,
    UPDATED_MODEL,
    got.meta.hash,
  );
  assert.equal(upd.success, true);
  assert.equal(upd.nodeId, res.nodeId);
  const updated = findDrawio(upClient.calls.mutations[0].doc)[0];
  assert.equal(
    decodeDrawioSvg(upClient.calls.uploads[0].svg),
    normalizeXml(UPDATED_MODEL),
  );
  assert.equal(updated.attrs.width, 340);
});

// --- error paths: the LLM must get a clean error, not a crash --------------

test("drawioGet: a bad node ref -> clean 'no node found' error", async () => {
  // Page has one paragraph; the requested ref resolves to nothing.
  const pageDoc = {
    type: "doc",
    content: [{ type: "paragraph", attrs: { id: "p1" }, content: [] }],
  };
  const { client } = makeClient({ pageDoc, attachmentSvg: svgFor(MODEL) });
  await assert.rejects(
    () => client.drawioGet("page1", "does-not-exist", "xml"),
    /no node found for "does-not-exist"/,
  );
});

test("drawioGet: a drawio node with no src -> clean 'has no src to read' error", async () => {
  const pageDoc = {
    type: "doc",
    content: [
      // A drawio node that carries no `src` (e.g. a half-written node).
      { type: "drawio", attrs: { id: "d1", attachmentId: "att-1" } },
    ],
  };
  const { client } = makeClient({ pageDoc, attachmentSvg: svgFor(MODEL) });
  await assert.rejects(
    () => client.drawioGet("page1", "d1", "xml"),
    /node "d1" on page page1 has no src to read/,
  );
});

test("drawioUpdate: the resolved node is NOT a drawio node -> clean error, no upload", async () => {
  // "#0" resolves to a paragraph. The update must refuse cleanly rather than
  // crash or repoint the wrong node.
  const pageDoc = {
    type: "doc",
    content: [{ type: "paragraph", attrs: { id: "p1" }, content: [] }],
  };
  const { client, calls } = makeClient({ pageDoc, attachmentSvg: svgFor(MODEL) });
  await assert.rejects(
    () => client.drawioUpdate("page1", "#0", UPDATED_MODEL, "any-nonempty-hash"),
    /node "#0" on page page1 is a paragraph, not a drawio diagram/,
  );
  assert.equal(calls.uploads.length, 0, "no upload when the node is not a diagram");
  assert.equal(calls.mutations.length, 0, "no write when the node is not a diagram");
});

test("drawioCreate: anchor not found -> clean error that reports the orphan attachment", async () => {
  // The upload happens before the mutate transform; when the anchor cannot be
  // found the write is skipped and the (now unreferenced) attachment is named
  // in the error, exactly as the code documents.
  const pageDoc = {
    type: "doc",
    content: [{ type: "paragraph", attrs: { id: "p1" }, content: [] }],
  };
  const { client, calls } = makeClient({ pageDoc });
  await assert.rejects(
    () =>
      client.drawioCreate(
        "page1",
        { position: "after", anchorNodeId: "nope" },
        MODEL,
        "T",
      ),
    (err) =>
      /anchor not found/.test(err.message) &&
      /unreferenced orphan/.test(err.message) &&
      /att-1/.test(err.message),
  );
  // The orphan was uploaded (and reported), but no node was written.
  assert.equal(calls.uploads.length, 1, "attachment uploaded before the failed insert");
  const drawios = calls.mutations.length ? findDrawio(calls.mutations[0].doc) : [];
  assert.equal(drawios.length, 0, "no drawio node written when the anchor is missing");
});

// --- Fix 2: update targets ONLY the resolved node --------------------------

test("drawioUpdate: repoints ONLY the addressed node, not siblings sharing an attachmentId", async () => {
  // A copied diagram: two drawio nodes share one attachmentId. Updating via the
  // "#0" handle must touch node #0 only, never the sibling copy.
  const shared = {
    type: "doc",
    content: [
      {
        type: "drawio",
        attrs: {
          src: "/api/files/shared/x.svg",
          attachmentId: "shared",
          width: 200,
          height: 120,
        },
      },
      {
        type: "drawio",
        attrs: {
          src: "/api/files/shared/x.svg",
          attachmentId: "shared",
          width: 200,
          height: 120,
        },
      },
    ],
  };
  const { client, calls } = makeClient({
    pageDoc: shared,
    attachmentSvg: svgFor(MODEL),
  });
  const res = await client.drawioUpdate(
    "page1",
    "#0",
    UPDATED_MODEL,
    mxHash(normalizeXml(MODEL)),
  );
  assert.equal(res.success, true);

  const drawios = findDrawio(calls.mutations[0].doc);
  assert.equal(drawios.length, 2);
  // Node #0 repointed to the NEW attachment ("att-1" from the stub) and dims.
  assert.equal(drawios[0].attrs.attachmentId, "att-1");
  assert.equal(drawios[0].attrs.width, 340);
  assert.match(drawios[0].attrs.src, /^\/api\/files\/att-1\//);
  // Node #1 (the sibling copy) is untouched despite sharing the old attachmentId.
  assert.equal(drawios[1].attrs.attachmentId, "shared");
  assert.equal(drawios[1].attrs.width, 200);
  assert.equal(drawios[1].attrs.src, "/api/files/shared/x.svg");
});
