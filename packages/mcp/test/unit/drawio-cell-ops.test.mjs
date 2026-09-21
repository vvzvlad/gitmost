// Unit tests for the drawioEditCells operations (issue #425, acceptance #4):
// add / update / delete applied to the parsed model, with a cascade delete that
// removes container children AND every connected edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCellOps, CellOpsError } from "../../build/lib/drawio-cell-ops.js";
import { parseCells } from "../../build/lib/drawio-xml.js";

const MODEL =
  "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>" +
  '<mxCell id="grp" value="G" style="container=1;fillColor=none;" vertex="1" parent="1">' +
  '<mxGeometry x="0" y="0" width="300" height="200" as="geometry"/></mxCell>' +
  '<mxCell id="c1" value="Child1" style="rounded=1;" vertex="1" parent="grp">' +
  '<mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="c2" value="Child2" style="rounded=1;" vertex="1" parent="grp">' +
  '<mxGeometry x="10" y="80" width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="out" value="Outside" style="rounded=1;" vertex="1" parent="1">' +
  '<mxGeometry x="400" y="10" width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="e1" style="" edge="1" parent="1" source="c1" target="out">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>' +
  '<mxCell id="e2" style="" edge="1" parent="1" source="out" target="c2">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>' +
  "</root></mxGraphModel>";

const ids = (xml) =>
  parseCells(xml)
    .filter((c) => c.id !== "0" && c.id !== "1")
    .map((c) => c.id)
    .sort();

test("update changes ONLY the targeted cell", () => {
  const out = applyCellOps(MODEL, [
    {
      op: "update",
      cellId: "c1",
      xml:
        '<mxCell id="c1" value="Renamed" style="rounded=1;" vertex="1" parent="grp">' +
        '<mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>',
    },
  ]);
  const cells = parseCells(out);
  assert.equal(cells.find((c) => c.id === "c1").value, "Renamed");
  // Every OTHER cell is untouched.
  assert.equal(cells.find((c) => c.id === "c2").value, "Child2");
  assert.equal(cells.find((c) => c.id === "out").value, "Outside");
  assert.deepEqual(ids(out), ids(MODEL));
});

test("delete of a container removes its children AND the connected edges", () => {
  const out = applyCellOps(MODEL, [{ op: "delete", cellId: "grp" }]);
  // grp + c1 + c2 gone (cascade to children); e1 (c1->out) and e2 (out->c2)
  // gone (cascade to connected edges); "out" survives.
  assert.deepEqual(ids(out), ["out"]);
});

test("delete of a leaf only cascades to its connected edges, not siblings", () => {
  const out = applyCellOps(MODEL, [{ op: "delete", cellId: "c1" }]);
  // c1 gone + e1 (c1->out) gone; c2, out, grp, e2 survive.
  assert.deepEqual(ids(out), ["c2", "e2", "grp", "out"]);
});

test("add appends a new cell", () => {
  const out = applyCellOps(MODEL, [
    {
      op: "add",
      xml:
        '<mxCell id="new1" value="N" style="rounded=1;" vertex="1" parent="1">' +
        '<mxGeometry x="500" y="10" width="80" height="40" as="geometry"/></mxCell>',
    },
  ]);
  assert.ok(parseCells(out).some((c) => c.id === "new1"));
});

test("delete never removes the sentinels", () => {
  const out = applyCellOps(MODEL, [{ op: "delete", cellId: "out" }]);
  const cells = parseCells(out);
  assert.ok(cells.some((c) => c.id === "0"));
  assert.ok(cells.some((c) => c.id === "1"));
});

test("errors: unknown update/delete target, duplicate add id, id mismatch", () => {
  assert.throws(
    () => applyCellOps(MODEL, [{ op: "update", cellId: "ghost", xml: '<mxCell id="ghost"/>' }]),
    /does not exist/,
  );
  assert.throws(
    () => applyCellOps(MODEL, [{ op: "delete", cellId: "ghost" }]),
    /does not exist/,
  );
  assert.throws(
    () => applyCellOps(MODEL, [{ op: "add", xml: '<mxCell id="c1"/>' }]),
    /already exists/,
  );
  assert.throws(
    () =>
      applyCellOps(MODEL, [
        { op: "update", cellId: "c1", xml: '<mxCell id="c2"/>' },
      ]),
    /ids are stable/,
  );
  assert.throws(() => applyCellOps(MODEL, []), CellOpsError);
});

test("an add op with two cells or a missing id is rejected", () => {
  assert.throws(
    () => applyCellOps(MODEL, [{ op: "add", xml: '<mxCell id="a"/><mxCell id="b"/>' }]),
    /exactly one <mxCell>/,
  );
  assert.throws(
    () => applyCellOps(MODEL, [{ op: "add", xml: '<mxCell value="x"/>' }]),
    /missing an id/,
  );
});

// --- SUGGESTION #5: sentinel cells are protected from delete ------------------

test("delete targeting a sentinel id is rejected (no wipe of the diagram body)", () => {
  for (const sid of ["0", "1"]) {
    assert.throws(
      () => applyCellOps(MODEL, [{ op: "delete", cellId: sid }]),
      (e) => e instanceof CellOpsError && /cannot delete sentinel cell/.test(e.message),
    );
  }
  // A normal delete still works and the sentinels remain intact.
  const out = applyCellOps(MODEL, [{ op: "delete", cellId: "out" }]);
  const remaining = parseCells(out).map((c) => c.id);
  assert.ok(remaining.includes("0") && remaining.includes("1"), "sentinels survive");
});
