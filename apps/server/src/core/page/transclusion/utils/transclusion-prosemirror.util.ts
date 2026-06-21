import { TransclusionNodeSnapshot } from '../transclusion.types';

const TRANSCLUSION_TYPE = 'transclusionSource';
const REFERENCE_TYPE = 'transclusionReference';
const PAGE_EMBED_TYPE = 'pageEmbed';

// Hard cap on recursion depth while walking a ProseMirror doc. Real documents
// nest only a handful of levels deep, so this ceiling is unreachable on any
// genuine input. It exists purely to defend against a pathological or cyclic
// non-JSON input (JSON.parse can't produce cycles, but other callers might
// hand us a hand-built/cyclic object) so the recursion can't overflow the stack.
const MAX_PM_WALK_DEPTH = 1000;

export type TransclusionReferenceSnapshot = {
  sourcePageId: string;
  transclusionId: string;
};

export type PageEmbedSnapshot = {
  sourcePageId: string;
};

/**
 * Generic, internal "collect every node of one PM type from a doc" walker that
 * the three public `collect*FromPmJson` collectors are built on. They all share
 * the exact same recursion (block-container descent + the #55 depth cap), and
 * differed only in (target type, how a matched node maps to an output snapshot,
 * how matches are deduped, and whether the walk descends into a
 * `transclusionSource`). Centralising the recursion here keeps that shared logic
 * — especially the depth guard — in one place so the collectors can't drift.
 *
 * Behaviour knobs (each collector wires these to reproduce its EXACT prior output):
 *  - `type`: only nodes whose `node.type` equals this are passed to `map`.
 *  - `map`: turns a matched node into a snapshot, or returns `undefined` to skip
 *    it (e.g. a transclusion with no id, or a reference missing attrs).
 *  - `key`: dedup key for a produced snapshot. Snapshots sharing a key collapse
 *    to a single entry; `lastWins` decides which one survives.
 *  - `lastWins`: when true (transclusions), a later duplicate overwrites the
 *    earlier one (Map semantics); when false (references, page embeds), the
 *    first occurrence wins and later duplicates are ignored. Either way the
 *    surviving entries keep first-seen insertion order.
 *  - `skipChildrenOfType`: a node type whose subtree the walk must NOT enter.
 *    References/embeds pass `transclusionSource` here (the schema forbids them
 *    inside a source, so a malformed inbound doc can't smuggle one in). The
 *    transclusion collector leaves this undefined because the matched type IS
 *    `transclusionSource` and matched nodes already short-circuit recursion.
 *
 * A matched node never recurses into its own children: every target type here is
 * either an atom (reference/pageEmbed) or a boundary we deliberately don't nest
 * into (transclusionSource), exactly as the original collectors behaved.
 */
function collectNodes<T>(
  doc: unknown,
  opts: {
    type: string;
    map: (node: any) => T | undefined;
    key: (snapshot: T) => string;
    lastWins?: boolean;
    skipChildrenOfType?: string;
  },
): T[] {
  if (!doc || typeof doc !== 'object') return [];

  const { type, map, key, lastWins = false, skipChildrenOfType } = opts;
  const byKey = new Map<string, T>();

  const visit = (node: any, depth: number): void => {
    if (!node || typeof node !== 'object') return;
    // Depth guard against a pathological/cyclic non-JSON input (see
    // MAX_PM_WALK_DEPTH); unreachable on real docs.
    if (depth > MAX_PM_WALK_DEPTH) return;

    if (node.type === type) {
      const snapshot = map(node);
      if (snapshot !== undefined) {
        const k = key(snapshot);
        if (lastWins || !byKey.has(k)) byKey.set(k, snapshot);
      }
      return; // matched node: atom or boundary — do not recurse into children
    }

    // Don't descend into an isolated subtree (schema-enforced boundary).
    if (skipChildrenOfType !== undefined && node.type === skipChildrenOfType) {
      return;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child, depth + 1);
    }
  };

  visit(doc, 0);
  return Array.from(byKey.values());
}

/**
 * Walks a ProseMirror JSON document and returns one snapshot per top-level
 * `transclusion` node. Does not recurse into transclusions (schema disallows
 * nesting). Skips transclusion nodes without an id (transient state). When
 * duplicate ids are encountered, the later occurrence wins so the result is
 * deterministic.
 */
export function collectTransclusionsFromPmJson(
  doc: unknown,
): TransclusionNodeSnapshot[] {
  // last-wins on duplicate ids (Map.set overwrites) — matches prior behaviour.
  return collectNodes<TransclusionNodeSnapshot>(doc, {
    type: TRANSCLUSION_TYPE,
    map: (node) => {
      const id = node.attrs?.id;
      if (typeof id !== 'string' || id.length === 0) return undefined;
      return {
        transclusionId: id,
        content: { type: 'doc', content: node.content ?? [] },
      };
    },
    key: (snapshot) => snapshot.transclusionId,
    lastWins: true,
    // No skipChildrenOfType: TRANSCLUSION_TYPE is itself the matched type, and a
    // matched node already short-circuits recursion (the schema also forbids a
    // transclusion nested inside another).
  });
}

