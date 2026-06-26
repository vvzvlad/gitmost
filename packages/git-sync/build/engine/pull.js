/**
 * Pull cycle — Docmost -> vault (SPEC §6 "Docmost -> ФС").
 *
 * This increment turns the read-only mirror into the git-backed pull cycle:
 *
 *   1. ensureRepo(vault); refuse if a merge is in progress (SPEC §9/§12);
 *      ensureBranch("docmost", "main")   (SPEC §5 branches)
 *   2. checkout docmost
 *   3. fetch the live tree (listSpaceTree -> {pages, complete}) -> compute the
 *      desired `live` files (relPath via the pure sanitize/disambiguation layout)
 *   4. parse `existing` tracked .md files (pageId + relPath from gitmost_id frontmatter)
 *   5. plan = planReconciliation(live, existing)   (pure, SPEC §5/§8); toDelete
 *      is absence-only, moves are separate
 *   6. decideAbsenceDeletions: SUPPRESS absence deletions on an incomplete tree
 *      fetch (SPEC §8) and behind the mass-delete guard (defense in depth)
 *   7. write each live page in its fixpoint form (normalize-on-write, SPEC §11);
 *      apply moved-old-path removals (only when the move write SUCCEEDED) and
 *      absence-delete removals (only when the decision allowed them)
 *   8. stageAll + commit on `docmost` with the provenance trailer (SPEC §7.3)
 *   9. checkout main + merge docmost (conflicts are surfaced, NOT auto-resolved,
 *      SPEC §9); push is deferred (SPEC §7)
 *  10. one-line summary
 *
 * DIRECTION IS Docmost -> vault ONLY. Nothing here ever writes to Docmost
 * (read-only: listSpaceTree + getPageJson). All git operations run against
 * the vault repo (`cwd = vaultPath`), never the source repo (see ./git.ts).
 *
 * The client seam is the native `GitSyncClient` (`Pick<GitSyncClient, ...>`);
 * the gitmost server drives the engine in-process (there is no standalone CLI
 * entry point).
 */
