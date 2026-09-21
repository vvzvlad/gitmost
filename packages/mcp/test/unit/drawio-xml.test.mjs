// Unit tests for the drawio-xml module (issue #423): the linter (a positive
// baseline + a negative case per rule, each asserting rule + cellId), the
// decode chain (plain nested XML AND draw.io's compressed <diagram> via pako),
// encode/round-trip byte-stability, hash stability, style parsing and the
// bounding box.
import { test } from "node:test";
import assert from "node:assert/strict";
import pako from "pako";
import {
  parseStyle,
  lintModel,
  prepareModel,
  normalizeInput,
  normalizeXml,
  mxHash,
  computeBBox,
  parseCells,
  decodeDrawioSvg,
  decodeDrawioFileToModel,
  buildDrawioSvg,
  encodeDrawioFile,
  countUserCells,
  DrawioLintError,
  inflateDiagramPayload,
  MAX_INFLATED_DIAGRAM_BYTES,
  extractDrawioRaster,
  stripRasterAttr,
  DRAWIO_RASTER_ATTR,
  MAX_RASTER_BASE64_LENGTH,
} from "../../build/lib/drawio-xml.js";

// A well-formed model with one vertex and a valid edge to it.
const VALID_MODEL =
  '<mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Hello" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="100" y="100" width="120" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="3" value="Two" style="ellipse;" vertex="1" parent="1">' +
  '<mxGeometry x="300" y="100" width="80" height="80" as="geometry"/></mxCell>' +
  '<mxCell id="4" edge="1" parent="1" source="2" target="3">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>' +
  '</root></mxGraphModel>';

function issuesOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof DrawioLintError, `expected DrawioLintError, got ${e}`);
    return e.issues;
  }
}
const hasRule = (issues, rule, cellId) =>
  issues.some(
    (i) => i.rule === rule && (cellId === undefined || i.cellId === cellId),
  );

// Reverse the attribute-value XML escaping used in the `content=` payload.
const unescapeAttr = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

// --- style parsing ---------------------------------------------------------

test("parseStyle: base stylename + key=value pairs", () => {
  const r = parseStyle("ellipse;fillColor=#ff0000;whiteSpace=wrap;");
  assert.equal(r.baseStyle, "ellipse");
  assert.equal(r.map.fillColor, "#ff0000");
  assert.equal(r.map.whiteSpace, "wrap");
  assert.equal(r.badSegment, undefined);
});

test("parseStyle: flags a segment with two '='", () => {
  const r = parseStyle("a=b=c;");
  assert.equal(r.badSegment, "a=b=c");
});

test("parseStyle: a second bare token is malformed", () => {
  const r = parseStyle("rounded=1;bareword");
  assert.equal(r.badSegment, "bareword");
});

// --- linter: positive baseline ---------------------------------------------

test("lintModel: the canonical valid model passes", () => {
  const { cells } = lintModel(VALID_MODEL);
  assert.equal(cells.length, 5);
});

// --- linter: one negative case per rule ------------------------------------

test("rule well-formed-xml: malformed XML", () => {
  const issues = issuesOf(() => lintModel("<mxGraphModel><root><mxCell id=\"0\"></root>"));
  assert.ok(hasRule(issues, "well-formed-xml"));
  assert.ok(issues[0].position, "carries a line:col position");
});

test("rule structure: root is not mxGraphModel", () => {
  const issues = issuesOf(() => lintModel("<foo><root/></foo>"));
  assert.ok(hasRule(issues, "structure"));
});

test("rule sentinel-cells: missing id=0 / id=1", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "sentinel-cells", "0"));
  assert.ok(hasRule(issues, "sentinel-cells", "1"));
});

test("rule duplicate-id: two cells share an id", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '<mxCell id="2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "duplicate-id", "2"));
});

test("rule vertex-edge-exclusive: cell is both vertex and edge", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" vertex="1" edge="1" parent="1"><mxGeometry as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "vertex-edge-exclusive", "2"));
});

