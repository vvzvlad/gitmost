import { getSchema } from '@tiptap/core';
import { docmostExtensions } from '@docmost/prosemirror-markdown';
import { tiptapExtensions } from './collaboration.util';

// ─────────────────────────────────────────────────────────────────────────────
// CI PARITY GUARD — node/mark ATTRIBUTE drift between the two Tiptap schemas
// (issue #684; AGENTS.md invariant #7 "NO HAND-SYNCED MIRRORS").
//
// The Docmost document schema exists in TWO hand-synced copies:
//
//   SOURCE (authoritative write path): `tiptapExtensions` in
//     `apps/server/src/collaboration/collaboration.util.ts`. The collaboration
//     server persists every guarded-replace edit via
//     `Node.fromJSON(getSchema(tiptapExtensions))` — and ProseMirror SILENTLY
//     STRIPS any attribute the schema does not declare.
//   MIRROR (PM<->Markdown converter): `docmostExtensions` in
//     `@docmost/prosemirror-markdown` (`src/lib/docmost-schema.ts`), used by
//     git-sync / MCP / server markdown import-export.
//
// WHY THIS TEST EXISTS. `align` on `tableCell`/`tableHeader` once drifted: it
// was declared in the MIRROR (converter `cellAttributes()`) but NOT in the
// SOURCE editor-ext `TableCell`/`TableHeader`. While writes went through the
// old client collab path (mirror schema) GFM alignment `|:--|:-:|--:|`
// survived; after #647/#672 moved the write path to server guarded-replace
// (`getSchema(tiptapExtensions)`), the undeclared `align` was stripped on
// persist and table alignment was silently lost. No unit/integration test
// caught it — only a downstream e2e did.
//
// The sibling `packages/prosemirror-markdown/test/schema-editor-ext-contract.test.ts`
// (#493) compares editor-ext's OWN `addAttributes()` against the mirror, but it
// is intentionally ASYMMETRIC (source -> mirror) and reads per-node declared
// attrs — so it can neither see the MIRROR-has-it / SOURCE-lacks-it direction
// (the exact `align` failure mode: a mirror attr the write path strips) nor the
// globally-injected attrs (id / textAlign / indent) or the stock-Tiptap nodes
// (image / youtube). And `schema-surface-snapshot.test.ts` is a LOUD MANUAL
// review gate (an inline pinned surface), not an automatic cross-schema diff.
//
// THIS test closes the gap invariant #7 demands: it diffs the attribute-NAME
// SET of every node/mark type common to BOTH BUILT schemas
// (`getSchema(...).nodes[t].spec.attrs`), in BOTH directions, and FAILS on any
// mismatch that is not an explicitly documented, stale-guarded divergence. So a
// future align-class drift reddens CI here instead of shipping as silent data
// loss.
// ─────────────────────────────────────────────────────────────────────────────

type Kind = 'node' | 'mark';

/** attr-name set per `${kind}:${name}` for a built Tiptap schema. */
function attrSurface(exts: unknown): Map<string, Set<string>> {
  const schema = getSchema(exts as never);
  const out = new Map<string, Set<string>>();
  const collect = (kind: Kind, types: Record<string, unknown>) => {
    for (const [name, type] of Object.entries(types)) {
      const attrs = (type as { spec?: { attrs?: object } }).spec?.attrs ?? {};
      out.set(`${kind}:${name}`, new Set(Object.keys(attrs)));
    }
  };
  collect('node', schema.nodes);
  collect('mark', schema.marks);
  return out;
}

// ── DOCUMENTED DIVERGENCE ALLOWLIST ─────────────────────────────────────────
//
// The two schemas are NOT byte-identical by design: the mirror is a converter
// that must also round-trip a few stock-Tiptap / legacy shapes the authoritative
// editor schema models differently. Every intentional attribute divergence is
// enumerated here with (1) the side that HAS the attr and (2) a reason. Any
// divergence NOT listed here fails the parity test; any listed row that is no
// longer a real divergence fails the stale-allowlist test below — so this list
// cannot silently rot and a NEW drift (the `align` class) is never pre-blessed.
//
// `side`:
//   'source' — attr exists in editor-ext/collab (`tiptapExtensions`) but NOT in
//              the converter mirror. Risk: the git-sync markdown round-trip
//              drops it (the direction the #493 contract already guards).
//   'mirror' — attr exists in the converter mirror but NOT in the write-path
//              schema. Risk: guarded-replace persist STRIPS it (the `align`
//              class). A NEW such row must be reviewed as a potential data loss.
interface Divergence {
  side: 'source' | 'mirror';
  reason: string;
}
const ACCEPTED_DIVERGENCE: Record<string, Divergence> = {
  // Presentational secondary palette name; only `highlight.color` (==text==)
  // has a markdown form, so the mirror deliberately omits it. Matches the
  // blessed omission in schema-editor-ext-contract.test.ts.
  'mark:highlight.colorName': { side: 'source', reason: 'no markdown form; presentational palette name' },
  // The mirror builds `image` from stock @tiptap/extension-image (which carries
  // `title`); Docmost's authoritative image node models `caption` instead and
  // has no `title` attribute. The converter keeps `title` only to survive an
  // imported `![alt](src "title")` shape; the editor never stores it.
  'node:image.title': { side: 'mirror', reason: 'Docmost image models caption, not stock-Tiptap title' },
  // The mirror `youtube` is a DEFENSIVE PASSTHROUGH (Docmost has no dedicated
  // youtube node — YouTube is handled via `embed`); it models the generic media
  // atom attrs incl. `align`. The write-path `youtube` is stock
  // @tiptap/extension-youtube, which has `start` (start-time) but no `align`.
  'node:youtube.align': { side: 'mirror', reason: 'converter passthrough atom; Docmost routes YouTube via embed' },
  'node:youtube.start': { side: 'source', reason: 'stock Tiptap youtube start-time; no markdown/embed form' },
};

