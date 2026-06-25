/**
 * Stable hash of a page's markdown BODY (SPEC §10 "хэш тела"). Deterministic:
 * the same input string always yields the same digest, a different input a
 * different one. Used to recognize our own write later (loop suppression).
 *
 * We hash the body STRING as-is (UTF-8) with SHA-256 and return lowercase hex.
 * SPEC §10 keys on the body hash rather than file bytes; callers decide WHAT
 * counts as "the body" (here it is the exact string passed in — typically the
 * self-contained markdown that was pushed). No normalization is applied: the
 * caller is responsible for passing a canonical/stable representation if it
 * wants hash equality across cosmetic-only differences.
 */
export declare function bodyHash(markdownBody: string): string;