test("rule edge-geometry: self-closed edge without child mxGeometry", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '<mxCell id="3" vertex="1" parent="1"><mxGeometry x="30" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '<mxCell id="4" edge="1" parent="1" source="2" target="3"/>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "edge-geometry", "4"));
});

test("rule edge-endpoint: source/target does not resolve", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '<mxCell id="4" edge="1" parent="1" source="2" target="99"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "edge-endpoint", "4"));
});

test("rule parent-exists: parent points at a missing id", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" vertex="1" parent="42"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "parent-exists", "2"));
});

test("rule no-comments: XML comment present", () => {
  const m =
    '<mxGraphModel><root>' +
    '<!-- a comment --><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "no-comments"));
});

test("rule style-format: malformed style segment (cellId reported)", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" style="rounded=1;a=b=c;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "style-format", "2"));
});

test("rule value-newline: literal newline in a value (cellId reported)", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="line1\nline2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "value-newline", "2"));
});

test("rule value-escaping: unescaped ampersand in a value (cellId reported)", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="A & B" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "value-escaping", "2"));
});

test("rule reserved id: escaped entity value passes (no false positive)", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="A &amp; B &lt;ok&gt;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  assert.doesNotThrow(() => lintModel(m));
});

// --- input normalization ---------------------------------------------------

test("normalizeInput: a list of <mxCell> is wrapped and sentinels added", () => {
  const frag =
    '<mxCell id="2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>';
  const model = normalizeInput(frag);
  assert.ok(model.startsWith("<mxGraphModel"));
  assert.ok(model.includes('<mxCell id="0"/>'));
  assert.ok(model.includes('<mxCell id="1" parent="0"/>'));
  // And it lints clean.
  assert.doesNotThrow(() => lintModel(model));
});

test("normalizeInput: an existing sentinel is not duplicated", () => {
  const frag =
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>';
  const model = normalizeInput(frag);
  const count0 = (model.match(/id="0"/g) || []).length;
  assert.equal(count0, 1);
});

test("prepareModel: returns bbox, cellCount, hash and lints", () => {
  const p = prepareModel(VALID_MODEL);
  assert.equal(p.cellCount, 3); // 2, 3, 4 (sentinels excluded)
  assert.ok(p.bbox.width > 0 && p.bbox.height > 0);
  assert.equal(p.hash, mxHash(normalizeXml(VALID_MODEL)));
});

// --- comment auto-strip (issue #505) ---------------------------------------

// The model organically inserts `<!-- ... -->` into diagram XML. prepareModel
// (the shared path for drawioCreate/drawioUpdate/drawioEditCells) strips them
// BEFORE the lint runs and reports the count as a non-blocking warning, so the
// model never hits a hard [no-comments] error and never regenerates the diagram.
test("prepareModel: strips XML comments, lint passes, warns with the count", () => {
  const m =
    '<mxGraphModel><root>' +
    '<!-- header comment -->' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="Hello" vertex="1" parent="1">' +
    '<!-- inline note -->' +
    '<mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  // Would fail [no-comments] if not stripped first.
  const p = prepareModel(m);
  // Comments are gone from the canonical model.
  assert.ok(!p.modelXml.includes("<!--"));
  assert.ok(!p.modelXml.includes("header comment"));
  assert.ok(!p.modelXml.includes("inline note"));
  // No [no-comments] error was raised (prepareModel returned instead of throwing).
  // A single strip warning naming the count (2) is present.
  assert.ok(p.warnings.includes("stripped 2 XML comment(s)"));
});

test("prepareModel: zero comments emits no strip warning", () => {
  const p = prepareModel(VALID_MODEL);
  assert.ok(!p.warnings.some((w) => w.startsWith("stripped")));
});

test("prepareModel: an entity-escaped <!-- inside a value is NOT stripped", () => {
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="a &lt;!-- x --&gt; b" vertex="1" parent="1">' +
    '<mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const p = prepareModel(m);
  // Nothing was mistaken for a comment node.
  assert.ok(!p.warnings.some((w) => w.startsWith("stripped")));
  // The escaped sequence survives round-trip in the value.
  const cell = p.cells.find((c) => c.id === "2");
  assert.equal(cell.value, "a <!-- x --> b");
});

