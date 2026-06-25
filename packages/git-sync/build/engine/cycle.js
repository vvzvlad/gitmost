import { readExisting, computePullActions, applyPullActions } from "./pull.js";
import { runPush } from "./push.js";
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
export async function runCycle(deps) {
    const { spaceId, client, vault, settings, fs, log, resolveApplyClient } = deps;
    const vaultRoot = settings.vaultPath;
    const abs = (relPath) => `${vaultRoot}/${relPath}`;
    // 1. The engine state store is git: make sure the repo + branches exist
    //    before any tracked-file listing or diff.
    await vault.assertGitAvailable();
    await vault.ensureRepo();
    // 2. Refuse to run on top of an unresolved merge (SPEC §9): a prior
    //    conflicting pull leaves the vault mid-merge; the next checkout would fail.
    if (await vault.isMergeInProgress()) {
        log(`vault has an unresolved merge — resolve it (or 'git merge --abort') ` +
            `and re-run (SPEC §9); skipping cycle.`);
        return { ran: false, skipped: "merge-in-progress" };
    }
    // 3. Pull writes happen on `docmost`; be on it BEFORE applying (see docstring).
    await vault.ensureBranch("docmost", "main");
    await vault.checkout("docmost");
    // 4. PULL --------------------------------------------------------------------
    const existing = await readExisting({
        listTracked: () => vault.listTrackedFiles("*.md"),
        readFile: (relPath) => fs.readFile(abs(relPath)),
    });
    const tree = await client.listSpaceTree(spaceId);
    const pullActions = computePullActions({
        pages: tree.pages,
        treeComplete: tree.complete,
        existing,
    });
    const pullResult = await applyPullActions({
        client,
        git: vault,
        writeFile: (absPath, text) => fs.writeFile(absPath, text),
        mkdir: (absDir) => fs.mkdir(absDir),
        rm: (absPath) => fs.rm(absPath),
    }, pullActions, vaultRoot);
    // 5. PUSH --------------------------------------------------------------------
    const pushDeps = {
        settings,
        git: vault,
        makeClient: () => client,
        readFile: (relPath) => fs.readFile(abs(relPath)),
        writeFile: (relPath, text) => fs.writeFile(abs(relPath), text),
        log,
    };
    let applyClient = client;
    if (resolveApplyClient) {
        // Plan the push as a DRY-RUN first to read the delete count, then let the
        // caller decide the apply client (e.g. neutralize deletes over a cap). A
        // failed dry-run yields Infinity so the hook can fail safe.
        let plannedDeletes;
        try {
            const dry = await runPush(pushDeps, { dryRun: true });
            plannedDeletes = dry.planned?.deletes ?? 0;
        }
        catch (err) {
            log(`push dry-run planning failed (${err instanceof Error ? err.message : String(err)}); deferring deletion policy to the cap hook (fail-safe).`);
            plannedDeletes = Number.POSITIVE_INFINITY;
        }
        applyClient = resolveApplyClient(plannedDeletes, client);
    }
    const pushResult = await runPush({ ...pushDeps, makeClient: () => applyClient }, { dryRun: false });
    return {
        ran: true,
        pull: {
            written: pullResult.written,
            deleted: pullResult.deleted,
            conflict: pullResult.merge.conflict,
        },
        push: {
            mode: pushResult.mode,
            failures: pushResult.failures?.length ?? 0,
        },
    };
}
