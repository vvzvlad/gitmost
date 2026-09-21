// Unit tests for the ELK auto-layout (issue #424, part 4). Acceptance #3: a
// 10+ node graph with rough/overlapping coordinates, laid out with ELK, has no
// bbox overlaps and produces no quality warnings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyElkLayout } from "../../build/lib/drawio-layout.js";
import { prepareModel, parseCells } from "../../build/lib/drawio-xml.js";

/** Build a model where every vertex starts stacked at (10,10). */
function stackedGraph(n, edges) {
  let cells = "";
  for (let i = 2; i < 2 + n; i++) {
    cells +=
      `<mxCell id="${i}" value="N${i}" style="rounded=1;html=1;" vertex="1" parent="1">` +
      `<mxGeometry x="10" y="10" width="120" height="60" as="geometry"/></mxCell>`;
  }
  let ei = 0;
  for (const [s, t] of edges) {
    cells +=
      `<mxCell id="e${ei++}" edge="1" parent="1" source="${s}" target="${t}">` +
      `<mxGeometry relative="1" as="geometry"/></mxCell>`;
  }
  return (
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    cells +
    "</root></mxGraphModel>"
  );
}

test("acceptance #3: a 10-node graph with rough coords lays out with no warnings", async () => {
  const edges = [
    [2, 3], [2, 4], [3, 5], [4, 5], [5, 6],
    [6, 7], [6, 8], [7, 9], [8, 10], [9, 11], [10, 11],
  ];
  const model = stackedGraph(10, edges);

  // Before: everything is stacked at (10,10) -> lots of overlap warnings.
  const before = prepareModel(model);
  assert.ok(before.warnings.length > 0, "the stacked input should warn");

  const laid = await applyElkLayout(model);
  const after = prepareModel(laid);
  assert.equal(
    after.warnings.length,
    0,
    `ELK layout should clear all warnings, got: ${after.warnings.join(" | ")}`,
  );
  // Same number of user cells survived the layout.
  assert.equal(after.cellCount, before.cellCount);
});

test("ELK honours nested containers as compound nodes (no warnings, children stay nested)", async () => {
  const model =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="g" value="VPC" style="container=1;dropTarget=1;fillColor=none;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="100" as="geometry"/></mxCell>' +
    '<mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="g"><mxGeometry width="120" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="b" value="B" style="rounded=1;" vertex="1" parent="g"><mxGeometry width="120" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="c" value="C" style="rounded=1;" vertex="1" parent="1"><mxGeometry width="120" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="ab" edge="1" parent="g" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '<mxCell id="bc" edge="1" parent="1" source="b" target="c"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";
  const laid = await applyElkLayout(model);
  const cells = parseCells(laid);
  const byId = Object.fromEntries(cells.map((c) => [c.id, c]));
  // Children keep their container parent; the container was sized to hold them.
  assert.equal(byId.a.parent, "g");
  assert.equal(byId.b.parent, "g");
  assert.ok((byId.g.geometry.width ?? 0) >= 260, "container widened to fit children");
  const after = prepareModel(laid);
  assert.equal(after.warnings.length, 0, after.warnings.join(" | "));
});

test("edges and cell count are preserved by layout", async () => {
  const model = stackedGraph(4, [[2, 3], [3, 4], [4, 5]]);
  const laid = await applyElkLayout(model);
  const cells = parseCells(laid);
  assert.equal(cells.filter((c) => c.edge).length, 3);
  assert.equal(cells.filter((c) => c.vertex).length, 4);
});

test("DoS guard: a graph over the node cap is returned unchanged, quickly", async () => {
  // 600 vertices > ELK_MAX_NODES (500): the layout must be SKIPPED and the
  // input returned verbatim, without ever handing the graph to elkjs. This
  // exercises the cap path that bounds the in-process, event-loop-blocking
  // layout on LLM-supplied XML.
  const model = stackedGraph(600, []);
  const t0 = Date.now();
  const laid = await applyElkLayout(model);
  const dt = Date.now() - t0;
  // normalizeInput may reserialize, but geometry must be untouched: every
  // vertex is still stacked at (10,10), i.e. no ELK coordinates were applied.
  const cells = parseCells(laid);
  const verts = cells.filter((c) => c.vertex);
  assert.equal(verts.length, 600, "all vertices survived");
  for (const v of verts) {
    assert.equal(v.geometry.x, 10, "x untouched -> layout was skipped");
    assert.equal(v.geometry.y, 10, "y untouched -> layout was skipped");
  }
  // Returning the input without an ELK pass is essentially instant; assert it
  // did not hang. Generous bound to stay non-flaky on a loaded CI box.
  assert.ok(dt < 2000, `cap path should be fast, took ${dt}ms`);
});