test("prepareModel: malformed input with a raw <!-- in a value is NOT stripped (no silent truncation)", () => {
  // A literal, UNescaped `<!--` inside an attribute value makes the XML
  // malformed (raw `<` is illegal in a value). The comment-strip is gated on
  // well-formedness, so it must NOT touch this input — otherwise the author's
  // label ` secret ` would be silently deleted and the corrupt diagram accepted.
  // Instead lintModel's value-escaping / well-formed-xml rules must reject it.
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" value="a <!-- secret --> b" vertex="1" parent="1">' +
    '<mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => prepareModel(m));
  // Rejected (threw DrawioLintError) rather than silently accepted.
  assert.ok(issues, "expected prepareModel to reject malformed input");
  // By a real content rule, not swallowed by the strip.
  assert.ok(
    hasRule(issues, "value-escaping", "2") || hasRule(issues, "well-formed-xml"),
    `expected value-escaping/well-formed-xml, got ${JSON.stringify(issues)}`,
  );
});

test("prepareModel: a <!-- --> inside a CDATA section is NOT stripped (no silent corruption)", () => {
  // A CDATA section is well-formed, so the well-formedness gate alone would let
  // the regex delete a literal `<!-- x -->` living inside CDATA text — silent
  // content loss with a false "stripped" success. The CDATA sub-gate must skip
  // the strip; the model then hits the retained no-comments backstop (an explicit
  // error) instead of being silently accepted with a strip warning.
  const m =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="2" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/>' +
    '<foo><![CDATA[keep<!-- x -->keep]]></foo></mxCell>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => prepareModel(m));
  // Rejected (threw), not silently accepted with a strip warning.
  assert.ok(issues, "expected prepareModel to reject rather than silently strip");
  // The no-comments backstop caught the literal comment sequence.
  assert.ok(
    hasRule(issues, "no-comments"),
    `expected no-comments backstop, got ${JSON.stringify(issues)}`,
  );
});

test("no-comments rule still fires when a comment reaches the linter directly", () => {
  // Defense-in-depth: prepareModel strips first, but lintModel itself (the
  // backstop) must still reject a raw comment-bearing model.
  const m =
    '<mxGraphModel><root>' +
    '<!-- unstripped --><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '</root></mxGraphModel>';
  const issues = issuesOf(() => lintModel(m));
  assert.ok(hasRule(issues, "no-comments"));
});

// --- decode chain: plain -----------------------------------------------------

test("decode chain (plain): buildDrawioSvg -> decodeDrawioSvg round-trips byte-stable", () => {
  const model = normalizeXml(VALID_MODEL);
  const svg = buildDrawioSvg(model, "<g/>", { width: 400, height: 200 });
  const decoded = decodeDrawioSvg(svg);
  assert.equal(decoded, model);
});

test("decode chain: entity-encoded content= (draw.io export style) is read directly", () => {
  const model = normalizeXml(VALID_MODEL);
  const file = encodeDrawioFile(model, "Page-1");
  const escaped = file
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" content="${escaped}"></svg>`;
  const decoded = decodeDrawioSvg(svg);
  assert.equal(decoded, model);
});

// --- decode chain: compressed (pako) ---------------------------------------

test("decode chain (compressed pako): human-saved <diagram> payload decodes losslessly", () => {
  const model = normalizeXml(VALID_MODEL);
  // Reproduce draw.io's compression: encodeURIComponent -> raw deflate -> base64.
  const compressed = Buffer.from(
    pako.deflateRaw(encodeURIComponent(model)),
  ).toString("base64");
  const file = `<mxfile host="Electron"><diagram id="abc" name="Page-1">${compressed}</diagram></mxfile>`;
  // Docmost stores the file base64 in content=.
  const contentB64 = Buffer.from(file, "utf-8").toString("base64");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" content="${contentB64}"><image href="x"/></svg>`;
  const decoded = decodeDrawioSvg(svg);
  assert.equal(decoded, model);
});

