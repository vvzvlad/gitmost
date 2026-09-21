import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";

import { docmostExtensions } from "../src/lib/docmost-schema.js";
import * as editorExt from "@docmost/editor-ext";

// CROSS-PACKAGE SCHEMA CONTRACT (data-loss-sensitive).
//
// `src/lib/docmost-schema.ts` is a hand-synced VENDORED MIRROR of the canonical
// Docmost schema in `@docmost/editor-ext`. The sibling `schema-surface-snapshot`
// test pins the mirror's FULL surface (names + attrs) against an inline
// reference, but that reference is hand-curated and does not mechanically tie to
// editor-ext. This test closes that gap from the other side: it reads the ACTUAL
// Tiptap node/mark definitions exported by `@docmost/editor-ext` and asserts the
// vendored mirror is a SUPERSET of their type NAMES — so a Docmost-specific node
// or mark added upstream that the mirror forgets to vendor fails CI loudly
// (otherwise it is silently dropped on the markdown <-> ProseMirror round-trip).
//
// This file now holds TWO contracts (see the two describe blocks): the original
// NAME-LEVEL type contract (no canonical node/mark TYPE goes unmirrored) AND, as
// of #493, an ATTRIBUTE-LEVEL contract that compares each editor-ext node/mark's
// OWN declared attributes (names + defaults) against the mirror's built schema.
// A full mechanical attribute-by-attribute EQUALITY would be fragile (the mirror
// is a deliberate superset: it injects the global id/textAlign/indent attrs and
// normalizes some editor-ext defaults to null), so the attribute contract is
// asymmetric — editor-ext -> mirror — with a small, reasoned, stale-guarded
// allowlist for the two blessed divergence kinds (non-round-trippable omissions
// and null-normalized defaults). StarterKit-provided types (paragraph, bold,
// heading, …) are contributed by @tiptap/starter-kit in the mirror rather than
// by editor-ext, so they are naturally covered by the mirror's superset.
//
// NOT COVERED here (deferred): (1) the THIRD copy in `packages/mcp` — a separate
// package guarded by its own surface snapshot; (2) attribute *behaviour* drift,
// e.g. the details `open` attr read via getAttribute vs hasAttribute (PR #119
// review #2) — a name-level compare cannot see parseHTML/renderHTML differences.
// Mechanically guarding behavioural parity across all THREE copies needs the
// single framework-free "schema core" refactor (deferred — see AGENTS.md); until
// then each copy's header carries the manual keep-in-sync requirement.

/** Tiptap Node/Mark instances expose a `.name` and a `.type` of 'node'|'mark'. */
function isTiptapNodeOrMark(
  value: unknown,
): value is { name: string; type: "node" | "mark" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name: unknown }).name === "string" &&
    "type" in value &&
    ((value as { type: unknown }).type === "node" ||
      (value as { type: unknown }).type === "mark")
  );
}

/** The set of node/mark type names the vendored mirror actually registers. */
function vendoredNames(): Set<string> {
  const schema = getSchema(docmostExtensions as never);
  return new Set([
    ...Object.keys(schema.nodes),
    ...Object.keys(schema.marks),
  ]);
}

/** The Docmost-specific node/mark type names exported by @docmost/editor-ext. */
function editorExtNames(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(editorExt)) {
    if (isTiptapNodeOrMark(value)) names.add(value.name);
  }
  return names;
}

describe("docmost schema vs @docmost/editor-ext (name-level contract)", () => {
  it("exposes Tiptap node/mark definitions from editor-ext (guards against the import going dark)", () => {
    // If editor-ext ever stops exporting concrete node/mark objects (e.g. a
    // barrel refactor), this contract would vacuously pass — assert it found a
    // meaningful set so the test cannot silently become a no-op.
    expect(editorExtNames().size).toBeGreaterThan(5);
  });

  it("vendors every Docmost-specific node/mark type defined in editor-ext (no silently-dropped types)", () => {
    const vendored = vendoredNames();
    const missing = [...editorExtNames()].filter((n) => !vendored.has(n)).sort();
    // missing must be empty: any name here exists in editor-ext but NOT in the
    // vendored mirror, so documents using it would lose that node/mark on a
    // git-sync round-trip. Re-sync src/lib/docmost-schema.ts before clearing.
    expect(missing).toEqual([]);
  });
});

