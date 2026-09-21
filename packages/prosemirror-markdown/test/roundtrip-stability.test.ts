import { describe, expect, it } from "vitest";
import {
  runStabilityMatrix,
  unstableCombos,
  formatReport,
  runConvergenceCase,
  convergenceCasesFor,
  convergenceOk,
  formatConvergence,
  type NodeStabilitySpec,
} from "./roundtrip-stability.helper.js";

// ---------------------------------------------------------------------------
// Round-trip STABILITY matrix for image + the media family.
//
// Guards the "empty-string-vs-absent" churn class (GS-EDIT-REVERT family): a
// stored node authored WITHOUT a string attr (alt/title/caption/aria-label/...)
// must not gain a phantom `attr: ""` after `markdownToProseMirror(convert…)`.
// Each spec sweeps the at-risk string attrs at DEFAULT (absent) and at a real
// NON-default value; the helper asserts both the RAW round-trip (attrs equal the
// input's, modulo the documented numeric width/height/size/aspectRatio -> string
// coercion) and the CANONICAL round-trip (canonical forms deep-equal).
//
// The image + media family share the `align !== "center"` predicate and the
// `<!--name {…}-->` comment machinery, so one matrix guards the shared class.
// align is NOT part of this class (it round-trips correctly) and is not swept.
// ---------------------------------------------------------------------------

const SPECS: NodeStabilitySpec[] = [
  {
    // Image carries the most at-risk string attrs. `alt` is the one marked
    // materializes as `<img alt="">` on `![](src)` import (the real bug); title
    // and caption are covered as the same class. attachmentId is a string attr
    // that must stay absent when unset (control).
    type: "image",
    baseAttrs: { src: "/i.png" },
    attrMatrix: [
      { attr: "alt", default: undefined, nonDefault: "a real alt text", emptyStringClass: true },
      { attr: "title", default: undefined, nonDefault: "a real title", emptyStringClass: true },
      { attr: "caption", default: undefined, nonDefault: "a real caption" },
      { attr: "attachmentId", default: undefined, nonDefault: "att-42" },
    ],
  },
  {
    // Video's `alt` rides the `aria-label` attribute (media aria-label at risk).
    type: "video",
    baseAttrs: { src: "/v.mp4" },
    attrMatrix: [
      { attr: "alt", default: undefined, nonDefault: "a clip", emptyStringClass: true },
      { attr: "attachmentId", default: undefined, nonDefault: "att-1" },
    ],
  },
  {
    // Audio carries no alt/title; attachmentId is its only optional string attr.
    type: "audio",
    baseAttrs: { src: "/a.mp3" },
    attrMatrix: [
      { attr: "attachmentId", default: undefined, nonDefault: "att-2" },
    ],
  },
  {
    // pdf: link-form media. `name` (filename) is its at-risk string attr.
    type: "pdf",
    baseAttrs: { src: "/d.pdf" },
    attrMatrix: [
      { attr: "name", default: undefined, nonDefault: "report.pdf", emptyStringClass: true },
      { attr: "attachmentId", default: undefined, nonDefault: "att-3" },
    ],
  },
  {
    // attachment: link-form media (file card). `name` + `mime` string attrs.
    type: "attachment",
    baseAttrs: { url: "/f.zip" },
    attrMatrix: [
      { attr: "name", default: undefined, nonDefault: "bundle.zip", emptyStringClass: true },
      { attr: "mime", default: undefined, nonDefault: "application/zip", emptyStringClass: true },
      { attr: "attachmentId", default: undefined, nonDefault: "att-4" },
    ],
  },
  {
    // embed: link-form media. `provider` is its at-risk string attr (schema
    // default ""). embed's numeric width/height defaults (800/600) are a SEPARATE,
    // documented limitation OUTSIDE the empty-string class: they are not in
    // canonicalize's KNOWN_DEFAULTS, so an ABSENT width/height re-imports as the
    // 800/600 default and diverges canonically (see the note in canonicalize.ts).
    // That is canonicalize-owned and out of scope here, so we author the
    // dimensions at their defaults (as real editor embeds carry them) to keep this
    // guard focused on the empty-string/provider class.
    // provider's schema default is "" (NOT null), so a re-imported "" is the
    // correct value, not a phantom — it is outside the null-default empty-string
    // class. We author it at its "" default (the default pick) so the sweep still
    // asserts a non-default provider ("youtube") round-trips, without tripping the
    // canonicalize KNOWN_DEFAULTS gap for embed's non-null defaults.
    type: "embed",
    baseAttrs: { src: "https://example.com/x", width: 800, height: 600 },
    attrMatrix: [
      { attr: "provider", default: "", nonDefault: "youtube" },
    ],
  },
  {
    // drawio: image-form diagram. `title` + `alt` string attrs (data-title/-alt).
    type: "drawio",
    baseAttrs: { src: "blob:drawio" },
    attrMatrix: [
      { attr: "title", default: undefined, nonDefault: "flow chart", emptyStringClass: true },
      { attr: "alt", default: undefined, nonDefault: "an alt", emptyStringClass: true },
      { attr: "attachmentId", default: undefined, nonDefault: "att-5" },
    ],
  },
  {
    // excalidraw: image-form diagram, same shared diagramAttributes set.
    type: "excalidraw",
    baseAttrs: { src: "blob:excalidraw" },
    attrMatrix: [
      { attr: "title", default: undefined, nonDefault: "sketch", emptyStringClass: true },
      { attr: "alt", default: undefined, nonDefault: "an alt", emptyStringClass: true },
      { attr: "attachmentId", default: undefined, nonDefault: "att-6" },
    ],
  },
];