test("decodeDrawioFileToModel: bare mxGraphModel file returns the model substring", () => {
  const model = normalizeXml(VALID_MODEL);
  assert.equal(decodeDrawioFileToModel(model), model);
});

// --- hash stability --------------------------------------------------------

test("mxHash: stable across inter-tag whitespace, sensitive to content", () => {
  const a = VALID_MODEL;
  const b = VALID_MODEL.replace(/></g, ">\n  <"); // reformat only
  assert.equal(mxHash(a), mxHash(b));
  const c = VALID_MODEL.replace('value="Hello"', 'value="Changed"');
  assert.notEqual(mxHash(a), mxHash(c));
});

// --- bounding box + cell count ---------------------------------------------

test("computeBBox + countUserCells", () => {
  const cells = parseCells(VALID_MODEL);
  const bbox = computeBBox(cells);
  // Vertex 3 spans to x=380,y=180; plus the 20px margin.
  assert.equal(bbox.width, 400);
  assert.equal(bbox.height, 200);
  assert.equal(countUserCells(VALID_MODEL), 3);
});

// --- decompression-bomb guard (Fix 3) --------------------------------------

test("inflateDiagramPayload: a small legitimate payload inflates fine", () => {
  const xml = normalizeXml(VALID_MODEL);
  const base64 = Buffer.from(
    pako.deflateRaw(encodeURIComponent(xml)),
  ).toString("base64");
  assert.equal(inflateDiagramPayload(base64), xml);
});

test("inflateDiagramPayload: rejects an over-cap decompression bomb", () => {
  // A tiny compressed payload that inflates to just over the cap. Highly
  // compressible (all one byte) -> the base64 is small, but the inflated output
  // exceeds MAX_INFLATED_DIAGRAM_BYTES and must be refused before it is fully
  // materialised.
  const bombSize = MAX_INFLATED_DIAGRAM_BYTES + 1024;
  const base64 = Buffer.from(
    pako.deflateRaw(Buffer.alloc(bombSize, 0x41 /* 'A' */)),
  ).toString("base64");
  assert.ok(
    base64.length < 1024 * 1024,
    "the compressed bomb is tiny relative to its inflated size",
  );
  assert.throws(
    () => inflateDiagramPayload(base64),
    /decompression bomb/,
  );
});

test("encode/build: a title with < > \" & round-trips without corrupting the SVG", async () => {
  // A user-supplied title full of XML metacharacters must be escaped so the
  // inner <mxfile> stays well-formed and the outer content="..." attribute is
  // never broken out of. Prove it survives the encode -> build -> decode chain.
  const title = 'A < B > C " D & E';
  const model = normalizeXml(VALID_MODEL);
  const svg = buildDrawioSvg(model, "<g/>", { width: 200, height: 120 }, title);

  // The outer content="..." attribute must not be broken by the title: the raw
  // title metacharacters never appear literally in the SVG markup (they are
  // entity-escaped inside content=, doubly so where the file XML already escaped
  // them inside name="...").
  const contentMatch = /content="([^"]*)"/.exec(svg);
  assert.ok(contentMatch, "SVG has a single well-formed content= attribute");

  // The diagram model still decodes losslessly despite the exotic title.
  assert.equal(decodeDrawioSvg(svg), model);

  // content= is now entity-encoded XML (draw.io's native form), never base64.
  assert.match(contentMatch[1], /^&lt;mxfile/);

  // The file XML is well-formed: the title lives in name="..." as escaped
  // entities, so unescaping recovers the original title byte-for-byte.
  const fileXml = unescapeAttr(contentMatch[1]);
  const nameMatch = /<diagram id="[^"]*" name="([^"]*)">/.exec(fileXml);
  assert.ok(nameMatch, "the diagram name attribute is intact and quote-safe");
  const decodedTitle = nameMatch[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  assert.equal(decodedTitle, title);

  // encodeDrawioFile alone produces the same escaped, well-formed envelope.
  const file = encodeDrawioFile(model, title);
  assert.match(file, /name="A &lt; B &gt; C &quot; D &amp; E">/);
});

// --- #507: content= is entity-encoded XML, never base64 --------------------

// A model whose cell values carry Cyrillic, ё and an em dash — exactly the
// characters draw.io's Latin-1 atob mangles when content= is base64.
const CYRILLIC_MODEL =
  "<mxGraphModel><root>" +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Старт-бит — ёж" style="rounded=1;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="100" y="100" width="120" height="60" as="geometry"/></mxCell>' +
  "</root></mxGraphModel>";

test("#507: buildDrawioSvg writes content= as entity-encoded XML (not base64)", () => {
  const model = normalizeXml(CYRILLIC_MODEL);
  const svg = buildDrawioSvg(model, "<g/>", { width: 200, height: 120 }, "Диаграмма");

  const contentMatch = /content="([^"]*)"/.exec(svg);
  assert.ok(contentMatch, "SVG has a single well-formed content= attribute");
  const content = contentMatch[1];

  // The content= value is the entity-encoded mxfile XML — starts with `&lt;mxfile`.
  assert.match(content, /^&lt;mxfile/, "content= is entity-encoded mxfile XML");
  // It must NOT be a base64 blob: base64 has no XML entities and no literal `<`.
  assert.ok(content.includes("&lt;"), "content= carries XML entities, not base64");

  // Cyrillic / ё / — survive verbatim in the attribute (raw UTF-8, not atob-mangled).
  assert.ok(content.includes("Старт-бит — ёж"), "non-ASCII value is raw UTF-8 in content=");
  assert.ok(content.includes("Диаграмма"), "non-ASCII title is raw UTF-8 in content=");
  // The mojibake that base64+atob would have produced must be absent.
  assert.ok(!content.includes("Ð"), "no Latin-1 mojibake in content=");
});

