// Unit tests for the geometry quality-warnings (issue #424, part 5). Acceptance
// #4: every warning has a positive AND a negative case, and warnings NEVER block
// the write (prepareModel returns them, it does not throw).
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareModel } from "../../build/lib/drawio-xml.js";

function model(cells) {
  return (
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    cells +
    "</root></mxGraphModel>"
  );
}
function warnings(cells) {
  return prepareModel(model(cells)).warnings;
}
function has(ws, rule) {
  return ws.some((w) => w.startsWith(`[${rule}]`));
}
function v(id, x, y, w = 120, h = 60, value = "", style = "rounded=1;html=1;", parent = "1") {
  return (
    `<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="${parent}">` +
    `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`
  );
}
function edge(id, s, t, parent = "1") {
  return (
    `<mxCell id="${id}" edge="1" parent="${parent}" source="${s}" target="${t}">` +
    `<mxGeometry relative="1" as="geometry"/></mxCell>`
  );
}

test("shape-overlap: positive and negative", () => {
  assert.ok(has(warnings(v("a", 0, 0) + v("b", 50, 20)), "shape-overlap"));
  assert.ok(!has(warnings(v("a", 0, 0) + v("b", 300, 0)), "shape-overlap"));
});

test("shape-overlap: a container over its own child does NOT warn", () => {
  const cells =
    '<mxCell id="g" value="G" style="container=1;fillColor=none;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="400" height="200" as="geometry"/></mxCell>' +
    v("a", 30, 40, 120, 60, "", "rounded=1;", "g");
  assert.ok(!has(warnings(cells), "shape-overlap"));
});

test("edge-through-shape: positive and negative", () => {
  // A -> B passes straight through C sitting on the line.
  const pos =
    v("a", 0, 0, 60, 60) + v("c", 200, 0, 60, 60) + v("b", 400, 0, 60, 60) + edge("e", "a", "b");
  assert.ok(has(warnings(pos), "edge-through-shape"));
  // C moved off the line -> no crossing.
  const neg =
    v("a", 0, 0, 60, 60) + v("c", 200, 300, 60, 60) + v("b", 400, 0, 60, 60) + edge("e", "a", "b");
  assert.ok(!has(warnings(neg), "edge-through-shape"));
});

test("edge-overlap: positive (duplicate) and negative", () => {
  const pos = v("a", 0, 0) + v("b", 300, 0) + edge("e1", "a", "b") + edge("e2", "a", "b");
  assert.ok(has(warnings(pos), "edge-overlap"));
  const neg =
    v("a", 0, 0) + v("b", 300, 0) + v("c", 300, 300) + edge("e1", "a", "b") + edge("e2", "a", "c");
  assert.ok(!has(warnings(neg), "edge-overlap"));
});

test("gap-too-small: positive and negative", () => {
  assert.ok(has(warnings(v("a", 0, 0) + v("b", 220, 0)), "gap-too-small")); // 100px gap
  assert.ok(!has(warnings(v("a", 0, 0) + v("b", 300, 0)), "gap-too-small")); // 180px gap
});

test("label-overflow: positive and negative", () => {
  const pos = v("a", 0, 0, 40, 60, "A very long label that does not fit");
  assert.ok(has(warnings(pos), "label-overflow"));
  const neg = v("a", 0, 0, 300, 60, "Short");
  assert.ok(!has(warnings(neg), "label-overflow"));
});

test("label-overflow: a label drawn OUTSIDE the shape (AWS icon) does NOT warn", () => {
  const cells = v(
    "a",
    0,
    0,
    60,
    60,
    "A very long service label below the icon",
    "shape=mxgraph.aws4.resourceIcon;verticalLabelPosition=bottom;verticalAlign=top;html=1;",
  );
  assert.ok(!has(warnings(cells), "label-overflow"));
});

test("out-of-bounds: positive (negative coords) and negative", () => {
  assert.ok(has(warnings(v("a", -50, 10)), "out-of-bounds"));
  assert.ok(!has(warnings(v("a", 10, 10)), "out-of-bounds"));
});

test("warnings never block the write (prepareModel returns, does not throw)", () => {
  const messy = v("a", 0, 0) + v("b", 30, 20) + v("c", 40, 40); // heavy overlap
  const prepared = prepareModel(model(messy));
  assert.ok(prepared.warnings.length > 0, "expected warnings");
  assert.ok(prepared.modelXml.includes("mxGraphModel"), "still produced a model");
  assert.equal(prepared.cellCount, 3);
});
