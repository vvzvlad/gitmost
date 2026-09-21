/**
 * Pure page-tree -> vault path mapping (SPEC §12).
 *
 * Given the flat list of page nodes for a space (as returned by
 * `listAllSpacePages`), compute for every page a deterministic, collision-free
 * destination: a folder path (root -> leaf ancestors) plus a file stem (the
 * page's own name, no extension). This module is intentionally PURE and
 * dependency-free apart from the sanitization helpers, so the whole tree ->
 * path logic is unit-testable without any I/O. The names are COSMETIC; identity
 * lives in each file's meta block (pageId / slugId).
 */

import { sanitizeTitle, disambiguate } from "./sanitize.js";

/** Flat page node as returned by `listAllSpacePages` (no content). */
export interface PageNode {
  id: string;
  title?: string;
  slugId?: string;
  parentPageId?: string | null;
  hasChildren?: boolean;
}

/** A page's resolved vault destination: folder path + file stem. */
export interface VaultEntry {
  /** Folder path, root -> leaf (the page's ancestors). Empty for a root page. */
  segments: string[];
  /** The page's own file name without extension. */
  stem: string;
}

/**
 * Build the full vault layout for a space.
 *
 * Returns a Map keyed by pageId -> `{ segments, stem }`. The result is
 * deterministic for a given input and guarantees every full destination path
 * (`[...segments, stem].join("/")`) is unique, so no page can silently overwrite
 * another.
 *
 * Disambiguation is layered:
 *   1. Sibling collisions (same sanitized title under the same parent) are
 *      resolved with a stable ` ~<slugId>` suffix (the suffix is itself
 *      sanitized, since slugId/id is untrusted data that must never inject a
 *      path separator).
 *   2. A final full-path pass catches residual collisions that sibling-scoping
 *      cannot see — e.g. two pages whose parents are BOTH outside the input set
 *      both bucket at the root with `segments: []`.
 */