test("#507: Cyrillic model round-trips byte-stable through buildDrawioSvg -> decodeDrawioSvg", () => {
  const model = normalizeXml(CYRILLIC_MODEL);
  const svg = buildDrawioSvg(model, "<g/>", { width: 200, height: 120 }, "Заголовок — ё");
  assert.equal(decodeDrawioSvg(svg), model);
});

test("#507 back-compat: an OLD base64-form .drawio.svg still decodes losslessly", () => {
  const model = normalizeXml(CYRILLIC_MODEL);
  // Reproduce the pre-fix write path: encodeDrawioFile -> base64 in content=.
  const file = encodeDrawioFile(model, "Старая диаграмма");
  const base64 = Buffer.from(file, "utf-8").toString("base64");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" content="${base64}"><g/></svg>`;
  // No XML entities, purely base64 alphabet — this is the legacy form.
  assert.ok(!base64.includes("<") && !base64.includes("&"));
  assert.equal(decodeDrawioSvg(svg), model);
});

test("#507 negative: non-ASCII in a cell value AND in the title round-trip clean", () => {
  const model = normalizeXml(CYRILLIC_MODEL);
  const title = "Тест — ёмкость № 5";
  const svg = buildDrawioSvg(model, "<g/>", { width: 200, height: 120 }, title);

  // Model recovered byte-for-byte.
  assert.equal(decodeDrawioSvg(svg), model);

  // Title lands in the <diagram name="..."> of the decoded file XML, intact.
  const content = /content="([^"]*)"/.exec(svg)[1];
  const fileXml = unescapeAttr(content);
  const nameMatch = /<diagram id="[^"]*" name="([^"]*)">/.exec(fileXml);
  assert.ok(nameMatch, "diagram name attribute present");
  assert.equal(unescapeAttr(nameMatch[1]), title);
});

// --- #507 F1: literal tab/newline/CR in an attribute value survive the
// content= round-trip. The whole mxfile XML lives in one content="..." attr;
// XML attribute-value normalization collapses a LITERAL tab/newline/CR to a
// single space on DOM read, so the escape must emit numeric char-refs instead.
const CTRL_MODEL =
  "<mxGraphModel><root>" +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="col1\tcol2" style="html=1;\nshadow=0" vertex="1" parent="1">' +
  '<mxGeometry x="10" y="10" width="120" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="3" value="Line1\nLine2\rLine3" vertex="1" parent="1">' +
  '<mxGeometry x="10" y="100" width="120" height="60" as="geometry"/></mxCell>' +
  "</root></mxGraphModel>";

