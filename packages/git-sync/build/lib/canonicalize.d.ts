/**
 * Semantic canonicalization of ProseMirror/TipTap documents for the round-trip
 * idempotency check (SPEC §11, "Задача №0", option (б): compare a CANONICALIZED
 * form rather than raw bytes).
 *
 * `markdownToProseMirror` reconstructs schema DEFAULT attributes (e.g.
 * `indent: null` where the source omitted it) and regenerates per-block ids on
 * every import. A raw deep-equal of the source doc against the re-imported doc
 * therefore diverges even when the two are semantically identical. This module
 * normalizes a document so that two semantically-equal docs compare deep-equal
 * regardless of block ids and absent-vs-explicit-default-null attributes.
 *
 * It is a self-contained module with no external dependencies.
 */
/**
 * Return a DEEP COPY of a ProseMirror node tree, canonicalized so that two
 * semantically-equal documents compare deep-equal. Rules (applied recursively
 * to the node, its `content`, and its `marks`):
 *
 *  1. Remove node-level `attrs.id` (regenerated on import). Mark attrs are NOT
 *     touched for `id` (marks carry no block id; only their meaningful attrs).
 *  2. In any `attrs` object (node OR mark) drop keys whose value is `null`/
 *     `undefined` (absent ≡ explicit default null) OR equals that node/mark
 *     type's known non-null schema default (absent ≡ explicit default).
 *     Keep every non-default value. The type is passed into the attrs
 *     normalizer so it can look up `KNOWN_DEFAULTS`.
 *  3. If an `attrs` object becomes empty after pruning, drop the `attrs` key.
 *  4. Preserve `marks` (including the `comment` mark and its `commentId` — a
 *     meaningful anchor per SPEC §3; never strip it).
 *  5. Preserve `text`, `type`, and `content` order exactly.
 *  6. Never mutate the input.
 */
export declare function canonicalizeContent(node: any): any;
/**
 * True when two ProseMirror documents are semantically equal: equal after
 * canonicalization (block ids stripped, absent-vs-default-null normalized).
 */
export declare function docsCanonicallyEqual(a: any, b: any): boolean;
