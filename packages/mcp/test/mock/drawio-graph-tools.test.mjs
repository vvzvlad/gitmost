// Contract tests for the stage-3 drawio client methods (issue #425):
// drawioEditCells / drawioFromGraph / drawioFromMermaid. Same seam-override
// pattern as drawio-tools.test.mjs: a DocmostClient subclass stubs the I/O seams
// so the tool logic runs without a live Docmost / collab socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocmostClient } from "../../build/client.js";
import {
  buildDrawioSvg,
  normalizeXml,
  mxHash,
  decodeDrawioSvg,
  parseCells,
} from "../../build/lib/drawio-xml.js";

const DRAWIO_SCHEMA_ATTRS = new Set([
  "src", "title", "alt", "width", "height", "size", "aspectRatio", "align", "attachmentId",
]);
function applyDrawioSchemaDrop(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "drawio" && node.attrs && typeof node.attrs === "object") {
    for (const key of Object.keys(node.attrs))
      if (!DRAWIO_SCHEMA_ATTRS.has(key)) delete node.attrs[key];
  }
  if (Array.isArray(node.content)) for (const c of node.content) applyDrawioSchemaDrop(c);
}

function svgFor(model, bbox = { width: 400, height: 300 }) {
  return buildDrawioSvg(normalizeXml(model), "<g/>", bbox);
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
        id: pageId, slugId: "s", title: "P", spaceId: "sp",
        content: pageDoc ?? { type: "doc", content: [] },
      };
    }
    async uploadAttachmentBuffer(pageId, buffer, fileName) {
      const id = `att-${calls.uploads.length + 1}`;
      calls.uploads.push({ pageId, fileName, svg: buffer.toString("utf-8") });
      return { id, fileName, fileSize: buffer.length };
    }
    async fetchAttachmentText() {
      return attachmentSvg;
    }
    mutatePage(pageId, token, apiUrl, transform) {
      const clone = structuredClone(pageDoc ?? { type: "doc", content: [] });
      const doc = transform(clone);
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

// A stored diagram: a group with two children and an edge.
const STORED =
  "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>" +
  '<mxCell id="grp" value="G" style="container=1;fillColor=none;" vertex="1" parent="1">' +
  '<mxGeometry x="0" y="0" width="300" height="200" as="geometry"/></mxCell>' +
  '<mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="grp">' +
  '<mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="b" value="B" style="rounded=1;" vertex="1" parent="grp">' +
  '<mxGeometry x="10" y="90" width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="e" style="" edge="1" parent="grp" source="a" target="b">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>' +
  "</root></mxGraphModel>";

function drawioPageDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "drawio",
        attrs: {
          id: "d1", src: "/api/files/att-1/diagram.drawio.svg",
          attachmentId: "att-1", width: 400, height: 300,
        },
      },
    ],
  };
}

// --- drawioEditCells --------------------------------------------------------

test("drawioEditCells: applies ops and repoints the node (current baseHash)", async () => {
  const { client, calls } = makeClient({
    pageDoc: drawioPageDoc(),
    attachmentSvg: svgFor(STORED),
  });
  const baseHash = mxHash(normalizeXml(STORED));
  const res = await client.drawioEditCells(
    "page1",
    "d1",
    [
      {
        op: "update",
        cellId: "a",
        xml:
          '<mxCell id="a" value="Renamed" style="rounded=1;" vertex="1" parent="grp">' +
          '<mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>',
      },
    ],
    baseHash,
  );
  assert.equal(res.success, true);
  assert.equal(calls.uploads.length, 1);
  const written = decodeDrawioSvg(calls.uploads[0].svg);
  const cells = parseCells(written);
  assert.equal(cells.find((c) => c.id === "a").value, "Renamed");
  assert.equal(cells.find((c) => c.id === "b").value, "B"); // untouched
  const n = findDrawio(calls.mutations[0].doc)[0];
  // The stub numbers uploads from 1; this edit is the first upload -> att-1.
  assert.equal(n.attrs.attachmentId, "att-1");
});

test("drawioEditCells: delete of the container cascades to children + edge", async () => {
  const { client, calls } = makeClient({
    pageDoc: drawioPageDoc(),
    attachmentSvg: svgFor(STORED),
  });
  const baseHash = mxHash(normalizeXml(STORED));
  await client.drawioEditCells("page1", "d1", [{ op: "delete", cellId: "grp" }], baseHash);
  const written = decodeDrawioSvg(calls.uploads[0].svg);
  const ids = parseCells(written).filter((c) => c.id !== "0" && c.id !== "1").map((c) => c.id);
  assert.deepEqual(ids, [], "grp + a + b + edge all cascaded away");
});

