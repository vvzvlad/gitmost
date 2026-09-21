// Unit tests for the pure-TS schematic SVG preview (issue #423). Asserts that
// the preview emits well-formed SVG covering each primitive (rect/ellipse/
// rhombus/edge), resolves container-relative coordinates to absolute, and that
// the full `.drawio.svg` wrapper parses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderDiagramShapes } from "../../build/lib/drawio-preview.js";
import {
  parseCells,
  computeBBox,
  buildDrawioSvg,
  normalizeXml,
} from "../../build/lib/drawio-xml.js";

const { window } = new JSDOM("");
function parseSvg(svg) {
  const doc = new window.DOMParser().parseFromString(svg, "application/xml");
  const err = doc.getElementsByTagName("parsererror");
  assert.equal(err.length, 0, `SVG did not parse: ${err[0]?.textContent}`);
  return doc;
}

const MODEL =
  '<mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Box &amp; Co" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="3" value="Circle" style="ellipse;fillColor=#d5e8d4;" vertex="1" parent="1">' +
  '<mxGeometry x="240" y="40" width="80" height="80" as="geometry"/></mxCell>' +
  '<mxCell id="5" value="Dec" style="rhombus;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="160" width="100" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="4" value="link" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>' +
  '</root></mxGraphModel>';

test("renderDiagramShapes emits rect, ellipse, polygon and a line", () => {
  const cells = parseCells(MODEL);
  const inner = renderDiagramShapes(cells, computeBBox(cells));
  assert.ok(inner.includes("<rect"), "has a rect");
  assert.ok(inner.includes("<ellipse"), "has an ellipse");
  assert.ok(inner.includes("<polygon"), "has a polygon (rhombus)");
  assert.ok(inner.includes("<line"), "has an edge line");
  // Labels are HTML-escaped.
  assert.ok(inner.includes("Box &amp; Co"));
});

test("the full .drawio.svg wrapper parses as valid XML", () => {
  const cells = parseCells(MODEL);
  const bbox = computeBBox(cells);
  const inner = renderDiagramShapes(cells, bbox);
  const svg = buildDrawioSvg(normalizeXml(MODEL), inner, bbox);
  const doc = parseSvg(svg);
  assert.equal(doc.documentElement.tagName, "svg");
  assert.ok(doc.documentElement.getAttribute("content"), "carries content=");
  // The visible children exist.
  assert.ok(doc.getElementsByTagName("rect").length >= 1);
});

test("container children resolve to absolute coordinates", () => {
  // A group at (100,100) with a child rect at relative (10,10,20,20) -> abs 110,110.
  const model =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="g" style="group;" vertex="1" parent="1"><mxGeometry x="100" y="100" width="200" height="200" as="geometry"/></mxCell>' +
    '<mxCell id="c" value="in" vertex="1" parent="g"><mxGeometry x="10" y="10" width="20" height="20" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const cells = parseCells(model);
  const inner = renderDiagramShapes(cells, computeBBox(cells));
  // The child rect must be placed at absolute x=110,y=110.
  assert.ok(/<rect x="110" y="110"/.test(inner), `expected abs child rect, got: ${inner}`);
});

test("unknown stencil (shape=mxgraph.*) degrades to a labeled rectangle", () => {
  const model =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="AWS" style="shape=mxgraph.aws4.lambda;" vertex="1" parent="1">' +
    '<mxGeometry x="0" y="0" width="60" height="60" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const cells = parseCells(model);
  const inner = renderDiagramShapes(cells, computeBBox(cells));
  assert.ok(inner.includes("<rect"), "unknown stencil -> rect");
  assert.ok(inner.includes(">AWS<"), "keeps the label");
});