test("#507 F1: literal tab/newline/CR in a value round-trip byte-stable (DOM decode)", () => {
  const svg = buildDrawioSvg(CTRL_MODEL, "<g/>", { width: 200, height: 200 });
  const content = /content="([^"]*)"/.exec(svg)[1];
  // The tab/newline/CR must be emitted as numeric char-refs, never as literal
  // control chars (which DOM attribute-value normalization would eat).
  assert.ok(
    !/[\t\n\r]/.test(content),
    "no literal tab/newline/CR survive in the content= attribute",
  );
  assert.ok(
    content.includes("&#x9;") &&
      content.includes("&#xa;") &&
      content.includes("&#xd;"),
    "tab/newline/CR are emitted as numeric char-refs",
  );
  // Full DOM decode recovers the model byte-for-byte, control chars intact.
  assert.equal(decodeDrawioSvg(svg), CTRL_MODEL);
});

test("#507 F1: regex fallback decodes tab/newline/CR char-refs (agrees with DOM path)", () => {
  const svg = buildDrawioSvg(CTRL_MODEL, "<g/>", { width: 200, height: 200 });
  const content = /content="([^"]*)"/.exec(svg)[1];
  // A bare `&` makes the SVG wrapper malformed, forcing extractContentAttr onto
  // its regex fallback branch. That branch must decode the tab/newline/CR
  // char-refs exactly like the DOM path, or the two decoders diverge.
  const malformedSvg = `<svg content="${content}">&</svg>`;
  assert.equal(decodeDrawioSvg(malformedSvg), CTRL_MODEL);
  // The well-formed (DOM) path yields the identical result.
  assert.equal(decodeDrawioSvg(svg), CTRL_MODEL);
});

// --- embedded browser raster (#629) ----------------------------------------
//
// Shared contract: the browser embeds a real PNG of the diagram into the root
// SVG attribute data-raster="data:image/png;base64,<b64>". The extractor must
// validate the 8-byte PNG signature so a fake/corrupt raster never passes.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A minimal but signature-valid PNG buffer (sig + a few bytes).
const PNG_BYTES = Buffer.concat([PNG_SIG, Buffer.from([0x00, 0x11, 0x22, 0x33])]);
const PNG_B64 = PNG_BYTES.toString("base64");

// Build a `.drawio.svg` carrying a data-raster attribute on the ROOT <svg>.
function svgWithRaster(dataUri, { content = "&lt;mxfile/&gt;" } = {}) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `data-raster="${dataUri}" content="${content}">` +
    `<image href="x"/></svg>`
  );
}

test("#629 DRAWIO_RASTER_ATTR is the shared 'data-raster' constant", () => {
  assert.equal(DRAWIO_RASTER_ATTR, "data-raster");
});

test("#629 extractDrawioRaster: a valid raster -> PNG Buffer with the signature", () => {
  const svg = svgWithRaster(`data:image/png;base64,${PNG_B64}`);
  const png = extractDrawioRaster(svg);
  assert.ok(Buffer.isBuffer(png), "returns a Buffer");
  assert.ok(png.subarray(0, 8).equals(PNG_SIG), "buffer starts with the PNG signature");
  assert.ok(png.equals(PNG_BYTES), "decodes the exact PNG bytes");
});

test("#629 extractDrawioRaster: absent attribute -> null", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile/&gt;"><g/></svg>`;
  assert.equal(extractDrawioRaster(svg), null);
});

test("#629 extractDrawioRaster: wrong mime -> null (never accept a non-png)", () => {
  const jpegUri = `data:image/jpeg;base64,${PNG_B64}`; // png bytes, jpeg prefix
  assert.equal(extractDrawioRaster(svgWithRaster(jpegUri)), null);
  // A bare (non data-URI) value is rejected too.
  assert.equal(extractDrawioRaster(svgWithRaster(PNG_B64)), null);
});