test("drawioEditCells: stale baseHash -> conflict, no upload", async () => {
  const { client, calls } = makeClient({
    pageDoc: drawioPageDoc(),
    attachmentSvg: svgFor(STORED),
  });
  await assert.rejects(
    () => client.drawioEditCells("page1", "d1", [{ op: "delete", cellId: "a" }], "stale"),
    /conflict/,
  );
  assert.equal(calls.uploads.length, 0);
});

test("drawioEditCells: baseHash is mandatory", async () => {
  const { client } = makeClient({ pageDoc: drawioPageDoc(), attachmentSvg: svgFor(STORED) });
  await assert.rejects(
    () => client.drawioEditCells("page1", "d1", [{ op: "delete", cellId: "a" }], ""),
    /baseHash is mandatory/,
  );
});

// --- drawioFromGraph --------------------------------------------------------

test("drawioFromGraph: builds a diagram from a graph and inserts a node", async () => {
  const pageDoc = { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [] }] };
  const { client, calls } = makeClient({ pageDoc });
  const res = await client.drawioFromGraph(
    "page1",
    { position: "append" },
    {
      nodes: [
        { id: "api", label: "API", kind: "gateway", icon: "aws:api_gateway", group: "vpc" },
        { id: "fn", label: "Handler", kind: "service", icon: "aws:lambda", group: "vpc" },
        { id: "db", label: "Orders", kind: "db", icon: "aws:dynamodb" },
      ],
      groups: [{ id: "vpc", label: "VPC" }],
      edges: [{ from: "api", to: "fn", kind: "sync" }, { from: "fn", to: "db", kind: "async" }],
    },
    "LR",
    "default",
  );
  assert.equal(res.success, true);
  assert.equal(res.nodeId, "#1");
  assert.equal(res.iconsMissing.length, 0, `unresolved: ${res.iconsMissing}`);
  assert.equal(res.iconsResolved, 3);
  // The uploaded model decodes back and carries the group + nodes.
  const written = decodeDrawioSvg(calls.uploads[0].svg);
  const cells = parseCells(written);
  assert.ok(cells.some((c) => c.id === "vpc"));
  assert.ok(cells.some((c) => c.id === "api"));
  // Group is transparent.
  const vpc = cells.find((c) => c.id === "vpc");
  assert.equal(vpc.styleMap.fillColor, "none");
  assert.equal(vpc.styleMap.container, "1");
});

test("drawioFromGraph: an invalid graph throws before any upload", async () => {
  const { client, calls } = makeClient({ pageDoc: { type: "doc", content: [] } });
  await assert.rejects(
    () => client.drawioFromGraph("page1", { position: "append" }, { nodes: [] }),
    /non-empty/,
  );
  assert.equal(calls.uploads.length, 0);
});

test("drawioFromGraph incremental into an existing node keeps prior coords", async () => {
  // The stored diagram has a,b at known coords; add a new node c incrementally.
  const { client, calls } = makeClient({
    pageDoc: drawioPageDoc(),
    attachmentSvg: svgFor(STORED),
  });
  const res = await client.drawioFromGraph(
    "page1",
    { position: "append" },
    {
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C new" },
      ],
      edges: [{ from: "b", to: "c" }],
    },
    undefined,
    undefined,
    "incremental",
    "d1", // target the existing diagram
  );
  assert.equal(res.success, true);
  const written = decodeDrawioSvg(calls.uploads[0].svg);
  const cells = parseCells(written);
  const a = cells.find((c) => c.id === "a");
  const b = cells.find((c) => c.id === "b");
  // Existing coords preserved (the stored a/b absolute coords from STORED).
  assert.equal(a.geometry.x, 10);
  assert.equal(a.geometry.y, 10);
  assert.equal(b.geometry.x, 10);
  assert.equal(b.geometry.y, 90);
  assert.ok(cells.some((c) => c.id === "c"), "new node c added");
});

// --- drawioFromMermaid ------------------------------------------------------

test("drawioFromMermaid: converts a flowchart and inserts a diagram", async () => {
  const pageDoc = { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [] }] };
  const { client, calls } = makeClient({ pageDoc });
  const res = await client.drawioFromMermaid(
    "page1",
    { position: "append" },
    "flowchart LR\n A[Start] --> B{Choose}\n B -->|yes| C[Done]\n B -->|no| D[Stop]",
  );
  assert.equal(res.success, true);
  const written = decodeDrawioSvg(calls.uploads[0].svg);
  const cells = parseCells(written);
  for (const id of ["A", "B", "C", "D"]) {
    assert.ok(cells.some((c) => c.id === id), `node ${id} present`);
  }
});

test("drawioFromMermaid: a non-flowchart is rejected, no upload", async () => {
  const { client, calls } = makeClient({ pageDoc: { type: "doc", content: [] } });
  await assert.rejects(
    () => client.drawioFromMermaid("page1", { position: "append" }, "sequenceDiagram\n A->>B: x"),
    /only 'flowchart'\/'graph' is supported/,
  );
  assert.equal(calls.uploads.length, 0);
});
