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
export function buildVaultLayout(pages) {
    // Index pages by id so the parent chain can be walked. Guard against
    // duplicate ids in the input (first one wins).
    const byId = new Map();
    for (const p of pages) {
        if (p && p.id && !byId.has(p.id))
            byId.set(p.id, p);
    }
    // Resolve each node's display name once, deterministically, tracking sibling
    // collisions per parent. `usedBySibling` maps a parent key -> set of names
    // already taken under that parent. The bucket key is the node's parent ONLY
    // when that parent is actually present in `byId`; otherwise (null parent, or
    // an orphan whose parent is outside the input set) the node buckets at
    // `"__root__"`. This is critical: orphans land at the vault root (see
    // `folderSegmentsFor`), so they MUST share the root bucket with real root
    // pages to be disambiguated against each other here — making `nameById` final
    // before any `segments` are computed, so no ancestor name can drift later.
    const usedBySibling = new Map();
    const nameById = new Map();
    for (const p of pages) {
        if (p && p.id && !nameById.has(p.id)) {
            const parentKey = p.parentPageId && byId.has(p.parentPageId) ? p.parentPageId : "__root__";
            nameById.set(p.id, nameForNode(p, parentKey, usedBySibling));
        }
    }
    // Every id we index above MUST get a resolved name; this helper returns it
    // and THROWS if it is somehow absent, rather than silently recomputing a
    // DIFFERENT, non-disambiguated name (which would desync a folder segment from
    // its target file).
    const nameOf = (id) => {
        const name = nameById.get(id);
        if (name === undefined) {
            throw new Error(`buildVaultLayout: no resolved name for page id ${id}`);
        }
        return name;
    };
    // Build the folder path for a page by walking parentPageId to the root. The
    // page's OWN name is the file stem; its ancestors become folders. A `visited`
    // guard prevents an infinite loop on a malformed parent cycle.
    const folderSegmentsFor = (node) => {
        const ancestors = [];
        const visited = new Set();
        let current = node.parentPageId
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
    const layout = new Map();
    for (const p of pages) {
        if (!p || !p.id || layout.has(p.id))
            continue;
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
        if (!p || !p.id)
            continue;
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
    const usedPaths = new Set();
    const seenIds = new Set();
    const pathKey = (e) => [...e.segments, e.stem].join("/");
    const ordered = pages
        .filter((p) => Boolean(p && p.id))
        .sort((a, b) => Number(Boolean(b.hasChildren)) - Number(Boolean(a.hasChildren)));
    for (const p of ordered) {
        if (seenIds.has(p.id))
            continue;
        seenIds.add(p.id);
        const entry = layout.get(p.id);
        if (!entry)
            continue;
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
/**
 * Compute a deterministic, collision-free name for a node among its SIBLINGS.
 * `usedBySibling` maps a parent key -> set of names already taken, so two
 * siblings that sanitize to the same name get a stable ` ~slugId` suffix
 * (SPEC §12). The suffix is itself passed through `sanitizeTitle`, because the
 * slugId/id is a second untrusted-data channel that must never leak a path
 * separator into the name. `parentKey` is supplied by the caller (it resolves
 * to `"__root__"` for root pages AND for orphans whose parent is outside the
 * input set, so they share one bucket). The name is COSMETIC; identity lives in
 * the meta block.
 */
function nameForNode(node, parentKey, usedBySibling) {
    let used = usedBySibling.get(parentKey);
    if (!used) {
        used = new Set();
        usedBySibling.set(parentKey, used);
    }
    let name = sanitizeTitle(node.title ?? "");
    if (used.has(name)) {
        // Sibling collision: disambiguate with the stable, sanitized slugId (fall
        // back to the sanitized pageId if no slugId is present).
        name = disambiguate(name, sanitizeTitle(node.slugId ?? node.id));
    }
    used.add(name);
    return name;
}