export function buildVaultLayout(pages: PageNode[]): Map<string, VaultEntry> {
  // Index pages by id so the parent chain can be walked. Guard against
  // duplicate ids in the input (first one wins).
  const byId = new Map<string, PageNode>();
  for (const p of pages) {
    if (p && p.id && !byId.has(p.id)) byId.set(p.id, p);
  }

  // Resolve each node's display name once, deterministically. The bucket key is
  // the node's parent ONLY when that parent is actually present in `byId`;
  // otherwise (null parent, or an orphan whose parent is outside the input set)
  // the node buckets at `"__root__"`. This is critical: orphans land at the vault
  // root (see `folderSegmentsFor`), so they MUST share the root bucket with real
  // root pages to be disambiguated against each other here — making `nameById`
  // final before any `segments` are computed, so no ancestor name can drift.
  const parentKeyOf = (p: PageNode): string =>
    p.parentPageId && byId.has(p.parentPageId) ? p.parentPageId : "__root__";
  // Group nodes by (parentKey, sanitized base title) so sibling collisions are
  // resolved by a STABLE rule that does NOT depend on input array order. Dedupe
  // ids (first occurrence wins, matching `byId`).
  const siblingGroups = new Map<string, PageNode[]>();
  const namedIds = new Set<string>();
  for (const p of pages) {
    if (!p || !p.id || namedIds.has(p.id)) continue;
    namedIds.add(p.id);
    const key = `${parentKeyOf(p)}\u0000${sanitizeTitle(p.title ?? "")}`;
    const bucket = siblingGroups.get(key);
    if (bucket) bucket.push(p);
    else siblingGroups.set(key, [p]);
  }
  // Assign each node its display name. Within a colliding group, sort the
  // siblings by their stable disambiguation key (`slugId` else `id`) and let the
  // FIRST keep the bare sanitized title; every OTHER gets the ` ~<slugId>`
  // suffix. This makes `nameById` a pure function of the page SET — reordering
  // the input never moves the suffix onto a different page (red-team #4a). The
  // suffix is itself sanitized (the slugId/id is untrusted and must never inject
  // a path separator).
  const nameById = new Map<string, string>();
  const disambKeyOf = (p: PageNode): string => p.slugId ?? p.id;
  for (const bucket of siblingGroups.values()) {
    const base = sanitizeTitle(bucket[0].title ?? "");
    if (bucket.length === 1) {
      nameById.set(bucket[0].id, base);
      continue;
    }
    const sorted = [...bucket].sort((a, b) => {
      const ka = disambKeyOf(a);
      const kb = disambKeyOf(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    sorted.forEach((p, i) => {
      nameById.set(
        p.id,
        i === 0 ? base : disambiguate(base, sanitizeTitle(disambKeyOf(p))),
      );
    });
  }

  // Every id we index above MUST get a resolved name; this helper returns it
  // and THROWS if it is somehow absent, rather than silently recomputing a
  // DIFFERENT, non-disambiguated name (which would desync a folder segment from
  // its target file).
  const nameOf = (id: string): string => {
    const name = nameById.get(id);
    if (name === undefined) {
      throw new Error(`buildVaultLayout: no resolved name for page id ${id}`);
    }
    return name;
  };

  // Build the folder path for a page by walking parentPageId to the root. The
  // page's OWN name is the file stem; its ancestors become folders. A `visited`
  // guard prevents an infinite loop on a malformed parent cycle.
  const folderSegmentsFor = (node: PageNode): string[] => {
    const ancestors: string[] = [];
    const visited = new Set<string>();
    let current: PageNode | undefined = node.parentPageId
      ? byId.get(node.parentPageId)
      : undefined;
    while (current && current.id && !visited.has(current.id)) {
      visited.add(current.id);
      ancestors.unshift(nameOf(current.id));
      current = current.parentPageId
        ? byId.get(current.parentPageId)
        : undefined;
    }
    return ancestors;
  };

  // First pass: compute the provisional { segments, stem } for every node.
  const layout = new Map<string, VaultEntry>();
  for (const p of pages) {
    if (!p || !p.id || layout.has(p.id)) continue;
    layout.set(p.id, {
      segments: folderSegmentsFor(p),
      stem: nameOf(p.id),
    });
  }

  // FOLDER-NOTE transform (native-Obsidian layout): a page WITH CHILDREN lives at
  // `<…>/<stem>/<stem>.md` — its body is the folder-note INSIDE its own folder
  // (LostPaul Folder Notes convention), and its children sit alongside it in that
  // folder. A leaf stays `<…>/<stem>.md`. Children's segments already point into
  // the parent's folder (folderSegmentsFor walks ancestor NAMES), so only the
  // parent's own file relocates here; the sibling name pass above already made
  // the parent name unique, so folder == file name stays consistent.
  for (const p of pages) {
    if (!p || !p.id) continue;
    const entry = layout.get(p.id);
    if (entry && p.hasChildren) {
      entry.segments = [...entry.segments, entry.stem];
    }
  }

  // Final full-path uniqueness pass — a belt-and-suspenders safety net. Note
  // that cross-bucket (orphan/root) collisions are now resolved in the name pass
  // above (orphans share the "__root__" bucket), so ancestor names are final
  // before `segments` are built and this pass should rarely/never re-stem an
  // ancestor. It only re-stems the colliding LATER leaf via the sanitized
  // slugId/id, then (if still colliding) appends the id.
  //
  // Process FOLDER-NOTES (pages with children) FIRST so a parent claims its
  // canonical `<name>/<name>.md` before a same-named CHILD — the child (a leaf)
  // is the one that disambiguates, never the folder-note.
  const usedPaths = new Set<string>();
  const seenIds = new Set<string>();
  const pathKey = (e: VaultEntry): string => [...e.segments, e.stem].join("/");
  const ordered = pages
    .filter((p): p is PageNode => Boolean(p && p.id))
    .sort(
      (a, b) =>
        Number(Boolean(b.hasChildren)) - Number(Boolean(a.hasChildren)),
    );
  for (const p of ordered) {
    if (seenIds.has(p.id)) continue;
    seenIds.add(p.id);
    const entry = layout.get(p.id);
    if (!entry) continue;

    if (usedPaths.has(pathKey(entry))) {
      // First attempt: disambiguate the stem with the sanitized slugId (or id).
      entry.stem = disambiguate(entry.stem, sanitizeTitle(p.slugId ?? p.id));
      if (usedPaths.has(pathKey(entry))) {
        // Still colliding: append the (sanitized) id as a last resort. The id
        // is globally unique, so this always resolves the collision.
        entry.stem = disambiguate(entry.stem, sanitizeTitle(p.id));
      }
    }
    usedPaths.add(pathKey(entry));
  }

  return layout;
}