// ── ATTRIBUTE-LEVEL CONTRACT (#493 commit 2) ────────────────────────────────
//
// The name-level contract above catches a WHOLE node/mark type going unmirrored,
// but not ATTRIBUTE drift within a vendored type — the exact class that silently
// dropped `subpages.recursive`: editor-ext grew an attribute the hand-synced
// mirror forgot, so documents using it lost that attribute on a git-sync
// round-trip while CI stayed green. This closes that gap by comparing each
// editor-ext node/mark's OWN declared attributes (names + defaults) against the
// mirror's built ProseMirror schema `spec.attrs`.
//
// DIRECTION: editor-ext -> mirror. The mirror is deliberately a SUPERSET (it
// injects the global `id`/`textAlign`/`indent` attributes and normalizes some
// editor-ext "required" attrs to a `null` default), so a reverse compare would
// be pure false drift; the meaningful failure is an editor-ext attribute the
// mirror DROPS (name) or whose DEFAULT it silently changes. Both directions of
// staleness are guarded so the allowlists cannot rot.

/**
 * The attributes an editor-ext Tiptap Node/Mark DECLARES itself, read from its
 * `config.addAttributes()`. Global attributes injected by separate extensions
 * (unique-id, indent, textAlign) are NOT included here — they are the mirror's
 * superset and are not part of a per-type declaration — so this isolates each
 * type's own contribution. A declared attribute with no explicit `default` is a
 * required attr (Tiptap default `undefined`); we surface that as-is so the
 * default compare can skip it (the mirror makes such attrs optional/`null`).
 */
function editorExtOwnAttrs(): Map<
  string,
  { kind: "node" | "mark"; attrs: Record<string, unknown> }
> {
  const out = new Map<
    string,
    { kind: "node" | "mark"; attrs: Record<string, unknown> }
  >();
  for (const value of Object.values(editorExt)) {
    if (!isTiptapNodeOrMark(value)) continue;
    const ext = value as unknown as {
      name: string;
      type: "node" | "mark";
      options?: unknown;
      storage?: unknown;
      config?: { addAttributes?: () => Record<string, { default?: unknown }> };
    };
    const fn = ext.config?.addAttributes;
    // addAttributes reads `this.options`/`this.name`; bind a minimal context
    // (verified sufficient for every editor-ext extension — none reach for
    // `this.editor` here). A type with no addAttributes contributes no attrs.
    const declared =
      typeof fn === "function"
        ? fn.call({
            options: ext.options ?? {},
            name: ext.name,
            parent: undefined,
            storage: ext.storage ?? {},
          } as never)
        : {};
    const attrs: Record<string, unknown> = {};
    for (const [attr, spec] of Object.entries(declared || {})) {
      // `undefined` marks a required (no-default) attr; keep it so the default
      // compare can distinguish "no default declared" from "default is null".
      attrs[attr] = (spec as { default?: unknown })?.default;
    }
    out.set(ext.name, { kind: ext.type, attrs });
  }
  return out;
}

/** The mirror's built-schema `spec.attrs` for a type: attr name -> default. */
function mirrorAttrs(
  name: string,
  kind: "node" | "mark",
): Record<string, unknown> | null {
  const schema = getSchema(docmostExtensions as never);
  const spec = kind === "node" ? schema.nodes[name]?.spec : schema.marks[name]?.spec;
  if (!spec) return null;
  const out: Record<string, unknown> = {};
  for (const [attr, def] of Object.entries(spec.attrs || {})) {
    out[attr] = (def as { default?: unknown }).default;
  }
  return out;
}

// An editor-ext attribute the mirror deliberately does NOT vendor because it has
// NO markdown round-trip representation — dropping it loses nothing on the
// git-sync cycle (the same rationale the flat-roundtrip property suite uses to
// allowlist e.g. `tableCell.backgroundColorName`). Blessed by the hand-curated
// surface snapshot (schema-surface-snapshot.test.ts), reviewed in every diff.
const ACCEPTED_ATTR_OMISSIONS = new Set<string>([
  "highlight.colorName", // only `highlight.color` round-trips (==text==); the
  // secondary palette-name is presentational and has no markdown form.
]);