/** Build a layered DAG near the caps: `n` vertices, up to ~2 edges each into the
 * next layer of `layerSize`. Used as a real worst-case graph for the benchmark. */
function layeredGraph(n, layerSize) {
  let cells = "";
  for (let i = 2; i < 2 + n; i++) {
    cells +=
      `<mxCell id="${i}" value="N${i}" style="rounded=1;html=1;" vertex="1" parent="1">` +
      `<mxGeometry x="10" y="10" width="120" height="60" as="geometry"/></mxCell>`;
  }
  let ei = 0;
  for (let i = 2; i < 2 + n; i++) {
    for (const off of [layerSize, layerSize + 1]) {
      const t = i + off;
      if (t < 2 + n) cells += `<mxCell id="e${ei++}" edge="1" parent="1" source="${i}" target="${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
    }
  }
  return (
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    cells +
    "</root></mxGraphModel>"
  );
}

test("terminate-on-timeout: a layout that exceeds the wall-clock ceiling is hard-killed and the original model is returned (#486)", async () => {
  // A 1ms ceiling fires before the worker can even finish loading elkjs, so the
  // parent must terminate() the worker and fall back to the ORIGINAL model. On
  // the OLD in-process race this timer could never fire while the SAME thread was
  // blocked inside elkjs — the fallback path was unreachable; here it works.
  const prev = process.env.DRAWIO_ELK_TIMEOUT_MS;
  process.env.DRAWIO_ELK_TIMEOUT_MS = "1";
  try {
    const model = layeredGraph(400, 20);
    const t0 = Date.now();
    const laid = await applyElkLayout(model);
    const dt = Date.now() - t0;
    // Original geometry is preserved verbatim: every vertex is still stacked at
    // (10,10), proving NO ELK coordinates were applied (the pass was killed).
    const verts = parseCells(laid).filter((c) => c.vertex);
    assert.equal(verts.length, 400, "all vertices survived the fallback");
    for (const v of verts) {
      assert.equal(v.geometry.x, 10, "x untouched -> layout was terminated");
      assert.equal(v.geometry.y, 10, "y untouched -> layout was terminated");
    }
    // The kill is prompt: terminate() returns the call well under the natural
    // layout time for a 400-node graph.
    assert.ok(dt < 2000, `terminate path should be prompt, took ${dt}ms`);
  } finally {
    if (prev === undefined) delete process.env.DRAWIO_ELK_TIMEOUT_MS;
    else process.env.DRAWIO_ELK_TIMEOUT_MS = prev;
  }
});

test("benchmark guard: a worst-case graph AT the cap lays out without wedging the main event loop (#486)", async () => {
  // ~500 nodes / ~1000 edges — a real worst case at the node/edge caps. The
  // layout runs on a WORKER thread, so the MAIN event loop must stay responsive
  // throughout: a timer scheduled on the main thread keeps firing while ELK
  // churns. On the OLD synchronous-on-main-thread code this counter would be
  // pinned at 0 for the whole layout (event loop wedged) — exactly the prod fire.
  const model = layeredGraph(500, 20);
  let mainLoopTicks = 0;
  const iv = setInterval(() => {
    mainLoopTicks++;
  }, 2);
  const t0 = Date.now();
  const laid = await applyElkLayout(model);
  const dt = Date.now() - t0;
  clearInterval(iv);

  assert.ok(
    mainLoopTicks > 0,
    "main event loop must stay responsive while ELK runs on the worker",
  );
  // Benchmark guard: the worst-case graph actually LAYS OUT within the default
  // ceiling (it did not fall back). At least one vertex moved off the stack.
  const verts = parseCells(laid).filter((c) => c.vertex);
  assert.equal(verts.length, 500, "all vertices survived");
  const moved = verts.some((v) => v.geometry.x !== 10 || v.geometry.y !== 10);
  assert.ok(moved, "layout was applied (did not time out / fall back)");
  // Sanity ceiling. `dt` is the TOTAL round-trip (worker-thread startup + elkjs
  // load + IPC + the layout), so it must allow headroom ABOVE the internal
  // 5000ms ELK budget (ELK_TIMEOUT_DEFAULT_MS) — a loaded CI runner legitimately needs
  // a few extra seconds of startup. A real regression (the event loop wedged, or
  // no fallback) is already caught by the assertions above; this only guards
  // against a catastrophic hang, so a generous bound is correct.
  assert.ok(dt < 10000, `worst-case layout should be under the ceiling, took ${dt}ms`);
});

test("layout is best-effort: an empty/degenerate model is returned intact", async () => {
  const model =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
  const laid = await applyElkLayout(model);
  // No vertices -> unchanged, still lints clean.
  const after = prepareModel(laid);
  assert.equal(after.cellCount, 0);
});
