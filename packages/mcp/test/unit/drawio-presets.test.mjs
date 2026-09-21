// Snapshot + invariant tests for the semantic presets (issue #425, acceptance
// #5): every node kind has a style-string per preset, and colorblind-safe uses
// only the Okabe-Ito palette (no problematic color pairs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPreset,
  genericNodeStyle,
  edgeStyle,
  groupStyle,
  NODE_KINDS,
  EDGE_KINDS,
  PRESET_NAMES,
} from "../../build/lib/drawio-presets.js";

// The Okabe-Ito qualitative palette (8 colours distinguishable under the common
// colour-vision deficiencies). colorblind-safe MUST draw its strokes from here.
const OKABE_ITO = [
  "#000000", "#e69f00", "#56b4e9", "#009e73",
  "#f0e442", "#0072b2", "#d55e00", "#cc79a7",
].map((s) => s.toLowerCase());

// The exact base-palette fills from the issue's table (a snapshot: a change to
// the default palette is a deliberate, reviewed edit — this catches accidents).
const DEFAULT_FILLS = {
  service: "#dae8fc",
  db: "#d5e8d4",
  queue: "#fff2cc",
  gateway: "#ffe6cc",
  error: "#f8cecc",
  external: "#f5f5f5",
  security: "#e1d5e7",
};
const DEFAULT_STROKES = {
  service: "#6c8ebf",
  db: "#82b366",
  queue: "#d6b656",
  gateway: "#d79b00",
  error: "#b85450",
  external: "#666666",
  security: "#9673a6",
};

test("every node kind has a style-string in every preset", () => {
  for (const p of PRESET_NAMES) {
    const preset = getPreset(p);
    for (const kind of NODE_KINDS) {
      const style = genericNodeStyle(preset, kind);
      assert.match(style, /fillColor=#[0-9a-fA-F]{6}/, `${p}/${kind} has a fill`);
      assert.match(style, /strokeColor=#[0-9a-fA-F]{6}/, `${p}/${kind} has a stroke`);
      assert.match(style, /fontColor=#[0-9a-fA-F]{6}/, `${p}/${kind} has a font`);
    }
  }
});

test("default preset matches the issue's palette snapshot", () => {
  const preset = getPreset("default");
  for (const kind of NODE_KINDS) {
    const style = genericNodeStyle(preset, kind);
    assert.ok(
      style.includes(`fillColor=${DEFAULT_FILLS[kind]}`),
      `default/${kind} fill ${DEFAULT_FILLS[kind]}`,
    );
    assert.ok(
      style.includes(`strokeColor=${DEFAULT_STROKES[kind]}`),
      `default/${kind} stroke ${DEFAULT_STROKES[kind]}`,
    );
  }
});

test("colorblind-safe strokes come ONLY from the Okabe-Ito palette", () => {
  const preset = getPreset("colorblind-safe");
  const usedStrokes = new Set();
  for (const kind of NODE_KINDS) {
    const stroke = preset.nodes[kind].strokeColor.toLowerCase();
    assert.ok(
      OKABE_ITO.includes(stroke),
      `colorblind-safe/${kind} stroke ${stroke} is NOT Okabe-Ito`,
    );
    usedStrokes.add(stroke);
  }
  // No two kinds share a stroke (each is a distinct, distinguishable hue) — the
  // "no problematic color pairs" acceptance: distinct Okabe-Ito hues.
  assert.equal(
    usedStrokes.size,
    NODE_KINDS.length,
    "each kind gets a distinct Okabe-Ito stroke",
  );
});

test("edge kinds: sync solid, async dashed, error red-dashed", () => {
  const preset = getPreset("default");
  const sync = edgeStyle(preset, "sync");
  const async_ = edgeStyle(preset, "async");
  const error = edgeStyle(preset, "error");
  assert.doesNotMatch(sync, /dashed=1/, "sync is solid");
  assert.match(async_, /dashed=1/, "async is dashed");
  assert.match(error, /dashed=1/, "error is dashed");
  assert.match(error, /strokeColor=#DD344C/i, "error is red");
  // An unknown edge kind falls back to sync (solid).
  assert.doesNotMatch(edgeStyle(preset, "weird"), /dashed=1/);
});

test("group style is always transparent (fillColor=none;container=1;dropTarget=1)", () => {
  for (const p of PRESET_NAMES) {
    const style = groupStyle(getPreset(p));
    assert.match(style, /fillColor=none/, `${p} group transparent`);
    assert.match(style, /container=1/, `${p} group is a container`);
    assert.match(style, /dropTarget=1/, `${p} group is a drop target`);
  }
});

test("EDGE_KINDS / NODE_KINDS constants match the palette", () => {
  const preset = getPreset("default");
  for (const k of NODE_KINDS) assert.ok(preset.nodes[k], `node kind ${k}`);
  for (const k of EDGE_KINDS) assert.ok(preset.edges[k], `edge kind ${k}`);
});
