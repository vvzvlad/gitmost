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
export function planReconciliation(live, existing) {
    // Desired path for each live pageId.
    const liveByPageId = new Map();
    // Set of all paths that WILL be written (never delete/remove one of these).
    const liveTargetPaths = new Set();
    for (const e of live) {
        liveByPageId.set(e.pageId, e.relPath);
        liveTargetPaths.add(e.relPath);
    }
    const toWrite = live.map((e) => ({
        pageId: e.pageId,
        relPath: e.relPath,
    }));
    const moved = [];
    // Absence-based deletions ONLY (tracked pageId absent from `live`). Use a Set
    // so the same path coming from multiple existing rows is queued only once.
    const toDeleteSet = new Set();
    for (const ex of existing) {
        const liveRel = liveByPageId.get(ex.pageId);
        if (liveRel === undefined) {
            // Tracked page is gone from the live tree -> absence delete.
            // Never queue a path a live page will (re)write (path reuse -> no loss).
            if (!liveTargetPaths.has(ex.relPath))
                toDeleteSet.add(ex.relPath);
            continue;
        }
        if (liveRel !== ex.relPath) {
            // Same pageId, different path -> a MOVE. Record it so the caller can write
            // the new path first, then remove the old one. If the old path is itself a
            // live target (reused by another page), it must NOT be removed — the write
            // owns it — so flag `removeOldPath: false` (move still recorded).
            moved.push({
                pageId: ex.pageId,
                fromRelPath: ex.relPath,
                toRelPath: liveRel,
                removeOldPath: !liveTargetPaths.has(ex.relPath),
            });
        }
        // liveRel === ex.relPath -> content-update in place; nothing extra to do
        // (the write above re-emits the file; identical bytes => git no-op).
    }
    const toDelete = [...toDeleteSet];
    return { toWrite, toDelete, moved };
}
/**
 * Below this many tracked files the mass-delete fraction guard is not applied
 * (a tiny vault where deleting "most" files is normal, e.g. 1-of-2).
 */
export const MASS_DELETE_MIN_EXISTING = 4;
/** Fraction of tracked files above which a delete plan is a suspected wipe. */
export const MASS_DELETE_FRACTION = 0.5;
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
export function decideAbsenceDeletions(args) {
    const { treeComplete, liveCount, existingCount, deleteCount } = args;
    // No tracked files, or nothing to delete -> trivially fine to "apply".
    if (existingCount === 0 || deleteCount === 0)
        return { apply: true };
    if (!treeComplete)
        return { apply: false, reason: "incomplete-fetch" };
    if (liveCount === 0)
        return { apply: false, reason: "empty-live" };
    if (existingCount >= MASS_DELETE_MIN_EXISTING &&
        deleteCount > existingCount * MASS_DELETE_FRACTION) {
        return { apply: false, reason: "mass-delete" };
    }
    return { apply: true };
}
