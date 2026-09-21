import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

import { docmostExtensions } from "../src/lib/docmost-schema.js";
// TWO resolutions of the SAME canonical mark, deliberately:
//
//  * `@docmost/editor-ext` — the PACKAGE entry. Under Node (this test runner, the
//    server, the MCP build) that resolves to the package's `main`, i.e. the BUILT
//    `dist/index.js`.
//  * `../../editor-ext/src/lib/code.js` — the SOURCE file. The client bundler
//    resolves the package through its `module: "./src/index.ts"` field, so THIS
//    is the mark the editor actually loads.
//
// Asserting only the built artifact would leave a hole (#515 review F3): a local
// edit to `src/lib/code.ts` with a stale `dist/` would keep this test green while
// the CLIENT already ran the drifted policy — and vice versa. Pinning BOTH, plus
// their equality, makes drift in EITHER artifact red. The direct file import also
// sidesteps the src BARREL (`src/index.ts`), which would drag React node views
// into this framework-free package's test.
import { Code as CanonicalCodeBuilt } from "@docmost/editor-ext";
import { Code as CanonicalCodeSource } from "../../editor-ext/src/lib/code.js";

// #515 CROSS-COPY PARITY GUARD for the `code` mark's `excludes` policy.
//
// The `excludes` value of the inline `code` mark is DATA-LOSS-CRITICAL: with the
// upstream Tiptap default (`excludes: "_"`) ProseMirror strips EVERY co-occurring
// inline mark on the HTML -> PM parse (`generateJSON` / `htmlToJson`), so
// CommonMark's ``**`code`**`` (which parses to <strong><code>code</code></strong>)
// silently lost its bold on markdown import, and the git-sync export re-emitted
// dangling `**` delimiters.
//
// The policy is now `excludes: "code"` — code excludes ONLY ITSELF, which is
// ProseMirror's default for a mark, so it combines with all OTHER inline marks.
//
// It is deliberately NOT `""` ("exclude nothing, not even myself"), which is what
// #515 first shipped: y-prosemirror keys the Yjs text attribute by the plain mark
// name only for marks that exclude themselves, and switches to a HASHED key
// (`code--<base64 sha256 of the mark JSON>`) for any mark that does not — its
// signal for "may appear MULTIPLE times on one run with different attrs". `code`
// has no attrs, so `""` bought nothing and gave inline code a SECOND persistence
// canon: every other Docmost mark (and every pre-#515 document) stores a plain
// key. The `yjsAttributeKey` assertion below pins that, so the `""` regression
// cannot come back through a "harmless" schema tweak.
//
// SINGLE SOURCE is the shared `Code` mark in `@docmost/editor-ext`, used by the
// three app schemas (client `mainExtensions`, server `tiptapExtensions`, comment
// editor). This package's `docmostExtensions` is a DELIBERATE vendored mirror
// that must NOT import editor-ext at runtime (it would drag React node views into
// the markdown converter — see docmost-schema.ts's header and #293), so it sets
// the same `excludes: "code"` LOCALLY.
//
// That local copy is exactly the kind of hand-synced mirror AGENTS.md §7 warns
// about, so this test mechanically ties the two together: the node-env test
// runner CAN import both, and the assertion below fails loudly the moment the
// mirror drifts from the canonical mark (e.g. someone drops the local
// `Code.extend({ excludes: "code" })` and the StarterKit default `"_"` returns).
describe("#515 code-mark excludes parity (vendored mirror vs @docmost/editor-ext)", () => {
  const mirrorExcludes = getSchema(docmostExtensions).marks.code.spec.excludes;
  // Build each canonical mark into a schema exactly the way the app schemas do
  // (StarterKit with its own `code` disabled + the shared Docmost `Code`), so the
  // value read here is the one ProseMirror actually enforces.
  const excludesOf = (code: any) =>
    getSchema([StarterKit.configure({ code: false }), code]).marks.code.spec
      .excludes;
  const canonicalExcludes = excludesOf(CanonicalCodeBuilt);
  const sourceExcludes = excludesOf(CanonicalCodeSource);

  it("the canonical editor-ext Code mark declares excludes: 'code' (BUILT dist — what Node/server load)", () => {
    // Reads the CANONICAL source (the shared mark itself), not a restatement of
    // it: if editor-ext ever reverts to the Tiptap default this reds.
    expect(canonicalExcludes).toBe("code");
  });

  it("the editor-ext Code SOURCE declares excludes: 'code' (src/lib/code.ts — what the client bundles)", () => {
    expect(sourceExcludes).toBe("code");
  });

  it("the built dist AGREES with the source (no stale-build drift)", () => {
    // A `dist/` built from an older `src/lib/code.ts` (or a `src` edit not yet
    // rebuilt) would give the server and the client DIFFERENT excludes policies —
    // one of them silently stripping marks off inline code.
    expect(canonicalExcludes).toBe(sourceExcludes);
  });

  it("the vendored mirror's code mark declares excludes: 'code'", () => {
    expect(mirrorExcludes).toBe("code");
  });

  it("the mirror's excludes EQUALS the canonical editor-ext value", () => {
    expect(mirrorExcludes).toBe(canonicalExcludes);
  });

  it("no other mark in the mirror excludes the code mark (directionality)", () => {
    // Dropping `code`'s own excludes is only sufficient while nothing excludes it
    // from the other side (ProseMirror's exclusion is symmetric per pair: a mark
    // whose `excludes` matches `code` would still evict it).
    const schema = getSchema(docmostExtensions);
    const offenders = Object.values(schema.marks)
      .filter((markType: any) => markType.name !== "code")
      .filter((markType: any) => markType.excludes(schema.marks.code))
      .map((markType: any) => markType.name);
    expect(offenders).toEqual([]);
  });

  it("the code mark excludes NO other mark (#515: code carries bold/italic/…)", () => {
    // The actual #515 property, stated as behavior rather than as a literal: the
    // whole point of overriding Tiptap's `"_"` is that code evicts nothing.
    const schema = getSchema(docmostExtensions);
    const evicted = Object.values(schema.marks)
      .filter((markType: any) => markType.name !== "code")
      .filter((markType: any) => schema.marks.code.excludes(markType))
      .map((markType: any) => markType.name);
    expect(evicted).toEqual([]);
  });

  it("the code mark excludes ITSELF, so Yjs keys it plainly (`code`, not `code--<hash>`)", () => {
    // y-prosemirror's `marksToAttributes` decides the Yjs text-attribute key with
    // exactly this predicate:
    //
    //   const isOverlapping = !mark.type.excludes(mark.type);
    //   pattrs[isOverlapping ? `${name}--${hashOfJSON(mark.toJSON())}` : name] = …
    //
    // A mark that does not exclude itself is "overlapping" (it may appear several
    // times on one run with different attrs, like `comment`) and gets a HASHED
    // key. With `excludes: ""` inline code fell into that branch and every write
    // persisted `code--LpaW+ak5` — a second canon for the same mark, diverging
    // from both the full-page importer and every pre-#515 document (the MCP's
    // `markdown-patch-insert` canon-convergence test caught it end to end).
    //
    // Self-exclusion is a semantic no-op for an attr-less mark (ProseMirror's
    // `Mark.addToSet` already de-dups identical marks), so this costs nothing and
    // keeps code on the same Yjs representation as every other Docmost mark.
    const schema = getSchema(docmostExtensions);
    const code = schema.marks.code;
    expect(code.excludes(code)).toBe(true);

    // And it must be the ONLY policy in play: no Docmost mark may be "overlapping"
    // by accident. (`comment` overlaps semantically but is attr-keyed by Docmost's
    // own yjs.util helpers, which read the RAW attribute name — a hashed key would
    // silently break them too.)
    const overlapping = Object.values(schema.marks)
      .filter((markType: any) => !markType.excludes(markType))
      .map((markType: any) => markType.name);
    expect(overlapping).toEqual([]);
  });
});