/**
 * Walks a ProseMirror JSON document and returns one snapshot per unique
 * `(sourcePageId, transclusionId)` pair found on `transclusionReference`
 * nodes. The schema forbids references inside a `transclusionSource` so this
 * walk stops at source boundaries — references can only appear at page level.
 * Order preserved by first-seen.
 */
export function collectReferencesFromPmJson(
  doc: unknown,
): TransclusionReferenceSnapshot[] {
  // first-wins dedup on (sourcePageId, transclusionId); skip recursing into a
  // transclusionSource (schema forbids references inside one).
  return collectNodes<TransclusionReferenceSnapshot>(doc, {
    type: REFERENCE_TYPE,
    map: (node) => {
      const sourcePageId = node.attrs?.sourcePageId;
      const transclusionId = node.attrs?.transclusionId;
      if (
        typeof sourcePageId !== 'string' ||
        sourcePageId.length === 0 ||
        typeof transclusionId !== 'string' ||
        transclusionId.length === 0
      ) {
        return undefined;
      }
      return { sourcePageId, transclusionId };
    },
    key: (snapshot) => `${snapshot.sourcePageId}::${snapshot.transclusionId}`,
    skipChildrenOfType: TRANSCLUSION_TYPE,
  });
}

/**
 * Decide the sourcePageId a duplicated pageEmbed should point to: the copy's new
 * id when the embedded source is part of the copied set, otherwise the original
 * (a live embed of the original page). Pure — shared by PageService.duplicatePage
 * (the real path) and the JSON walker below, so both stay in lockstep.
 */
export function remapPageEmbedSourceId(
  sourcePageId: string | null | undefined,
  resolveNewId: (id: string) => string | undefined,
): string | null | undefined {
  if (sourcePageId) {
    const mapped = resolveNewId(sourcePageId);
    if (mapped) return mapped;
  }
  return sourcePageId;
}

/**
 * Remap the `sourcePageId` of every `pageEmbed` node in a ProseMirror JSON doc
 * according to `idMap` (old page id -> new page id). Delegates the per-node
 * decision to the shared `remapPageEmbedSourceId` helper that
 * `PageService.duplicatePage` also uses, so the production path and this walker
 * stay in lockstep: when the embedded source page is part of the copied set
 * (present in `idMap`) the embed is pointed at its new copy; otherwise the
 * original `sourcePageId` is preserved so it stays a live embed of the original
 * page. Mutates `doc` in place (and returns it) to match the service's in-place
 * ProseMirror mutation. Recurses through arbitrary block containers (columns,
 * callouts, etc.) the same way the collectors do, but does NOT descend into a
 * `transclusionSource` (schema-isolated).
 */
export function remapPageEmbedSourceIds<T>(
  doc: T,
  idMap: Map<string, string>,
): T {
  const visit = (node: any, depth: number): void => {
    if (!node || typeof node !== 'object') return;
    // Depth guard against a pathological/cyclic non-JSON input (see
    // MAX_PM_WALK_DEPTH); unreachable on real docs.
    if (depth > MAX_PM_WALK_DEPTH) return;

    if (node.type === PAGE_EMBED_TYPE) {
      if (node.attrs) {
        node.attrs.sourcePageId = remapPageEmbedSourceId(
          node.attrs.sourcePageId,
          (id) => idMap.get(id),
        );
      }
      return; // atom node - no children
    }

    if (node.type === TRANSCLUSION_TYPE) return;

    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child, depth + 1);
    }
  };

  visit(doc, 0);
  return doc;
}

/**
 * Walks a ProseMirror JSON document and returns one snapshot per unique
 * `sourcePageId` found on `pageEmbed` nodes (whole-page live embeds). Order
 * preserved by first-seen, duplicates deduped. `pageEmbed` is an atom so it
 * has no relevant children; we don't descend into transclusion sources.
 */
export function collectPageEmbedsFromPmJson(
  doc: unknown,
): PageEmbedSnapshot[] {
  // first-wins dedup on sourcePageId; skip recursing into a transclusionSource.
  return collectNodes<PageEmbedSnapshot>(doc, {
    type: PAGE_EMBED_TYPE,
    map: (node) => {
      const sourcePageId = node.attrs?.sourcePageId;
      if (typeof sourcePageId !== 'string' || sourcePageId.length === 0) {
        return undefined;
      }
      return { sourcePageId };
    },
    key: (snapshot) => snapshot.sourcePageId,
    skipChildrenOfType: TRANSCLUSION_TYPE,
  });
}