function accepted(key: string, side: 'source' | 'mirror'): boolean {
  return ACCEPTED_DIVERGENCE[key]?.side === side;
}

describe('schema attribute parity: editor-ext/collab source vs prosemirror-markdown mirror (#684, invariant #7)', () => {
  const source = attrSurface(tiptapExtensions);
  const mirror = attrSurface(docmostExtensions);
  const sharedTypes = [...source.keys()].filter((t) => mirror.has(t)).sort();

  it('builds a meaningful shared surface (guards against a vacuous no-op if an import goes dark)', () => {
    // Both schemas must actually build and overlap; otherwise the diff below
    // would vacuously pass. tableCell/tableHeader must be present — they are the
    // node whose `align` drift motivated this guard.
    expect(sharedTypes.length).toBeGreaterThan(20);
    expect(sharedTypes).toContain('node:tableCell');
    expect(sharedTypes).toContain('node:tableHeader');

    // PIN the advertised global-attr coverage (header, "globally-injected attrs
    // id / textAlign / indent"). Those attrs are folded into `spec.attrs` by an
    // `addGlobalAttributes()` extension (editor-ext `Indent` + Tiptap TextAlign /
    // the block-id ext on the SOURCE, `DocmostAttributes` on the MIRROR) rather
    // than declared node-locally, so they exercise a different build path than
    // the node-local `align` pin below. Without this assertion, if a Tiptap
    // upgrade or refactor stopped folding globals into `spec.attrs` on BOTH sides
    // in lockstep, each node's global set would collapse to [] synchronously —
    // the diff would stay green (57 > 20, align still node-local) while the
    // advertised global-drift coverage silently evaporated. This reddens the
    // instant global materialization regresses on either schema.
    for (const surface of [source, mirror]) {
      for (const type of ['node:paragraph', 'node:heading']) {
        const attrs = surface.get(type)!;
        for (const global of ['id', 'indent', 'textAlign']) {
          expect(attrs.has(global)).toBe(true);
        }
      }
    }
  });

  it('every shared node/mark has identical attribute sets in both schemas (allowlisted divergences aside)', () => {
    const drift: string[] = [];
    for (const type of sharedTypes) {
      const s = source.get(type)!;
      const m = mirror.get(type)!;
      // In SOURCE but not MIRROR (git-sync round-trip would drop it).
      for (const attr of s) {
        const key = `${type}.${attr}`;
        if (!m.has(attr) && !accepted(key, 'source')) {
          drift.push(`${key}: declared in editor-ext/collab (write path) but MISSING in docmost-schema mirror`);
        }
      }
      // In MIRROR but not SOURCE (guarded-replace persist STRIPS it — the
      // `align` class). This is the direction the older contract test cannot see.
      for (const attr of m) {
        const key = `${type}.${attr}`;
        if (!s.has(attr) && !accepted(key, 'mirror')) {
          drift.push(`${key}: declared in docmost-schema mirror but MISSING in editor-ext/collab (write path STRIPS it — align-class silent data loss)`);
        }
      }
    }
    // Any entry here is an UNRECONCILED attribute drift between the two schemas.
    // Reconcile the schemas (add the attr to whichever side is authoritative —
    // for a mirror-only attr the write path is authoritative, so add it to
    // editor-ext, as `align` was) OR add a reasoned ACCEPTED_DIVERGENCE row.
    expect(drift.sort()).toEqual([]);
  });

  it('the divergence allowlist has no stale rows (every entry is still a real divergence on the stated side)', () => {
    const stale: string[] = [];
    for (const [key, { side }] of Object.entries(ACCEPTED_DIVERGENCE)) {
      const lastDot = key.lastIndexOf('.');
      const type = key.slice(0, lastDot);
      const attr = key.slice(lastDot + 1);
      const s = source.get(type);
      const m = mirror.get(type);
      // Stale if the type is gone from either built schema, or the attr no
      // longer diverges on the declared side (present on both, or absent on the
      // side that was supposed to HAVE it).
      if (!s || !m) {
        stale.push(`${key}: type no longer present in both schemas`);
        continue;
      }
      if (side === 'source' && !(s.has(attr) && !m.has(attr))) {
        stale.push(`${key}: no longer a source-only divergence`);
      }
      if (side === 'mirror' && !(m.has(attr) && !s.has(attr))) {
        stale.push(`${key}: no longer a mirror-only divergence`);
      }
    }
    expect(stale.sort()).toEqual([]);
  });

  it('catches the align drift specifically: tableCell/tableHeader carry `align` in BOTH schemas', () => {
    // Regression pin for the #684 incident. If `align` is removed from the
    // editor-ext TableCell/TableHeader (the write path) again, the main parity
    // test above reddens (align is mirror-only and NOT allowlisted); this
    // assertion states the fixed invariant directly for readability.
    for (const type of ['node:tableCell', 'node:tableHeader']) {
      expect(source.get(type)!.has('align')).toBe(true);
      expect(mirror.get(type)!.has('align')).toBe(true);
    }
  });
});
