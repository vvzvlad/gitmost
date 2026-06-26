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
export declare function buildVaultLayout(pages: PageNode[]): Map<string, VaultEntry>;
