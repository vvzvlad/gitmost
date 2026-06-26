import { VaultGit } from "./git.js";
import { GitSyncClient } from "./client.types.js";
import { Settings } from "./settings.js";
/**
 * Absolute-path filesystem primitives the cycle needs. Injected (not imported)
 * so the engine stays IO-free and unit-testable. `mkdir` is recursive; `rm` is
 * force (a missing file is a no-op).
 */
export interface CycleFs {
    readFile: (absPath: string) => Promise<string>;
    writeFile: (absPath: string, text: string) => Promise<void>;
    mkdir: (absDir: string) => Promise<void>;
    rm: (absPath: string) => Promise<void>;
}
export interface RunCycleDeps {
    spaceId: string;
    /** The Docmost seam (reads for pull, writes for push). */
    client: GitSyncClient;
    /** The per-space git vault (a real working repo). */
    vault: VaultGit;
    /** Engine settings; `vaultPath` roots the relPath -> absolute-path mapping. */
    settings: Settings;
    fs: CycleFs;
    log: (line: string) => void;
    /**
     * Delete-cap hook (the ONLY caller-specific policy). Called with the push
     * dry-run's planned delete count (`Number.POSITIVE_INFINITY` when the dry-run
     * itself failed, so the hook can fail safe) and the live client; returns the
     * client to use for the REAL apply. The default (omitted) applies every op
     * unmodified. gitmost uses it to neutralize deletes when over its cap.
     *
     * When omitted, NO dry-run is performed (one fewer push planning pass).
     */
    resolveApplyClient?: (plannedDeletes: number, client: GitSyncClient) => GitSyncClient;
}
export interface RunCycleResult {
    ran: boolean;
    /** Set when the cycle short-circuited without running pull/push. */
    skipped?: "merge-in-progress";
    pull?: {
        written: number;
        deleted: number;
        conflict: boolean;
    };
    push?: {
        mode: string;
        failures: number;
    };
}
/**
 * Run ONE full reconcile cycle for a space: PULL (Docmost -> vault) then PUSH
 * (vault -> Docmost), under the engine's required branch choreography. This is
 * the single entry point the app drives — it owns the staging order so it can
 * never drift from the engine it ships with.
 *
 * Staging (the ⭐ data-loss-critical order, SPEC §6/§9):
 *   1. assertGitAvailable + ensureRepo (the git state store must exist).
 *   2. refuse on an unresolved merge (a prior conflicting pull); next checkout
 *      would fail otherwise.
 *   3. ensureBranch('docmost','main') + checkout('docmost'). Pull writes MUST
 *      land on `docmost`, not `main`: applyPullActions commits on `docmost`,
 *      then checks out `main` and merges docmost -> main. Writing Docmost
 *      content straight onto `main` would clobber local file edits before push
 *      can diff them.
 *   4. PULL: readExisting -> listSpaceTree -> computePullActions -> apply.
 *   5. PUSH: optional dry-run to feed the delete-cap hook, then the real apply.
 *
 * Lock + cap POLICY live in the caller; this owns only the mechanics.
 */
export declare function runCycle(deps: RunCycleDeps): Promise<RunCycleResult>;
