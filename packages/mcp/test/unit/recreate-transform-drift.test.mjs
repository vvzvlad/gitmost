// CONTRACT / DRIFT GUARD: mcp diff vs the vendored editor-ext recreate-transform.
//
// packages/mcp/src/lib/diff.ts computes its document diff with
// `recreateTransform` from the published @fellow/prosemirror-recreate-transform
// package. Docmost's in-app history editor computes the SAME diff with its own
// vendored copy at
// packages/editor-ext/src/lib/recreate-transform/recreateTransform.ts.
// diff.ts's header comment claims the two are "identical" — if they ever drift,
// the headless mcp diff would stop matching what a user sees in the app.
//
// This test guards that claim two ways, on representative doc pairs, using the
// EXACT options diff.ts passes (complexSteps:false, wordDiffs:true,
// simplifyDiff:true):
//   1. invariant: each implementation's transform reproduces the target doc
//      (apply(diff) == target);
//   2. cross-copy parity: both implementations emit the SAME step sequence, so a
//      behavioral divergence between the two copies fails this test.
//
// The vendored copy is TypeScript, so it is transpiled to CommonJS at test time
// and required directly — the test runs the ACTUAL vendored source, not a stand-in.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { recreateTransform as fellowRecreate } from "@fellow/prosemirror-recreate-transform";
import { Node } from "@tiptap/pm/model";
import { docmostSchema } from "../../build/lib/docmost-schema.js";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// .../packages/mcp/test/unit -> repo packages root.
const PACKAGES = path.resolve(HERE, "..", "..", "..");
const VENDOR_SRC = path.join(
  PACKAGES,
  "editor-ext",
  "src",
  "lib",
  "recreate-transform",
);
// Emit transpiled CJS under mcp/build so Node resolves the hoisted deps
// (@tiptap/pm, rfc6902, diff) up the directory tree exactly as diff.js does.
const VENDOR_OUT = path.resolve(HERE, "..", "..", "build", "_vendored_editor_ext");

// The exact options the mcp diff pipeline uses (diff.ts).
const DIFF_OPTS = { complexSteps: false, wordDiffs: true, simplifyDiff: true };

let vendoredRecreate;

before(() => {
  assert.ok(
    fs.existsSync(VENDOR_SRC),
    `vendored recreate-transform sources missing at ${VENDOR_SRC}`,
  );
  fs.rmSync(VENDOR_OUT, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_OUT, { recursive: true });
  // Mark the output as CommonJS so relative `require("./x")` resolves to x.js.
  fs.writeFileSync(
    path.join(VENDOR_OUT, "package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  for (const f of fs.readdirSync(VENDOR_SRC)) {
    if (!f.endsWith(".ts")) continue;
    const code = fs.readFileSync(path.join(VENDOR_SRC, f), "utf8");
    const out = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    });
    fs.writeFileSync(path.join(VENDOR_OUT, f.replace(/\.ts$/, ".js")), out.outputText);
  }
  vendoredRecreate = require(path.join(VENDOR_OUT, "index.js")).recreateTransform;
  assert.equal(typeof vendoredRecreate, "function", "vendored recreateTransform loaded");
});

// ---------------------------------------------------------------------------
// Builders + representative doc pairs covering the diff shapes diff.ts handles.
// ---------------------------------------------------------------------------
const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const para = (...c) => ({ type: "paragraph", content: c });
const doc = (...c) => ({ type: "doc", content: c });

const PAIRS = [
  // word inserted mid-sentence
  ["insert word", doc(para(t("Hello world"))), doc(para(t("Hello brave world")))],
  // whole block deleted
  ["delete block", doc(para(t("keep this")), para(t("remove this"))), doc(para(t("keep this")))],
  // word removed mid-sentence
  ["delete word", doc(para(t("one two three"))), doc(para(t("one three")))],
  // pure mark addition (complexSteps:false treats it as a content step)
  ["add mark", doc(para(t("plain"))), doc(para(t("plain", [{ type: "bold" }])))],
  // two blocks swapped (reorder)
  ["reorder blocks", doc(para(t("a")), para(t("b"))), doc(para(t("b")), para(t("a")))],
  // structural insert: an image node appears
  [
    "insert image",
    doc(para(t("caption"))),
    doc(para(t("caption")), { type: "image", attrs: { src: "/api/files/a.png", attachmentId: "i1" } }),
  ],
];

const stepsJSON = (tr) => JSON.stringify(tr.steps.map((s) => s.toJSON()));

for (const [label, fromJSON, toJSON] of PAIRS) {
  test(`invariant: @fellow recreateTransform reproduces the target (${label})`, () => {
    const from = Node.fromJSON(docmostSchema, fromJSON);
    const to = Node.fromJSON(docmostSchema, toJSON);
    const tr = fellowRecreate(from, to, DIFF_OPTS);
    // apply(diff) == target, comparing schema-normalized JSON on both sides.
    assert.equal(JSON.stringify(tr.doc.toJSON()), JSON.stringify(to.toJSON()));
  });

  test(`drift: @fellow and vendored editor-ext emit identical steps (${label})`, () => {
    const mk = () => [
      Node.fromJSON(docmostSchema, fromJSON),
      Node.fromJSON(docmostSchema, toJSON),
    ];
    const [fA, tA] = mk();
    const [fB, tB] = mk();
    const trFellow = fellowRecreate(fA, tA, DIFF_OPTS);
    const trVendor = vendoredRecreate(fB, tB, DIFF_OPTS);

    // Both must reach the same target...
    const target = JSON.stringify(tA.toJSON());
    assert.equal(JSON.stringify(trFellow.doc.toJSON()), target, "fellow reaches target");
    assert.equal(JSON.stringify(trVendor.doc.toJSON()), target, "vendored reaches target");
    // ...and, critically, via the SAME step sequence. A divergence in the two
    // recreate-transform copies' algorithm would change the steps and fail here.
    assert.equal(
      stepsJSON(trVendor),
      stepsJSON(trFellow),
      `vendored editor-ext drifted from @fellow on "${label}"`,
    );
  });
}
