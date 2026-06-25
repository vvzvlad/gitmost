import type { GitSyncClient } from "./client.types.js";
import { type PageNode } from "./layout.js";
import { VaultGit } from "./git.js";
import { type MovedEntry, type DeletionDecision } from "./reconcile.js";
/**
 * Injectable IO for `readExisting` (R-Pull-1, test-strategy report §5). The real
 * `main` wires these to `git.listTrackedFiles("*.md")` and an `fs.readFile`
 * rooted at the vault; tests pass fakes so the parsing/skip rules are unit-
 * testable without a real git repo or filesystem.
 */
export interface ReadExistingDeps {
    /** List tracked .md paths (forward-slash, vault-relative). */
    listTracked: () => Promise<string[]>;
    /** Read a tracked file's text by its (forward-slash) vault-relative path. */
    readFile: (relPath: string) => Promise<string>;
}
/**
 * Read every tracked .md file in the vault and recover `{ pageId, relPath }` from
 * its `gitmost_id` frontmatter (native-Obsidian format). Files without a
 * `gitmost_id` are skipped (they are not engine-tracked pages yet — e.g. a stray
 * hand-written Obsidian file; PUSH adopts those separately).
 *
 * The IO is injected (R-Pull-1) so this is testable with fakes. Skip rules:
 *   - a `readFile` rejection (tracked but missing on disk, a mid-operation race)
 *     -> skipped, NOT thrown; the next pull converges;
 *   - no `gitmost_id` frontmatter (`parsePageFile` -> id null) -> skipped.
 */
export declare function readExisting(deps: ReadExistingDeps): Promise<{
    pageId: string;
    relPath: string;
}[]>;
/**
 * Input to the PURE `computePullActions` (R-Pull-2). All data, no IO: the live
 * tree nodes + completeness flag (from `listSpaceTree`) and the parsed
 * `existing` tracked files (from `readExisting`).
 */
export interface PullActionsInput {
    /** Live page nodes for the space (from `listSpaceTree`). */
    pages: PageNode[];
    /** Whether the live tree fetch was COMPLETE (SPEC §8 suppression). */
    treeComplete: boolean;
    /** Parsed tracked files: `{ pageId, relPath }` (from `readExisting`). */
    existing: {
        pageId: string;
        relPath: string;
    }[];
}
/**
 * The PURE decisions object computed by `computePullActions` (no IO). It holds
 * the reconciliation plan plus the SPEC §8 absence-deletion decision, with the
 * suppression already folded in: `toDelete` is the POST-suppression set the
 * caller should actually remove (empty when `deletionDecision.apply` is false).
 */
export interface PullActions {
    /** Pages to (re)write at their relPath (add + update + move target). */
    toWrite: {
        pageId: string;
        relPath: string;
    }[];
    /** Moves: write new path, then remove old path (only on a successful write). */
    moved: MovedEntry[];
    /**
     * Absence-based paths to delete AFTER suppression. Empty when the decision
     * suppressed deletions this cycle, so the caller can apply it unconditionally.
     */
    toDelete: string[];
    /** Why absence deletions were (or were not) applied (for logging + tests). */
    deletionDecision: DeletionDecision;
    /** Tracked-file count (for the suppression log messages). */
    existingCount: number;
    /** Planned absence-delete count BEFORE suppression (for the log message). */
    plannedDeleteCount: number;
}
/**
 * PURE pull-action planner (R-Pull-2, test-strategy report §5). Takes the live
 * tree nodes + completeness + existing tracked files and returns the full set of
 * decisions with NO IO:
 *
 *   - builds the vault layout (deterministic relPath per live page),
 *   - `planReconciliation` -> toWrite / moved / absence-toDelete,
 *   - `decideAbsenceDeletions` -> the SPEC §8 suppression (incomplete-fetch +
 *     empty-live + mass-delete guard), folded IN here so `toDelete` is the
 *     POST-suppression set (empty when suppressed).
 *
 * Moves are NOT governed by the suppression: a moved page is present in `live`,
 * so its old-path removal is real (the caller still gates it on the write
 * succeeding). The expensive content fetch / file write / git ops happen in the
 * thin `applyPullActions`.
 */
export declare function computePullActions(input: PullActionsInput): PullActions;
/**
 * Injectable IO for `applyPullActions` (R-Pull-2). The real `main` wires these
 * to the live client, the vault git wrapper, and `node:fs/promises`; tests pass
 * fakes that RECORD calls so the ordering + the move-on-success data-loss guard
 * are testable without real git/fs/network.
 */
export interface ApplyPullActionsDeps {
    client: Pick<GitSyncClient, "getPageJson">;
    git: Pick<VaultGit, "stageAll" | "commit" | "checkout" | "merge">;
    /** Write a file by ABSOLUTE path (mkdir of the parent is done internally). */
    writeFile: (absPath: string, text: string) => Promise<void>;
    /** Recursive mkdir of an ABSOLUTE directory path. */
    mkdir: (absDir: string) => Promise<void>;
    /** Remove a file by ABSOLUTE path (force: a missing file is a no-op). */
    rm: (absPath: string) => Promise<void>;
}
/** Outcome counters from `applyPullActions` (for the summary + tests). */
export interface ApplyResult {
    written: number;
    movedApplied: number;
    deleted: number;
    failed: number;
    committed: boolean;
    merge: {
        ok: boolean;
        conflict: boolean;
        output: string;
    };
}
/**
 * THIN IO applier (R-Pull-2). Performs the side effects in the EXACT current
 * order, with all the original safety guards preserved bit-for-bit:
 *
 *   1. for each `toWrite`: fetch content (`client.getPageJson`) -> stabilize
 *      (normalize-on-write fixpoint, SPEC §11) -> mkdir + write. One bad page
 *      never aborts the pull (bounded-concurrency pool, fault-tolerant).
 *   2. apply MOVE old-path removals — ONLY when the planner marked the old path
 *      removable AND the new-path write SUCCEEDED (the ⭐ data-loss guard: a
 *      failed move-write keeps the old path so the page never vanishes).
 *   3. apply (post-suppression) absence deletes.
 *   4. stageAll + commit on `docmost` (subject from ACTUAL written/deleted
 *      counts) + checkout main + merge docmost (conflicts surfaced, SPEC §9).
 *
 * `vaultRoot` roots the relPath -> absolute-path conversion for the fs deps.
 */
export declare function applyPullActions(deps: ApplyPullActionsDeps, actions: PullActions, vaultRoot: string): Promise<ApplyResult>;