describe("round-trip stability matrix (image + media family)", () => {
  for (const spec of SPECS) {
    it(`${spec.type}: no attr materializes an empty-string / phantom value`, async () => {
      const report = await runStabilityMatrix(spec);
      const unstable = unstableCombos(report);
      // On failure, print the WHOLE matrix so which (attr, value) combos are
      // unstable is legible.
      expect(unstable, `\n${formatReport(report)}\n`).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// THIRD STATE: an attr EXPLICITLY stored as a literal "" (GS-EDIT-REVERT: a user
// typed alt/title/name/... then deleted it, so Tiptap persisted `attr: ""` — a
// value DISTINCT from "attr was never set"). Unlike the absent case above, this
// state is NOT first-pass byte-stable: the fix's `"" -> default` coercion is a
// deliberate ONE-TIME normalization on the FIRST sync round-trip, stable
// thereafter. We therefore assert a DIFFERENT contract — "converges to default
// on pass 1, then idempotent from pass 2 on" — for every empty-string-class attr
// across the whole node family (image/video/pdf/attachment/drawio/excalidraw).
//
// IMPORTANT for a future sync/QA pass: the pass-1 `"" -> null` diff is the
// converter canon, not corruption. It appears at most once per affected node and
// must NOT be flagged as "the converter is losing/corrupting page data".
// ---------------------------------------------------------------------------
describe("round-trip third state: explicit empty string converges once, then idempotent", () => {
  for (const spec of SPECS) {
    for (const attr of convergenceCasesFor(spec)) {
      it(`${spec.type}.${attr}: "" normalizes to default on pass 1, byte-stable from pass 2`, async () => {
        const r = await runConvergenceCase(spec, attr);
        // Pass 1 must converge "" -> the schema default (the one-time diff) and
        // pass 2 (roundtrip of pass-1 output) must be byte-stable. formatConvergence
        // prints exactly which half failed.
        expect(convergenceOk(r), `\n${formatConvergence(r)}\n`).toBe(true);
        // Spell the contract out explicitly so the intent is legible in the test:
        expect(r.convergedToDefault, `\n${formatConvergence(r)}\n`).toBe(true);
        expect(r.firstPassValue).toEqual(r.expectedDefault);
        expect(r.secondPassDivergence, `\n${formatConvergence(r)}\n`).toBeNull();
      });
    }
  }
});
