import { TransclusionNodeSnapshot } from '../transclusion.types';

const TRANSCLUSION_TYPE = 'transclusionSource';
const REFERENCE_TYPE = 'transclusionReference';
const PAGE_EMBED_TYPE = 'pageEmbed';

export type TransclusionReferenceSnapshot = {
  sourcePageId: string;
  transclusionId: string;
};

export type PageEmbedSnapshot = {
  sourcePageId: string;
};

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
  if (!doc || typeof doc !== 'object') return [];

  const byId = new Map<string, TransclusionNodeSnapshot>();

  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;

    if (node.type === TRANSCLUSION_TYPE) {
      const id = node.attrs?.id;
      if (typeof id === 'string' && id.length > 0) {
        byId.set(id, {
          transclusionId: id,
          content: { type: 'doc', content: node.content ?? [] },
        });
      }
      return; // do not recurse into transclusion children
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };

  visit(doc);
  return Array.from(byId.values());
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
  if (!doc || typeof doc !== 'object') return [];

  const seen = new Set<string>();
  const out: TransclusionReferenceSnapshot[] = [];

  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;

    if (node.type === REFERENCE_TYPE) {
      const sourcePageId = node.attrs?.sourcePageId;
      const transclusionId = node.attrs?.transclusionId;
      if (
        typeof sourcePageId === 'string' &&
        sourcePageId.length > 0 &&
        typeof transclusionId === 'string' &&
        transclusionId.length > 0
      ) {
        const key = `${sourcePageId}::${transclusionId}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ sourcePageId, transclusionId });
        }
      }
      return; // atom node - no children
    }

    // References cannot live inside a source (schema-enforced); skip recursing
    // so a malformed inbound doc can't sneak in a nested reference here.
    if (node.type === TRANSCLUSION_TYPE) return;

    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };

  visit(doc);
  return out;
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
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;

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
      for (const child of node.content) visit(child);
    }
  };

  visit(doc);
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
  if (!doc || typeof doc !== 'object') return [];

  const seen = new Set<string>();
  const out: PageEmbedSnapshot[] = [];

  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;

    if (node.type === PAGE_EMBED_TYPE) {
      const sourcePageId = node.attrs?.sourcePageId;
      if (typeof sourcePageId === 'string' && sourcePageId.length > 0) {
        if (!seen.has(sourcePageId)) {
          seen.add(sourcePageId);
          out.push({ sourcePageId });
        }
      }
      return; // atom node - no children
    }

    if (node.type === TRANSCLUSION_TYPE) return;

    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };

  visit(doc);
  return out;
}
