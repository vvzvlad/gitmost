import { getSchema } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { tiptapExtensions } from './collaboration.util';
// The canonical converter mirror's extension set. The schema mirror now lives in
// the single `@docmost/prosemirror-markdown` package (#293); the server jest
// config maps it to the package SOURCE (moduleNameMapper
// `^@docmost/prosemirror-markdown$`), so this reads the real mirror, not a build.
import { docmostExtensions as gitSyncExtensions } from '@docmost/prosemirror-markdown';

/**
 * ATTRIBUTE-LEVEL SCHEMA CONTRACT (review #293, variant A).
 *
 * The document schema exists as three hand-synced copies (editor-ext =
 * source-of-truth, plus the git-sync and mcp converter mirrors). The existing
 * `schema-editor-ext-contract.test.ts` compares only node/mark TYPE NAMES, so a
 * NEW ATTRIBUTE added to an existing node upstream slips through and its value is
 * silently dropped on every git-sync round trip. That is a repeatedly-hit
 * data-loss class (image caption #221, paragraph alignment #10, details `open`).
 *
 * This test closes the attribute gap MECHANICALLY: it builds the real canonical
 * schema from the server's `tiptapExtensions` (the same set the collab write path
 * uses) and the git-sync mirror schema, then asserts that for every node/mark the
 * two schemas share, their ATTRIBUTE-KEY sets are equal — minus a committed
 * allowlist of intentional, understood divergences. A forgotten attribute now
 * fails CI loudly instead of losing data in production.
 *
 * WHY THIS ISN'T THE "fragile attribute compare" the sibling name-level contract
 * (`packages/git-sync/test/schema-editor-ext-contract.test.ts`) deferred: that
 * concern was about comparing raw extension CONFIGS, where editor-ext spreads
 * global attributes (textAlign, id, …) across separate extensions and StarterKit
 * contributes types the mirror gets elsewhere. We instead compare the RESOLVED
 * ProseMirror `Schema` objects — `getSchema()` has already merged every
 * addGlobalAttributes spread into concrete per-node attrs on both sides — so the
 * compare is apples-to-apples (57 shared nodes/marks, only a handful of
 * documented divergences) rather than config-shape noise.
 */

/**
 * Intentional, understood attribute divergences between the canonical schema and
 * the git-sync mirror. Each entry MUST carry a reason. The test asserts the
 * allowlist is not stale (every listed attr is actually still divergent), so this
 * cannot rot into a silent escape hatch.
 *
 * Shape: { [nodeOrMarkName]: { canonicalOnly?: string[]; mirrorOnly?: string[] } }
 */
const ALLOWED_DIVERGENCES: Record<
  string,
  { canonicalOnly?: string[]; mirrorOnly?: string[] }
> = {
  // mirrorOnly: the converter mirror carries `align` on table cells/headers so a
  // GFM column-alignment marker (:--, :-:, --:) can be reconstructed on export;
  // editor-ext expresses cell alignment differently. Intentional, round-trip-used.
  tableCell: { mirrorOnly: ['align'] },
  tableHeader: { mirrorOnly: ['align'] },
  // youtube: the mirror adds `align` (media alignment it renders as data-align)
  // and does NOT carry editor-ext's `start` (video start-time). `start` is a
  // PRE-EXISTING gap (a youtube embed's start offset is not preserved across a
  // markdown round trip) — documented here so the contract is green for the known
  // state and RED for any NEW drift. Follow-up: carry `start` through the mirror.
  youtube: { mirrorOnly: ['align'], canonicalOnly: ['start'] },
  // image.title: the mirror carries a `title` attr (used to round-trip the
  // markdown image title `![alt](src "title")`) that editor-ext does not declare
  // on its image node. Mirror-only and round-trip-used, not data loss. Intentional.
  image: { mirrorOnly: ['title'] },
  // highlight.colorName (a named-color alias alongside the color value) is a
  // PRE-EXISTING mirror gap; the color value itself round-trips. Documented.
  highlight: { canonicalOnly: ['colorName'] },
};

function attrKeys(schema: Schema): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [name, type] of Object.entries(schema.nodes)) {
    out.set(name, new Set(Object.keys((type.spec as any).attrs ?? {})));
  }
  for (const [name, type] of Object.entries(schema.marks)) {
    out.set(name, new Set(Object.keys((type.spec as any).attrs ?? {})));
  }
  return out;
}

function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}

describe('schema attribute contract: git-sync mirror vs canonical editor-ext', () => {
  const canonical = attrKeys(getSchema(tiptapExtensions as never));
  const mirror = attrKeys(getSchema(gitSyncExtensions as never));

  it('builds meaningful schemas (guard against a vacuous pass)', () => {
    expect(canonical.size).toBeGreaterThan(10);
    expect(mirror.size).toBeGreaterThan(10);
  });

  it('every shared node/mark has matching attribute keys (modulo the allowlist)', () => {
    const drift: string[] = [];
    for (const [name, canonAttrs] of canonical) {
      const mirrorAttrs = mirror.get(name);
      if (!mirrorAttrs) continue; // name-level gaps are the other test's job
      const allow = ALLOWED_DIVERGENCES[name] ?? {};
      const canonicalOnly = diff(canonAttrs, mirrorAttrs).filter(
        (k) => !(allow.canonicalOnly ?? []).includes(k),
      );
      const mirrorOnly = diff(mirrorAttrs, canonAttrs).filter(
        (k) => !(allow.mirrorOnly ?? []).includes(k),
      );
      if (canonicalOnly.length) {
        drift.push(
          `${name}: attrs in editor-ext but MISSING from git-sync mirror ` +
            `(silently dropped on round trip): ${canonicalOnly.join(', ')}`,
        );
      }
      if (mirrorOnly.length) {
        drift.push(
          `${name}: attrs in git-sync mirror but NOT in editor-ext ` +
            `(mirror invented an attribute): ${mirrorOnly.join(', ')}`,
        );
      }
    }
    expect(drift).toEqual([]);
  });

  it('the allowlist is not stale (every listed divergence is still real)', () => {
    const stale: string[] = [];
    for (const [name, allow] of Object.entries(ALLOWED_DIVERGENCES)) {
      const canonAttrs = canonical.get(name);
      const mirrorAttrs = mirror.get(name);
      if (!canonAttrs || !mirrorAttrs) {
        stale.push(`${name}: no longer a shared node/mark`);
        continue;
      }
      for (const k of allow.canonicalOnly ?? []) {
        if (!(canonAttrs.has(k) && !mirrorAttrs.has(k))) {
          stale.push(`${name}.canonicalOnly '${k}' is no longer divergent`);
        }
      }
      for (const k of allow.mirrorOnly ?? []) {
        if (!(mirrorAttrs.has(k) && !canonAttrs.has(k))) {
          stale.push(`${name}.mirrorOnly '${k}' is no longer divergent`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});