test("#629 extractDrawioRaster: truncated/garbage base64 -> null (signature check)", () => {
  // Valid data-URI prefix but the decoded bytes are NOT a PNG.
  const notPng = Buffer.from("this is not a png at all").toString("base64");
  assert.equal(extractDrawioRaster(svgWithRaster(`data:image/png;base64,${notPng}`)), null);
  // A JPEG signature (FF D8 FF) must not pass as a PNG.
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
  assert.equal(extractDrawioRaster(svgWithRaster(`data:image/png;base64,${jpegBytes}`)), null);
});

test("#629 extractDrawioRaster: oversized attribute -> null without decoding it", () => {
  // A base64 string longer than the cap: must be rejected BEFORE Buffer.from.
  const huge = "A".repeat(MAX_RASTER_BASE64_LENGTH + 8);
  const svg = svgWithRaster(`data:image/png;base64,${huge}`);
  assert.equal(extractDrawioRaster(svg), null);
});

test("#629 extractDrawioRaster: an oversized value whose bytes WOULD be a valid PNG is rejected by the length cap ALONE (memory guard is non-vacuous)", () => {
  // The "A".repeat(...) case above decodes to 0x00-bytes, which the PNG-signature
  // check would ALSO reject — so disabling the length cap leaves it null and the
  // guard goes untested (the reviewer's mutation: 0 failures). Here the oversized
  // bytes START WITH the PNG signature, so ONLY the pre-decode length cap can
  // reject them. Disabling `base64.length > MAX_RASTER_BASE64_LENGTH` makes this
  // decode to a valid PNG Buffer and the assertion turns RED — pinning the guard.
  const nBytes = 6 * 1024 * 1024 + 64; // base64 length then exceeds the 8 MiB cap
  const wouldBeValidPng = Buffer.alloc(nBytes);
  PNG_SIG.copy(wouldBeValidPng, 0); // a valid PNG signature at the front
  const oversized = wouldBeValidPng.toString("base64");
  assert.ok(
    oversized.length > MAX_RASTER_BASE64_LENGTH,
    "precondition: the base64 must exceed the pre-decode cap",
  );
  const svg = svgWithRaster(`data:image/png;base64,${oversized}`);
  // Rejected purely by the length cap — the decoded PNG bytes are never produced.
  assert.equal(extractDrawioRaster(svg), null);
});

test("#629 extractDrawioRaster: reads the ROOT attribute, not a nested element's", () => {
  // A nested element carries a VALID-looking data-raster; the root has none.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile/&gt;">` +
    `<image data-raster="data:image/png;base64,${PNG_B64}" href="x"/></svg>`;
  assert.equal(extractDrawioRaster(svg), null);
});

test("#629 stripRasterAttr: removes ONLY data-raster, leaves content= byte-intact", () => {
  const content = "&lt;mxfile host=&quot;drawio&quot;/&gt;";
  const svg = svgWithRaster(`data:image/png;base64,${PNG_B64}`, { content });
  const stripped = stripRasterAttr(svg);
  assert.ok(!stripped.includes("data-raster"), "data-raster is gone");
  // The content= attribute is untouched, byte for byte.
  assert.equal(/content="([^"]*)"/.exec(stripped)[1], content);
  // A svg without a raster is returned unchanged.
  const plain = `<svg xmlns="x" content="${content}"><g/></svg>`;
  assert.equal(stripRasterAttr(plain), plain);
});

test("#629 round-trip: strip a raster then decodeDrawioSvg still yields the model", () => {
  const inner = "<g/>";
  const base = buildDrawioSvg(normalizeXml(VALID_MODEL), inner, { width: 200, height: 120 });
  // Inject a data-raster onto the root <svg> (as the browser would, Part A).
  const withRaster = base.replace(
    /^<svg /,
    `<svg data-raster="data:image/png;base64,${PNG_B64}" `,
  );
  assert.ok(extractDrawioRaster(withRaster).equals(PNG_BYTES));
  const stripped = stripRasterAttr(withRaster);
  assert.ok(!stripped.includes("data-raster"));
  assert.equal(decodeDrawioSvg(stripped), normalizeXml(VALID_MODEL));
});