// An editor-ext attribute the mirror vendors but with a DIFFERENT default: the
// mirror normalizes an "absent" value to `null` (its uniform optional-attr
// convention) rather than editor-ext's UI-oriented default. None of these attrs
// is emitted on the markdown surface (the converter round-trips only the
// serializable ones), so the default never round-trips and the divergence is
// inert — but pinned here so a NEW default change on either side forces review.
const ACCEPTED_DEFAULT_DIVERGENCE = new Set<string>([
  "image.src", // mirror null vs editor "" (an image is never emitted src-less)
  "link.internal", // mirror null vs editor false (routing attr, not in md link)
  "pdf.width", // mirror null vs editor 800 (presentational sizing, not in md)
  "pdf.height", // mirror null vs editor 600 (presentational sizing, not in md)
]);

describe("docmost schema vs @docmost/editor-ext (attribute-level contract)", () => {
  it("vendors every editor-ext attribute (name) of every shared type — no silently-dropped attrs", () => {
    const dropped: string[] = [];
    for (const [name, { kind, attrs }] of editorExtOwnAttrs()) {
      const mirror = mirrorAttrs(name, kind);
      if (!mirror) continue; // whole-type omission is the name-level test's job
      for (const attr of Object.keys(attrs)) {
        const key = `${name}.${attr}`;
        if (!(attr in mirror) && !ACCEPTED_ATTR_OMISSIONS.has(key)) {
          dropped.push(key);
        }
      }
    }
    // Any entry here exists on the editor-ext node/mark but NOT in the mirror
    // (and is not a blessed non-round-trippable omission): documents using it
    // lose that attribute on a git-sync round-trip — the subpages.recursive
    // class. Re-sync src/lib/docmost-schema.ts (and the surface snapshot) or add
    // a reasoned ACCEPTED_ATTR_OMISSIONS entry before clearing.
    expect(dropped.sort()).toEqual([]);
  });

  it("keeps every editor-ext attribute DEFAULT in sync — no silent default drift", () => {
    const drift: string[] = [];
    for (const [name, { kind, attrs }] of editorExtOwnAttrs()) {
      const mirror = mirrorAttrs(name, kind);
      if (!mirror) continue;
      for (const [attr, extDefault] of Object.entries(attrs)) {
        const key = `${name}.${attr}`;
        // Skip attrs editor-ext declares WITHOUT a default (required attrs):
        // the mirror deliberately makes them optional (`null`), a safe superset.
        if (extDefault === undefined) continue;
        if (!(attr in mirror)) continue; // a drop, reported by the name test
        if (
          JSON.stringify(mirror[attr]) !== JSON.stringify(extDefault) &&
          !ACCEPTED_DEFAULT_DIVERGENCE.has(key)
        ) {
          drift.push(
            `${key}: mirror=${JSON.stringify(mirror[attr])} editor-ext=${JSON.stringify(extDefault)}`,
          );
        }
      }
    }
    expect(drift.sort()).toEqual([]);
  });

  it("the attribute allowlists have no stale rows (each is really omitted / divergent)", () => {
    const ext = editorExtOwnAttrs();
    const staleOmission: string[] = [];
    for (const key of ACCEPTED_ATTR_OMISSIONS) {
      const [name, attr] = key.split(".");
      const entry = ext.get(name);
      const mirror = entry ? mirrorAttrs(name, entry.kind) : null;
      // Stale if editor-ext no longer declares it, or the mirror now DOES vendor
      // it (so it should be removed from the omission allowlist).
      if (!entry || !(attr in entry.attrs) || (mirror && attr in mirror)) {
        staleOmission.push(key);
      }
    }
    expect(staleOmission, "stale ACCEPTED_ATTR_OMISSIONS rows").toEqual([]);

    const staleDivergence: string[] = [];
    for (const key of ACCEPTED_DEFAULT_DIVERGENCE) {
      const [name, attr] = key.split(".");
      const entry = ext.get(name);
      const mirror = entry ? mirrorAttrs(name, entry.kind) : null;
      const extDefault = entry?.attrs[attr];
      // Stale if the divergence no longer exists (attr gone, or defaults now
      // agree) — the row should be dropped so the allowlist stays honest.
      if (
        !entry ||
        !mirror ||
        !(attr in entry.attrs) ||
        !(attr in mirror) ||
        extDefault === undefined ||
        JSON.stringify(mirror[attr]) === JSON.stringify(extDefault)
      ) {
        staleDivergence.push(key);
      }
    }
    expect(staleDivergence, "stale ACCEPTED_DEFAULT_DIVERGENCE rows").toEqual([]);
  });
});