import { dirname } from "node:path";
import { sep } from "node:path";
import { parsePageFile, serializePageFile } from "../lib/page-file.js";
import { buildVaultLayout } from "./layout.js";
import { BOT_AUTHOR_NAME, BOT_AUTHOR_EMAIL, DEFAULT_BRANCH, } from "./git.js";
import { planReconciliation, decideAbsenceDeletions, } from "./reconcile.js";
import { stabilizePageBody } from "./stabilize.js";
// Engine-only mirror branch (SPEC §5): the engine writes here, humans never do.
const DOCMOST_BRANCH = "docmost";
// Machine-readable provenance the loop-guard keys on (SPEC §7.3 / §12).
const SOURCE_TRAILER = "Docmost-Sync-Source: docmost";
// Number of pages fetched/stabilized concurrently. Bounded so a large space
// does not open thousands of simultaneous requests/conversions at once.
const CONCURRENCY = 6;
// How often to log incremental progress (every N completed pages).
const PROGRESS_EVERY = 25;
/** Convert a vault-relative path (forward-slash) to an absolute FS path. */
function relToAbs(vaultRoot, relPath) {
    return [vaultRoot, ...relPath.split("/")].join("/");
}
/** Convert an absolute/relative segment list under the vault to a relPath. */
function segmentsToRelPath(segments, stem) {
    return [...segments, `${stem}.md`].join("/");
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
export async function readExisting(deps) {
    const tracked = await deps.listTracked();
    const existing = [];
    for (const relPath of tracked) {
        // git ls-files always emits forward-slash paths; normalize just in case.
        const rel = relPath.split(sep).join("/");
        let text;
        try {
            text = await deps.readFile(rel);
        }
        catch {
            // Tracked but missing on disk (mid-operation race) — skip; the next pull
            // converges.
            continue;
        }
        const { id } = parsePageFile(text);
        if (id)
            existing.push({ pageId: id, relPath: rel });
    }
    return existing;
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
export function computePullActions(input) {
    const { pages, treeComplete, existing } = input;
    const layout = buildVaultLayout(pages);
    const live = [];
    for (const p of pages) {
        if (!p || !p.id)
            continue;
        const entry = layout.get(p.id);
        if (!entry)
            continue;
        live.push({
            pageId: p.id,
            relPath: segmentsToRelPath(entry.segments, entry.stem),
        });
    }
    // Plan reconciliation (pure). `plan.toDelete` is ABSENCE-based only;
    // `plan.moved` carries move old-path removals separately.
    const plan = planReconciliation(live, existing);
    // Decide whether the ABSENCE-based deletions may be applied this cycle
    // (SPEC §8): incomplete-fetch suppression + empty-live + mass-delete guard.
    // Moves are NOT governed by this.
    const deletionDecision = decideAbsenceDeletions({
        treeComplete,
        liveCount: live.length,
        existingCount: existing.length,
        deleteCount: plan.toDelete.length,
    });
    return {
        toWrite: plan.toWrite,
        moved: plan.moved,
        // Fold the suppression in: a suppressed cycle deletes nothing.
        toDelete: deletionDecision.apply ? plan.toDelete : [],
        deletionDecision,
        existingCount: existing.length,
        plannedDeleteCount: plan.toDelete.length,
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
export async function applyPullActions(deps, actions, vaultRoot) {
    const { client, git } = deps;
    // Emit the SPEC §8 suppression warnings (preserved from the original `main`).
    const decision = actions.deletionDecision;
    if (!decision.apply) {
        if (decision.reason === "incomplete-fetch") {
            console.warn("pull: tree fetch incomplete — deletions suppressed this cycle (SPEC §8)");
        }
        else if (decision.reason === "empty-live") {
            console.warn(`pull: live fetch returned 0 pages but ${actions.existingCount} file(s) are ` +
                `tracked — deletions suppressed this cycle (SPEC §8). Re-run when ` +
                `Docmost is reachable.`);
        }
        else {
            console.warn(`pull: plan would delete ${actions.plannedDeleteCount} of ${actions.existingCount} ` +
                `tracked file(s) (mass-delete guard) — deletions suppressed this ` +
                `cycle (SPEC §8). Verify the live Docmost tree, then re-run.`);
        }
    }
    // 1. Write each live page in its fixpoint form (normalize-on-write, SPEC §11).
    let written = 0;
    let failed = 0;
    let completed = 0;
    let nextIndex = 0;
    // pageIds whose write FAILED. A moved page whose new-path write failed must
    // NOT have its old path removed (otherwise the page vanishes entirely).
    const failedPageIds = new Set();
    const writeOne = async (w) => {
        try {
            const page = await client.getPageJson(w.pageId);
            // Native-Obsidian format: a minimal `gitmost_id` frontmatter + the fixpoint
            // markdown body. title/parent/space are DERIVED (filename / folder / repo),
            // so nothing but the pageId is persisted as meta.
            const text = serializePageFile(page.id, await stabilizePageBody(page.content));
            const abs = relToAbs(vaultRoot, w.relPath);
            await deps.mkdir(dirname(abs));
            await deps.writeFile(abs, text);
            written++;
        }
        catch (err) {
            failed++;
            failedPageIds.add(w.pageId);
            console.error(`pull: failed page ${w.pageId}:`, err instanceof Error ? err.message : String(err));
        }
        finally {
            completed++;
            if (completed % PROGRESS_EVERY === 0) {
                console.log(`pulled ${completed}/${actions.toWrite.length}`);
            }
        }
    };
    // Bounded-concurrency pool (dependency-free): a fixed set of runners each
    // take the next index until the write list is exhausted. One bad page never
    // aborts the whole pull (mirrors the fault-tolerant tree walk).
    const runner = async () => {
        while (true) {
            const i = nextIndex++;
            if (i >= actions.toWrite.length)
                return;
            await writeOne(actions.toWrite[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, actions.toWrite.length) || 1 }, () => runner()));
    // Helper: `rm` with force:true is a no-op if the file is already gone.
    const removePath = async (rel, what) => {
        try {
            await deps.rm(relToAbs(vaultRoot, rel));
            return true;
        }
        catch (err) {
            console.error(`pull: failed to ${what} ${rel}:`, err instanceof Error ? err.message : String(err));
            return false;
        }
    };
    // 2. Apply MOVE old-path removals. A moved page IS present in `live`, so its
    //    old path is genuinely stale — NOT subject to the incomplete-fetch
    //    suppression. BUT only remove the old path when (a) the planner marked it
    //    removable (not reused by another live page) AND (b) the new-path write
    //    actually SUCCEEDED — otherwise we would delete the only copy of a page
    //    whose move-write failed (⭐ data-loss guard).
    let movedApplied = 0;
    for (const m of actions.moved) {
        if (!m.removeOldPath)
            continue;
        if (failedPageIds.has(m.pageId)) {
            console.warn(`pull: move write for ${m.pageId} failed — keeping old path ` +
                `${m.fromRelPath} (SPEC §8)`);
            continue;
        }
        if (await removePath(m.fromRelPath, "remove moved old path"))
            movedApplied++;
    }
    // 3. Apply ABSENCE-based deletions — `actions.toDelete` is ALREADY the
    //    post-suppression set (empty when the decision suppressed them, SPEC §8).
    let deleted = 0;
    for (const rel of actions.toDelete) {
        if (await removePath(rel, "delete"))
            deleted++;
    }
    // 4. Stage + commit on `docmost` (only if there is something to commit).
    //    Deterministic stabilized output means unchanged pages produce identical
    //    bytes -> git sees no diff -> no churn (SPEC §11). The subject reflects the
    //    ACTUAL work applied (pages written + files deleted), not the planned size,
    //    so a run with failures does not over-report (SPEC §5 nit).
    const subject = deleted > 0
        ? `docmost: sync ${written} page(s), ${deleted} deleted`
        : `docmost: sync ${written} page(s)`;
    await git.stageAll();
    const committed = await git.commit(subject, {
        authorName: BOT_AUTHOR_NAME,
        authorEmail: BOT_AUTHOR_EMAIL,
        trailers: [SOURCE_TRAILER],
    });
    // Merge docmost -> main. Conflicts are surfaced and left in git (SPEC §9);
    // we never push to Docmost. Push to a git remote is deferred (SPEC §7).
    await git.checkout(DEFAULT_BRANCH);
    const merge = await git.merge(DOCMOST_BRANCH);
    if (merge.conflict) {
        console.error("pull: merge of docmost -> main CONFLICTED. Conflict markers were left " +
            "in the vault for manual resolution (SPEC §9). Nothing is pushed to " +
            "Docmost (read-only). Resolve locally, then re-run.");
    }
    else if (!merge.ok) {
        console.error(`pull: merge of docmost -> main failed: ${merge.output}`);
    }
    console.log("pull: git push to remote is DEFERRED in this increment (SPEC §7).");
    return { written, movedApplied, deleted, failed, committed, merge };
}
