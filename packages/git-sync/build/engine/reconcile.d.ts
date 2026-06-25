/**
 * Pure reconciliation planner (SPEC §5/§6/§8).
 *
 * Given the desired live set of files (computed from the current Docmost tree)
 * and the set of files currently tracked in the vault, compute what to write,
 * what to move (old path to remove), and what to delete. Identity is `pageId`
 * (the stable file<->page anchor, SPEC §4): a page that keeps its pageId but
 * changes relPath is a MOVE, not delete+add; a tracked pageId that is gone from
 * the live tree is a DELETE.
 *
 * This module is intentionally PURE (no IO, no git) so the whole plan is
 * unit-testable. The actual file writing / git operations happen in pull.ts.
 */
/** A page that SHOULD exist in the vault at a given path. */
export interface LiveEntry {
    pageId: string;
    /** Vault-relative path (forward-slash), e.g. `Space/Parent/Child.md`. */
    relPath: string;
}
/** A page currently tracked in the vault (pageId parsed from its meta). */
export interface ExistingEntry {
    pageId: string;
    /** Vault-relative path (forward-slash) of the tracked file. */
    relPath: string;
}
/** A page to (re)write at its destination path. */
export interface WriteEntry {
    pageId: string;
    relPath: string;
}
/** A page that moved: written at its NEW relPath, with the OLD path removed. */
export interface MovedEntry {
    pageId: string;
    fromRelPath: string;
    toRelPath: string;
    /**
     * Whether the old path (`fromRelPath`) is SAFE to remove. False when another
     * live page will (re)write that exact path (path reuse): removing it would
     * destroy real data, so the caller must skip the removal. The move itself is
     * still recorded (the new path is written regardless).
     */
    removeOldPath: boolean;
}
/** The full reconciliation plan. */
export interface ReconciliationPlan {
    /**
     * Pages present in `live` -> (re)write at their relPath. This naturally
     * covers add, content-update (same path) AND move (same pageId, new path),
     * since every live page is (re)written regardless of whether it existed.
     */
    toWrite: WriteEntry[];
    /**
     * Vault-relative paths to delete because their tracked pageId is ABSENT from
     * `live` (page removed/trashed). This set is ONLY absence-based deletions —
     * the OLD paths of moved pages are NOT here (they live in `moved` and are
     * applied separately by the caller). Keeping the two apart lets pull.ts gate
     * absence deletions behind the incomplete-fetch suppression + mass-delete
     * guard (SPEC §8) while still applying real moves.
     */
    toDelete: string[];
    /**
     * Tracked pages whose relPath changed. The caller writes the page at
     * `toRelPath`, then removes `fromRelPath` — but ONLY after the new-path write
     * succeeded. The old path is NOT in `toDelete`.
     */
    moved: MovedEntry[];
}
/**
 * Compute the reconciliation plan.
 *
 * Rules:
 *   - Every `live` page is written at its relPath (covers add + update + move).
 *   - A tracked pageId present in `live` whose relPath changed is `moved`; its
 *     OLD relPath goes into `moved` ONLY (the caller removes it after the new
 *     path is written) and is NEVER added to `toDelete`.
 *   - A tracked pageId NOT present in `live` is an ABSENCE delete; its relPath
 *     is added to `toDelete`.
 *
 * Notes:
 *   - Safety filter (no data loss): no path that is a live TARGET path of any
 *     page is ever deleted/removed (a write owns it). This applies to BOTH the
 *     absence `toDelete` set AND a moved page's old-path removal — if a moved
 *     page's OLD path is reused by ANOTHER live page, the move records no old
 *     path to remove, because that path will be (re)written.
 *   - `existing` may legitimately contain duplicate pageIds (two stray files
 *     carrying the same meta pageId); each such file that is not the live target
 *     path is removed (as an absence/move) so the vault converges to exactly the
 *     live set.
 */
export declare function planReconciliation(live: LiveEntry[], existing: ExistingEntry[]): ReconciliationPlan;
/**
 * Below this many tracked files the mass-delete fraction guard is not applied
 * (a tiny vault where deleting "most" files is normal, e.g. 1-of-2).
 */
export declare const MASS_DELETE_MIN_EXISTING = 4;
/** Fraction of tracked files above which a delete plan is a suspected wipe. */
export declare const MASS_DELETE_FRACTION = 0.5;
/** Why absence-based deletions were (or were not) applied this cycle. */
export type DeletionDecision = {
    apply: true;
} | {
    apply: false;
    reason: "incomplete-fetch" | "empty-live" | "mass-delete";
};
/**
 * Pure decision: should the ABSENCE-based deletions (`plan.toDelete`) be applied
 * this cycle? Encapsulates the SPEC §8 safety invariants so they are unit-
 * testable without live creds or git:
 *
 *   - `treeComplete === false` (a partial Docmost tree fetch) -> SUPPRESS. A page
 *     missing from a partial tree is NOT proof of deletion (SPEC §8); we must not
 *     delete merely-absent files this cycle. (Writes/updates/moves still happen.)
 *   - The live fetch returned 0 pages while files are tracked -> SUPPRESS
 *     (almost always a failed fetch, never a real "delete everything").
 *   - The plan would delete more than `MASS_DELETE_FRACTION` of a non-trivial
 *     vault -> SUPPRESS as a mass-deletion guard (defense in depth).
 *
 * Moves are NOT governed by this decision: a moved page IS present in `live`, so
 * its old-path removal is real (handled by the caller separately).
 */
export declare function decideAbsenceDeletions(args: {
    treeComplete: boolean;
    liveCount: number;
    existingCount: number;
    deleteCount: number;
}): DeletionDecision;
