import { parsePageFile, serializePageFile } from "../lib/page-file.js";
import { DEFAULT_BRANCH } from "./git.js";
import { bodyHash } from "./loop-guard.js";
/**
 * PURE classifier for the `renamesMoves` produced by `computePushActions`
 * (push #3, SPEC §5/§6/§8). Resolves each `{pageId, oldPath, newPath}` into the
 * Docmost op(s) it needs, with NO IO (both resolvers are injected).
 *
 * SPEC §5 — the file PATH is the source of truth for tree position, NOT the
 * (possibly stale) `meta.parentPageId`. So the NEW parent is resolved from
 * `newPath`'s enclosing folder, and the OLD parent from `oldPath`'s enclosing
 * folder, via `deps.resolveParentPageId`. The title comes from the meta.
 *
 * For each entry:
 *   - `newParent = resolveParentPageId(newPath, 'current')`,
 *     `oldParent = resolveParentPageId(oldPath, 'prev')`.
 *   - `newTitle = metaAt(newPath,'current')?.title`,
 *     `oldTitle = metaAt(oldPath,'prev')?.title`.
 *   - include `move` iff `newParent !== oldParent` (a real reparent),
 *   - include `rename` iff `newTitle` is a NON-EMPTY string AND differs from
 *     `oldTitle` (a real title edit; an empty/absent new title is never a rename),
 *   - if NEITHER applies -> `noop: true` (a cosmetic local-only file-path rename;
 *     the page is its pageId, so Docmost is not touched).
 */
export function classifyRenameMoves(renamesMoves, deps) {
    return renamesMoves.map((rm) => {
        const newParent = deps.resolveParentPageId(rm.newPath, "current");
        const oldParent = deps.resolveParentPageId(rm.oldPath, "prev");
        const newTitle = deps.metaAt(rm.newPath, "current")?.title;
        const oldTitle = deps.metaAt(rm.oldPath, "prev")?.title;
        const out = {
            pageId: rm.pageId,
            oldPath: rm.oldPath,
            newPath: rm.newPath,
        };
        // A reparent: the new path's resolved parent page differs from the old's.
        if (newParent !== oldParent) {
            out.move = { parentPageId: newParent };
        }
        // A title edit: only when there is a real, non-empty new title that changed.
        if (typeof newTitle === "string" &&
            newTitle.length > 0 &&
            newTitle !== oldTitle) {
            out.rename = { title: newTitle };
        }
        // Neither changed -> a purely LOCAL file-path rename; do NOT call Docmost.
        if (!out.move && !out.rename) {
            out.noop = true;
        }
        return out;
    });
}
/**
 * PURE push planner (SPEC §4/§6/§8). Classifies each diff row into a Docmost
 * action by `pageId` identity, with NO IO (the `metaAt` resolver is injected).
 *
 * Classification rules:
 *   - `A` (added):
 *       - current meta HAS a pageId  -> UPDATE (a restored/copied file whose
 *         page already exists; we push its content rather than create a dup).
 *       - current meta has NO pageId but HAS a non-empty spaceId -> CREATE (a
 *         brand-new local file; the page does not exist in Docmost yet).
 *       - current meta has NO pageId and NO usable spaceId -> SKIP with reason
 *         `create-without-spaceId`: Docmost `create_page` REQUIRES a spaceId
 *         (§16), and a new local file may carry only partial human meta. We
 *         refuse to create rather than guess a space (SPEC §8 guard spirit).
 *   - `M` (modified): current meta has a pageId -> UPDATE content. (If a modified
 *       file somehow lost its pageId it is skipped — there is nothing to target.)
 *   - `D` (deleted): recover the pageId from the PRE-IMAGE meta (`metaAt(path,
 *       'prev')`) -> DELETE. If no pageId can be recovered, SKIP with a reason
 *       (untracked-file guard, SPEC §8: never delete an untracked page).
 *   - `R` (renamed/moved): same pageId (from current meta), path changed ->
 *       RENAME/MOVE. Resolution of move-vs-rename + the new parentPageId is
 *       DEFERRED to the next increment; here we only record oldPath/newPath/
 *       pageId. If the renamed file has no recoverable pageId it is SKIPPED.
 *       (`C` copy is treated the same as `R` for recording purposes.)
 */
export function computePushActions(input) {
    const { metaAt, currentPageIds } = input;
    // PAGE-FILE FILTER (design §"Адопция"): only `.md` files OUTSIDE any dot-folder
    // are Docmost pages. `.obsidian/*`, attachments, and other non-page files are
    // committed to the vault (no `.gitignore`) and so appear in the diff, but they
    // are NEVER pages — Obsidian owns them. Without this filter every ADDED such
    // file would be mis-classified as a CREATE (nativeMeta always supplies a
    // spaceId, so the old `create-without-spaceId` skip no longer screens them),
    // creating junk pages in Docmost and corrupting the file with a `gitmost_id`
    // frontmatter. Filter BEFORE any classification so non-page A/M/D/R are ignored.
    const changes = input.changes.filter((c) => isPageFile(c.path));
    const actions = {
        creates: [],
        updates: [],
        deletes: [],
        renamesMoves: [],
        skipped: [],
    };
    // GHOST-MOVE coalescing (⭐ data-loss guard). git's rename detection (`-M`)
    // can miss a move when the two files are too dissimilar — which is exactly the
    // case for the tiny meta-only files a layout RESHUFFLE produces (e.g.
    // several untitled pages sharing the `_` fallback name; retitling one frees the
    // bare `_` and another page's file relocates `_ ~slug.md` -> `_.md`). git then
    // reports the move as a DELETE of the old path + an ADD of the new one. Taken
    // literally that soft-deletes a page that merely MOVED — a live page vanishing
    // into Trash. Identity is the pageId, not git's heuristic: a pageId that is
    // BOTH deleted (pre-image) and added (current) is one page that relocated, so
    // we classify it as a rename/move and NEVER as a delete.
    // A pageId can land at its new path two ways: as an ADD (the path was free) or
    // as a MODIFY (the path was occupied by ANOTHER page that left — the reshuffle
    // case, where `_.md`'s occupant changes pageId). Both are "the page survives at
    // a new path", so the surviving side is the CURRENT-meta pageId of A *and* M.
    const deletedPath = new Map();
    const survivingPath = new Map();
    for (const change of changes) {
        if (change.status === "D") {
            const pid = metaAt(change.path, "prev")?.pageId;
            if (pid)
                deletedPath.set(pid, change.path);
        }
        else if (change.status === "A" || change.status === "M") {
            const pid = metaAt(change.path, "current")?.pageId;
            if (pid)
                survivingPath.set(pid, change.path);
        }
    }
    const ghostMove = new Map();
    for (const [pid, oldPath] of deletedPath) {
        const newPath = survivingPath.get(pid);
        if (newPath && newPath !== oldPath) {
            ghostMove.set(pid, { oldPath, newPath });
        }
    }
    for (const change of changes) {
        switch (change.status) {
            case "A": {
                const meta = metaAt(change.path, "current");
                const pageId = meta?.pageId;
                if (pageId && ghostMove.has(pageId)) {
                    // Half of a git-undetected move (a matching DELETE exists): record it
                    // as a rename/move (like a real `R`), NOT an update — the `D` side is
                    // suppressed so the page is never soft-deleted.
                    actions.renamesMoves.push({
                        pageId,
                        oldPath: ghostMove.get(pageId).oldPath,
                        newPath: change.path,
                    });
                }
                else if (pageId) {
                    // Added but already carries a pageId (restored/copied file): the page
                    // exists in Docmost, so push content as an UPDATE — never a duplicate.
                    actions.updates.push({ pageId, path: change.path });
                }
                else if (meta?.spaceId) {
                    // Brand-new local file with a target space -> create the page, then
                    // write the assigned pageId back into its meta (in `applyPushActions`).
                    // `meta.spaceId` is truthy here, so empty-string is also rejected.
                    actions.creates.push({ path: change.path });
                }
                else {
                    // A create needs a spaceId (Docmost `create_page` requires it, §16). A
                    // new file with partial meta and no usable spaceId is SKIPPED rather
                    // than created into a guessed space (SPEC §8 guard spirit).
                    actions.skipped.push({
                        path: change.path,
                        status: "A",
                        reason: "create-without-spaceId",
                    });
                }
                break;
            }
            case "M": {
                const meta = metaAt(change.path, "current");
                const pageId = meta?.pageId;
                if (pageId && ghostMove.has(pageId)) {
                    // This path's occupant changed pageId: the previous page left and THIS
                    // page relocated here (a reshuffle). Its old file was DELETED elsewhere
                    // — coalesce into a rename/move so the page is never trashed.
                    actions.renamesMoves.push({
                        pageId,
                        oldPath: ghostMove.get(pageId).oldPath,
                        newPath: change.path,
                    });
                }
                else if (pageId) {
                    actions.updates.push({ pageId, path: change.path });
                }
                else {
                    // A modified file with no pageId has no Docmost target to update.
                    actions.skipped.push({
                        path: change.path,
                        status: "M",
                        reason: "modified file has no pageId in meta",
                    });
                }
                break;
            }
            case "D": {
                // The file is gone from `main`; recover its pageId from the PRE-IMAGE
                // (the version last pushed to Docmost) so we delete the RIGHT page.
                const prevMeta = metaAt(change.path, "prev");
                const pageId = prevMeta?.pageId;
                if (pageId && ghostMove.has(pageId)) {
                    // The same pageId was re-ADDED at a new path: this is a git-undetected
                    // MOVE, handled by the `A` branch above. Suppress the delete so a moved
                    // page is never trashed (⭐ data-loss guard).
                    actions.skipped.push({
                        path: change.path,
                        status: "D",
                        reason: "ghost-move (re-added at a new path) — not a deletion",
                    });
                }
                else if (pageId && currentPageIds?.has(pageId)) {
                    // The pageId still EXISTS elsewhere in the current tree: the file moved
                    // (a layout reshuffle whose matching add was in an earlier cycle, so it
                    // is not in this diff). A live page must never be trashed because its
                    // FILENAME changed — identity is the pageId (⭐ data-loss guard).
                    actions.skipped.push({
                        path: change.path,
                        status: "D",
                        reason: "pageId still present in the tree (moved) — not a deletion",
                    });
                }
                else if (pageId) {
                    actions.deletes.push({ pageId });
                }
                else {
                    // Untracked-file guard (SPEC §8): a file with no recoverable pageId was
                    // never a Docmost page — do NOT translate its removal into a delete.
                    actions.skipped.push({
                        path: change.path,
                        status: "D",
                        reason: "deleted file has no recoverable pageId (pre-image meta)",
                    });
                }
                break;
            }
            case "R":
            case "C": {
                // Same page, new path. Identity comes from the CURRENT (post-rename) meta
                // since the file still exists. RESOLUTION (move vs rename, parentPageId)
                // is deferred — record oldPath/newPath/pageId only.
                const meta = metaAt(change.path, "current");
                const pageId = meta?.pageId;
                const oldPath = change.oldPath ?? change.path;
                if (pageId) {
                    actions.renamesMoves.push({
                        pageId,
                        oldPath,
                        newPath: change.path,
                    });
                }
                else {
                    actions.skipped.push({
                        path: change.path,
                        status: change.status,
                        reason: "renamed/moved file has no pageId in meta",
                    });
                }
                break;
            }
            default: {
                // Unreachable for A/M/D/R/C; defensive for any future status.
                actions.skipped.push({
                    path: change.path,
                    status: change.status,
                    reason: `unhandled diff status ${change.status}`,
                });
            }
        }
    }
    return actions;
}
// --- thin apply (create/update/delete), fakes-only in this increment ---------
/** The marker the push direction advances after a successful push (SPEC §5/§6). */
export const LAST_PUSHED_REF = "refs/docmost/last-pushed";
/**
 * The mirror branch fast-forwarded after a clean push (SPEC §5/§6 step 3). It
 * reflects "what Docmost currently contains"; advancing it to the pushed `main`
 * commit closes the loop so the next pull diffs empty for the pushed pages.
 */
export const DOCMOST_BRANCH = "docmost";
/**
 * THIN IO applier for the COMMON push cases (create/update/delete). Exercised
 * via FAKES only in this increment — there is no live wiring.
 *
 *   - UPDATE: read the file body, then `client.importPageMarkdown(pageId, body)`.
 *     This is the collab/Yjs write path (SPEC §2/§15.6) — NEVER a raw jsonb
 *     overwrite. The full self-contained markdown (meta + body) is sent as-is;
 *     `importPageMarkdown` parses the meta/body itself.
 *   - CREATE: derive title/spaceId/parentPageId from the file's current meta,
 *     `client.createPage(...)`, take the assigned pageId from the result, and
 *     write it BACK as the file's `gitmost_id` frontmatter (re-serialized via
 *     `serializePageFile`, body preserved) so the file becomes
 *     tracked. The write-back is recorded in `writtenBack` (a follow-up commit
 *     is needed — NEXT increment).
 *   - DELETE: `client.deletePage(pageId)` — soft-delete to Trash (SPEC §8).
 *   - RENAME/MOVE (push #3, SPEC §5/§6/§16): classify each `renamesMoves` entry
 *     with `classifyRenameMoves` (resolvers read the parent FOLDER's `.md` for
 *     the parent pageId — path-as-truth — and the meta for the title), then:
 *       - `move`   -> `client.movePage(pageId, parentPageId, position?)` (reparent;
 *         `position` is UNDEFINED for now — the client supplies a default),
 *       - `rename` -> `client.renamePage(pageId, title)` (title-only),
 *       - BOTH     -> move (reparent) THEN rename (title), in that order,
 *       - `noop`   -> NO client call; recorded in `noops` (a cosmetic local-only
 *         file-path rename: the page is its pageId, the path is local, SPEC §5).
 *
 * FAIL-SAFE / per-page isolation (SPEC §12 resumability). Each page's operation
 * is wrapped in its own try/catch: a single failing page is recorded in
 * `failures[]` (with its kind + pageId/path + error) and the batch CONTINUES —
 * one bad page must never block the rest. Crucially, the refs are advanced ONLY
 * when `failures.length === 0`: a PARTIAL push must NOT advance
 * `refs/docmost/last-pushed` or the `docmost` mirror, so a re-run retries the
 * whole batch cleanly (the already-applied pages are idempotent re-applies).
 *
 * LOOP-CLOSE (SPEC §6 step 3 / §10). After a fully-successful push, when a
 * `pushedCommit` is supplied:
 *   - advance `refs/docmost/last-pushed` to it (what of `main` is in Docmost), AND
 *   - fast-forward the `docmost` mirror branch to it via
 *     `git.fastForwardBranch('docmost', pushedCommit)` — so the mirror reflects
 *     what Docmost now contains and the NEXT pull diffs EMPTY for these pages
 *     (it does not re-pull our own write). The ff is REFUSED (not forced) if
 *     `docmost` is not an ancestor of the pushed commit; the result is surfaced
 *     in `docmostFastForward`. On ANY failure, NEITHER ref is advanced.
 *
 * LOOP-GUARD DATA (SPEC §10). For every page successfully updated/created the
 * result carries a `pushed` record `{ pageId, updatedAt?, bodyHash }` — the body
 * hash of what was pushed plus the write's `updatedAt` (when the client returned
 * one). A future pull-side poll-suppression consults this so it does not re-pull
 * our own write; producing it is in scope here, consuming it is deferred.
 *
 * @param pushedCommit The `main` commit just reflected into Docmost (SHA or
 *   commit-ish). When omitted, NEITHER ref is advanced (e.g. a dry plan).
 */
export async function applyPushActions(deps, actions, pushedCommit) {
    const { client, git } = deps;
    let created = 0;
    let updated = 0;
    let deleted = 0;
    let moved = 0;
    let renamed = 0;
    const writtenBack = [];
    const pushed = [];
    const failures = [];
    const noops = [];
    // 1. UPDATES — collab/Yjs write path (SPEC §2/§15.6), never a raw overwrite.
    //    Each update is isolated: a thrown page is recorded and the batch goes on.
    for (const u of actions.updates) {
        try {
            // Push the CLEAN body only (no `gitmost_id` frontmatter): the frontmatter
            // is engine metadata, never page content. The server converts the markdown
            // it receives verbatim, so stripping here keeps the id out of Docmost.
            const body = parsePageFile(await deps.readFile(u.path)).body;
            // The last-synced version of this file (pre-image) is the common ancestor
            // for a 3-way merge against the live page, so concurrent human edits are
            // not clobbered (review #5). Null when the file is new at last-pushed. Its
            // body is stripped the SAME way so the merge compares body-to-body.
            const baseFull = await deps.git.showFileAtRef(LAST_PUSHED_REF, u.path);
            const baseMarkdown = baseFull === null ? null : parsePageFile(baseFull).body;
            const result = await client.importPageMarkdown(u.pageId, body, baseMarkdown);
            updated++;
            // §10 loop-guard data: hash the BODY we pushed + capture `updatedAt`.
            pushed.push({
                pageId: u.pageId,
                ...extractUpdatedAt(result),
                bodyHash: bodyHash(body),
            });
        }
        catch (err) {
            failures.push({
                kind: "update",
                pageId: u.pageId,
                path: u.path,
                error: errMessage(err),
            });
        }
    }
    // 2. CREATES — create the page, then write the assigned pageId back to meta so
    //    the file becomes tracked (SPEC §4 "записать присвоенный pageId обратно").
    //    Isolated per page like updates.
    for (const c of actions.creates) {
        try {
            const text = await deps.readFile(c.path);
            const { body } = parsePageFile(text);
            // Derive create args from the PATH (native-Obsidian, SPEC §5): title from
            // the filename, parent from the enclosing folder's folder-note, space from
            // the run (the vault's space). `parentPageId: null` -> created at ROOT.
            const title = titleFromPath(c.path);
            const parentPageId = (await resolveParentPageIdViaTree(deps, c.path, "current")) ?? undefined;
            const result = await client.createPage(title, body, deps.spaceId, parentPageId);
            // `createPage` returns `{ data: { id, ... }, success }`; the assigned
            // pageId is at `result.data.id`.
            const assignedPageId = result?.data?.id;
            if (assignedPageId) {
                // Write the assigned pageId back as the `gitmost_id` frontmatter, body
                // preserved — the file becomes engine-tracked (SPEC §4).
                const rewritten = serializePageFile(assignedPageId, body);
                await deps.writeFile(c.path, rewritten);
                writtenBack.push({ path: c.path, pageId: assignedPageId });
                // §10 loop-guard data for the created page (hash the pushed BODY).
                pushed.push({
                    pageId: assignedPageId,
                    ...extractUpdatedAt(result),
                    bodyHash: bodyHash(body),
                });
            }
            created++;
        }
        catch (err) {
            failures.push({ kind: "create", path: c.path, error: errMessage(err) });
        }
    }
    // 3. DELETES — soft-delete to Trash (SPEC §8), reversible. Isolated per page.
    for (const d of actions.deletes) {
        try {
            await client.deletePage(d.pageId);
            deleted++;
        }
        catch (err) {
            failures.push({
                kind: "delete",
                pageId: d.pageId,
                error: errMessage(err),
            });
        }
    }
    // 4. RENAME/MOVE (push #3, SPEC §5/§6/§16). Classify each entry against the
    //    tree-backed resolvers (the NEW parent comes from the new path's enclosing
    //    folder `.md`, the OLD parent from the old path's at last-pushed — PATH is
    //    the truth, not stale `meta.parentPageId`; the title from the meta), then
    //    apply only the real ops. Each page is isolated like the cases above: a
    //    thrown op is recorded in `failures` and the batch continues. ORDER for a
    //    page that needs both: reparent (move) FIRST, then retitle (rename).
    if (actions.renamesMoves.length > 0) {
        // The classifier is PURE over sync resolvers; the tree reads are async, so
        // prefetch every (path, side) lookup it will make into plain tables first.
        const parentTable = new Map();
        const metaTable = new Map();
        // A tree read (readFile / git.showFileAtRef) throwing must isolate THAT page
        // into `failures`, NOT abort the whole batch (§12 resumability). The helpers
        // already swallow their own errors, but this per-entry try/catch keeps the
        // batch-isolation invariant holding regardless of future changes to them.
        const prefetchFailed = new Set();
        for (const rm of actions.renamesMoves) {
            // newParent + newTitle from the CURRENT tree; oldParent + oldTitle from the
            // last-pushed pre-image (`prev`). Keyed by `path|side` so duplicates fold.
            try {
                parentTable.set(`${rm.newPath}|current`, await resolveParentPageIdViaTree(deps, rm.newPath, "current"));
                parentTable.set(`${rm.oldPath}|prev`, await resolveParentPageIdViaTree(deps, rm.oldPath, "prev"));
                metaTable.set(`${rm.newPath}|current`, await metaAtViaTree(deps, rm.newPath, "current", deps.spaceId));
                metaTable.set(`${rm.oldPath}|prev`, await metaAtViaTree(deps, rm.oldPath, "prev", deps.spaceId));
            }
            catch (err) {
                prefetchFailed.add(rm.pageId);
                failures.push({
                    kind: "move",
                    pageId: rm.pageId,
                    path: rm.newPath,
                    error: errMessage(err),
                });
            }
        }
        const classified = classifyRenameMoves(actions.renamesMoves.filter((rm) => !prefetchFailed.has(rm.pageId)), {
            metaAt: (path, side) => metaTable.get(`${path}|${side}`) ?? null,
            resolveParentPageId: (path, side) => parentTable.get(`${path}|${side}`) ?? null,
        });
        for (const c of classified) {
            if (c.noop) {
                // Cosmetic local-only file-path rename — no Docmost op (SPEC §5).
                noops.push({
                    pageId: c.pageId,
                    oldPath: c.oldPath,
                    newPath: c.newPath,
                    reason: "path-only-rename",
                });
                continue;
            }
            // Track which op is in flight so a failure is attributed to the op that
            // ACTUALLY threw: for a page needing both, a move that succeeds then a
            // rename that throws must be recorded as `rename`, not `move`.
            let failingKind = c.move ? "move" : "rename";
            try {
                // Reparent FIRST so the page is in its new tree position, THEN retitle.
                if (c.move) {
                    failingKind = "move";
                    // TODO(next): compute a fractional-index position between siblings
                    // (SPEC §16). `position` is UNDEFINED here; the client supplies a valid
                    // default. Pass `parentPageId: null` for a move to the space ROOT.
                    await client.movePage(c.pageId, c.move.parentPageId);
                    moved++;
                }
                if (c.rename) {
                    failingKind = "rename";
                    await client.renamePage(c.pageId, c.rename.title);
                    renamed++;
                }
            }
            catch (err) {
                // Isolate the failed page: the op that ACTUALLY threw is recorded so a
                // re-run can retry. A move that threw before its rename leaves `rename`
                // for the next run (idempotent re-apply); refs are NOT advanced (below).
                failures.push({
                    kind: failingKind,
                    pageId: c.pageId,
                    path: c.newPath,
                    error: errMessage(err),
                });
            }
        }
    }
    // 5. Advance the refs ONLY on a CLEAN push (no failures) AND when a pushed
    //    commit is supplied. A partial push must advance NEITHER ref, so a re-run
    //    retries the whole batch (SPEC §12). The loop-close (SPEC §6 step 3 / §10):
    //    advance `refs/docmost/last-pushed` AND fast-forward the `docmost` mirror,
    //    so Docmost's new content is mirrored and the next pull diffs empty.
    let lastPushedAdvanced = false;
    let docmostFastForward = null;
    if (pushedCommit && failures.length === 0) {
        await git.updateRef(LAST_PUSHED_REF, pushedCommit);
        lastPushedAdvanced = true;
        // Fast-forward the mirror (refused, not forced, on a non-fast-forward — the
        // caller logs the reason). Surfaced in the result.
        docmostFastForward = await git.fastForwardBranch(DOCMOST_BRANCH, pushedCommit);
    }
    return {
        created,
        updated,
        deleted,
        moved,
        renamed,
        writtenBack,
        pushed,
        failures,
        noops,
        skipped: actions.skipped,
        lastPushedAdvanced,
        docmostFastForward,
    };
}
/** Stringify a thrown value into a stable error message. */
function errMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/**
 * SPEC §5 path-as-truth: the parent FOLDER's `.md` file for a vault-relative
 * (forward-slash) path. `buildVaultLayout` puts a page with children at
 * `<...>/Title.md` and nests its children under `<...>/Title/`, so for
 * `newPath = <dir>/Child.md` the parent page's file is `<dir>.md` (the enclosing
 * folder, one level up). A path with NO enclosing folder (`Child.md`, at the
 * space root) has no parent folder file -> `null` (the parent is ROOT).
 */
export function parentFolderFile(path) {
    const slash = path.lastIndexOf("/");
    if (slash < 0)
        return null; // root-level file: parent is ROOT.
    const dir = path.slice(0, slash); // the enclosing folder
    // The page that OWNS the enclosing folder is its folder-note `<dir>/<base>.md`.
    const folderNote = `${dir}/${baseSegment(dir)}.md`;
    if (path === folderNote) {
        // This path IS its folder's folder-note, so its parent is ONE LEVEL UP: the
        // folder-note of the grandparent folder (or ROOT at the top level).
        const up = dir.lastIndexOf("/");
        if (up < 0)
            return null; // top-level folder -> parent is ROOT.
        const grandDir = dir.slice(0, up);
        return `${grandDir}/${baseSegment(grandDir)}.md`;
    }
    // A leaf (or a nested folder-note) sitting inside `dir`: its parent is `dir`'s
    // folder-note.
    return folderNote;
}
/**
 * Whether a vault path is a Docmost PAGE file (design §"Адопция"): a `.md` file
 * with NO dot-segment anywhere in its path. This excludes `.obsidian/` config,
 * `.trash/`, dotfiles (`.foo.md`), and every non-`.md` file (attachments, JSON,
 * …) — Obsidian owns those; they live in the vault but are never pages. Used to
 * screen the PUSH diff so non-page files are never created/updated/deleted in
 * Docmost (and never get a `gitmost_id` frontmatter written into them).
 */
export function isPageFile(path) {
    if (!path.endsWith(".md"))
        return false;
    return !path.split("/").some((seg) => seg.startsWith("."));
}
/** The last path segment of a forward-slash path (the folder/file base name). */
function baseSegment(path) {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? path : path.slice(slash + 1);
}
/**
 * The page TITLE derived from a vault path: the file's base name without the
 * `.md` extension. In the native-Obsidian layout the filename IS the title — for
 * a folder-note `<dir>/<base>.md` that base equals the folder name, so the same
 * rule yields the folder's title. Self-consistent across pull/push: a pulled
 * (possibly disambiguated) filename round-trips to the same title, so a stable
 * file never pushes a spurious rename.
 */
function titleFromPath(path) {
    const base = baseSegment(path);
    return base.endsWith(".md") ? base.slice(0, -3) : base;
}
/**
 * Build the synthetic `DocmostMdMeta` the planner/classifier consume, from the
 * NATIVE format: `pageId` from the `gitmost_id` frontmatter, `title` from the
 * filename, `spaceId` from the run (the vault's space — every file belongs to
 * it). `parentPageId` is intentionally absent: tree position is resolved from the
 * PATH (`resolveParentPageId`), never from a stored field (SPEC §5).
 */
function nativeMeta(text, path, spaceId) {
    const { id } = parsePageFile(text);
    const meta = { version: 1, title: titleFromPath(path), spaceId };
    if (id)
        meta.pageId = id;
    return meta;
}
/**
 * Build the `resolveParentPageId(path, side)` resolver `classifyRenameMoves`
 * needs, reading the PARENT FOLDER's `.md` (SPEC §5 path-as-truth):
 *   - `current` -> `deps.readFile(<dir>.md)` (the live working tree),
 *   - `prev`    -> `git.showFileAtRef('refs/docmost/last-pushed', <dir>.md)` (the
 *     last-pushed pre-image),
 * then read its `gitmost_id` frontmatter and return that page's pageId. A root-level path
 * (no enclosing folder), a missing/unreadable parent file, or a parent file with
 * no parseable pageId all resolve to `null` (parent is ROOT / unknown ->
 * `parentPageId: null`, SPEC §16 "parentPageId: null -> в корень").
 *
 * The IO is async, so this returns an ASYNC resolver; the call sites prefetch the
 * parent pageIds (the classifier itself stays pure/sync over a plain table).
 */
async function resolveParentPageIdViaTree(deps, path, side) {
    const parentFile = parentFolderFile(path);
    if (parentFile === null)
        return null; // root-level: parent is ROOT.
    let text;
    try {
        text =
            side === "current"
                ? await deps.readFile(parentFile)
                : await deps.git.showFileAtRef(LAST_PUSHED_REF, parentFile);
    }
    catch {
        // Parent folder file missing/unreadable at that side -> treat as ROOT.
        return null;
    }
    if (text === null)
        return null; // showFileAtRef returns null when absent.
    // The parent page's identity is its `gitmost_id` frontmatter; folder position
    // is irrelevant here, only the pageId.
    return parsePageFile(text).id;
}
/**
 * Resolve the synthetic native meta at a side for the rename/move classifier (the
 * title — derived from the path — comes from here). Mirrors
 * `resolveParentPageIdViaTree`'s IO sides: `current` reads the working tree,
 * `prev` reads `refs/docmost/last-pushed`. Returns `null` only when the file is
 * missing/unreadable at that side (a real absence the classifier must see).
 */
async function metaAtViaTree(deps, path, side, spaceId) {
    let text;
    try {
        text =
            side === "current"
                ? await deps.readFile(path)
                : await deps.git.showFileAtRef(LAST_PUSHED_REF, path);
    }
    catch {
        return null;
    }
    if (text === null)
        return null;
    return nativeMeta(text, path, spaceId);
}
/**
 * Pull an `updatedAt` out of a create/update client result, if present. The
 * shape is `{ data: { updatedAt? }, ... }` (createPage) or a flatter object;
 * absent in the simple fakes, so the field is omitted rather than `undefined`.
 */
function extractUpdatedAt(result) {
    const r = result;
    const raw = r?.data?.updatedAt ?? r?.updatedAt;
    return typeof raw === "string" ? { updatedAt: raw } : {};
}
// --- runnable push orchestration (`runPush`) ---------------------------------
//
// `runPush` is the FS->Docmost twin of `pull.ts`'s `main`: it wires the VaultGit
// diff/ref primitives + the PURE `computePushActions` planner + the THIN
// `applyPushActions` applier into one runnable cycle. SAFE BY DEFAULT — the
// engine's FIRST write path to Docmost defaults to DRY-RUN (plan only, NO
// Docmost writes, NO ref advance); an explicit `--apply` is the ONLY path that
// builds a client and mutates Docmost.
//
// Every external effect is injected (`PushDeps`) so the whole orchestration is
// driven by FAKES in tests — no live Docmost, git, fs, or network.
/**
 * The human ("local") git identity used for engine-made commits on `main` in the
 * push direction (SPEC §7.3). The provenance is carried by the trailer (below),
 * which the loop-guard keys on; the identity is for history readability only.
 * When the vault repo already has a configured `user.name`/`user.email`, git
 * uses that for the working-tree commit; this is the fallback the daemon stamps.
 */
export const LOCAL_AUTHOR_NAME = "Local";
export const LOCAL_AUTHOR_EMAIL = "local@local";
/** The provenance trailer marking a `main`-side (human/local) commit (SPEC §7.3). */
export const LOCAL_SOURCE_TRAILER = "Docmost-Sync-Source: local";
/**
 * Run one FS->Docmost push cycle (SPEC §6 "ФС → Docmost"), DRY-RUN BY DEFAULT.
 *
 * Steps (mirrors `pull.ts`):
 *   1. Preflight git: `assertGitAvailable` + `ensureRepo`; ABORT (clear message +
 *      non-zero-ish result) if a merge is in progress — never push on top of an
 *      unresolved conflict (SPEC §9/§12). Conflict markers must NEVER reach
 *      Docmost (SPEC §9).
 *   2. Checkout `main` (the human-facing branch the push reads from).
 *   3. Commit the human's pending working-tree changes on `main` with the
 *      `local` provenance trailer (SPEC §7.3). A no-op when nothing changed.
 *   4. Pick the diff BASE: `refs/docmost/last-pushed` if it resolves, else the
 *      `docmost` mirror branch (what Docmost currently has). Resolve `main`.
 *   5. `diffNameStatus(base, main)` -> changes; build the `metaAt(path, side)`
 *      resolver (current = working tree, prev = `git show <base>:<path>`); run
 *      the PURE `computePushActions`.
 *   6. DRY-RUN (default): LOG the full plan and RETURN — NO client, NO Docmost
 *      calls, NO ref advance.
 *   7. `--apply`: build the client, run `applyPushActions(..., pushedCommit=main)`,
 *      then (a) if any pageIds were written back (creates), commit them on `main`
 *      with the `local` trailer and RE-advance `refs/docmost/last-pushed` to the
 *      new commit so the recorded pageIds are persisted in what Docmost mirrors;
 *      (b) ESCALATE a divergent-`docmost` ff refusal (SPEC §5) with a prominent
 *      WARNING and a non-zero-ish flag. Then log a one-line summary.
 */
export async function runPush(deps, opts) {
    const { git, settings, log } = deps;
    const dryRun = opts.dryRun;
    // 1. Preflight git. Fail fast (actionable message via main().catch) if the git
    //    binary is missing — the vault state store relies on it.
    await git.assertGitAvailable();
    await git.ensureRepo();
    // 1b. Refuse to push on top of an unresolved merge (SPEC §9/§12). A previous
    //     conflicting pull leaves the vault mid-merge; pushing now could leak
    //     conflict markers into Docmost (SPEC §9, the cardinal invariant). Detect
    //     it BEFORE any checkout/diff and stop with a clear, actionable message so
    //     re-runs converge once the human resolves (or aborts) the merge.
    if (await git.isMergeInProgress()) {
        log(`push: vault has an unresolved merge at ${settings.vaultPath} — resolve ` +
            `it (or 'git merge --abort') and re-run. Nothing was pushed to Docmost ` +
            `(conflict markers must never reach Docmost, SPEC §9).`);
        return { mode: dryRun ? "dry-run" : "apply", aborted: "merge-in-progress" };
    }
    // 2. Work on `main` — the human-facing branch the push diffs FROM.
    await git.checkout(DEFAULT_BRANCH);
    // 3. Commit the human's pending working-tree changes on `main` with the `local`
    //    provenance trailer (SPEC §7.3). A no-op commit when nothing changed is
    //    fine (`commit` returns false). The loop-guard keys on the trailer.
    //    Even on a "plan only" dry-run this commits the working tree (it is the
    //    only way to diff `base..main`, acceptable §6.1 behavior) — so make that
    //    LOCAL git mutation VISIBLE, never silent: a created commit is local-only
    //    and nothing is sent to Docmost.
    await git.stageAll();
    const committedWorkingTree = await git.commit("local: working-tree changes", {
        authorName: LOCAL_AUTHOR_NAME,
        authorEmail: LOCAL_AUTHOR_EMAIL,
        trailers: [LOCAL_SOURCE_TRAILER],
    });
    if (committedWorkingTree) {
        const sha = await git.revParse(DEFAULT_BRANCH);
        log(`push: committed local working-tree changes on main` +
            (sha ? ` as ${sha.slice(0, 8)}` : "") +
            ` (local git only — nothing sent to Docmost).`);
    }
    else {
        log("push: working tree clean (no local changes to push).");
    }
    // 4. Pick the diff BASE (SPEC §5/§6): `refs/docmost/last-pushed` if it resolves
    //    (the marker of what `main` is already in Docmost), else fall back to the
    //    `docmost` mirror branch (the mirror of what Docmost currently has) — which
    //    is what exists before the first push ever advanced last-pushed.
    let base;
    const lastPushedSha = await git.readRef(LAST_PUSHED_REF);
    if (lastPushedSha) {
        base = { ref: LAST_PUSHED_REF, source: "last-pushed", sha: lastPushedSha };
    }
    else {
        base = {
            ref: DOCMOST_BRANCH,
            source: "docmost",
            sha: await git.revParse(DOCMOST_BRANCH),
        };
    }
    const pushedCommit = await git.revParse(DEFAULT_BRANCH);
    if (!pushedCommit) {
        // `main` has no commit — `ensureRepo` always makes an initial one, so this is
        // defensive. Nothing to diff.
        log("push: `main` has no commit to push — nothing to do.");
        return { mode: dryRun ? "dry-run" : "apply", base };
    }
    // 5. Diff the base against `main` and build the `metaAt` resolver (PURE planner
    //    input). `current` reads the live working tree; `prev` reads the base ref's
    //    pre-image via `git show <base>:<path>` (so a DELETE recovers its pageId).
    const changes = await git.diffNameStatus(base.ref, DEFAULT_BRANCH);
    // Synchronous resolver over PREFETCHED meta tables: `computePushActions` is
    // PURE/sync, but the file/ref reads are async — so we prefetch every (path,
    // side) the diff will ask for into a table first, then resolve from it.
    const metaTable = new Map();
    for (const change of changes) {
        // `current`: A/M/R/C still have the file on `main`. `prev`: D needs the
        // pre-image; R/C also benefit (old title). Prefetch both sides per path.
        const currentPath = change.path;
        const prevPath = change.oldPath ?? change.path;
        if (!metaTable.has(`${currentPath}|current`)) {
            metaTable.set(`${currentPath}|current`, await readMetaCurrent(deps, currentPath, settings.docmostSpaceId));
        }
        if (!metaTable.has(`${prevPath}|prev`)) {
            metaTable.set(`${prevPath}|prev`, await readMetaPrev(deps, base.ref, prevPath, settings.docmostSpaceId));
        }
    }
    const metaAt = (path, side) => metaTable.get(`${path}|${side}`) ?? null;
    // The set of pageIds that STILL EXIST somewhere in the current `main` tree.
    // Identity is the pageId, NOT the filename: a file vanishing from one path
    // while the SAME pageId lives at another path is a MOVE (often a layout
    // reshuffle of `_`-fallback names, whose two halves can even land in separate
    // cycles), never a deletion. Built only when the diff contains deletes — the
    // guard's whole job is to stop a phantom delete from trashing a live page.
    let currentPageIds;
    if (changes.some((c) => c.status === "D")) {
        currentPageIds = new Set();
        for (const relPath of await git.listTrackedFiles("*.md")) {
            const pid = (await readMetaCurrent(deps, relPath, settings.docmostSpaceId))
                ?.pageId;
            if (pid)
                currentPageIds.add(pid);
        }
    }
    const actions = computePushActions({ changes, metaAt, currentPageIds });
    const planned = {
        creates: actions.creates.length,
        updates: actions.updates.length,
        deletes: actions.deletes.length,
        renamesMoves: actions.renamesMoves.length,
        skipped: actions.skipped.length,
    };
    // 6. DRY-RUN (default): log the full plan and RETURN — build NO client, make
    //    ZERO Docmost calls, advance NO refs. This is the SAFE default.
    logPlan(log, base, pushedCommit, actions, planned, dryRun);
    if (dryRun) {
        return { mode: "dry-run", base, pushedCommit, planned };
    }
    // 7. --apply: build the REAL client and execute. This is the ONLY write path.
    const client = deps.makeClient(settings);
    const applied = await applyPushActions({
        client,
        // Pass the WHOLE `git` object (it satisfies the applier's
        // `Pick<VaultGit, ...>` deps surface). Passing bare method references
        // (`git.updateRef`, …) would lose their `this` binding, so on a REAL
        // `VaultGit` they would throw `this.runRaw is not a function`. Hand over
        // the object so the methods keep their receiver — exactly as `pull.ts`
        // does for `applyPullActions`.
        git,
        readFile: deps.readFile,
        writeFile: deps.writeFile,
        spaceId: settings.docmostSpaceId,
    }, actions, pushedCommit);
    // 7a. Persist freshly-assigned pageIds (creates) back into git. `applyPushActions`
    //     rewrote those files on disk; commit them on `main` with the `local` trailer
    //     so the new pageIds are recorded, then RE-advance `refs/docmost/last-pushed`
    //     to the new commit so what Docmost mirrors and what last-pushed points at
    //     stay in lock-step (the write-back commit is part of `main` now).
    // Track a divergent-`docmost` mirror across BOTH ff sites (the applier's main
    // push ff in 7b, and the write-back ff here). A divergent mirror is a §5
    // invariant breach in EITHER branch and must escalate identically (exit 1).
    let divergentDocmost = false;
    if (applied.writtenBack.length > 0) {
        await git.stageAll();
        const recorded = await git.commit("local: record created pageIds", {
            authorName: LOCAL_AUTHOR_NAME,
            authorEmail: LOCAL_AUTHOR_EMAIL,
            trailers: [LOCAL_SOURCE_TRAILER],
        });
        if (recorded) {
            const newCommit = await git.revParse(DEFAULT_BRANCH);
            // Only re-advance when the original push was CLEAN (last-pushed was already
            // advanced by the applier); a partial push left the refs untouched and a
            // re-run retries the whole batch, so we must not move them either.
            if (newCommit && applied.lastPushedAdvanced) {
                await git.updateRef(LAST_PUSHED_REF, newCommit);
                const ff = await git.fastForwardBranch(DOCMOST_BRANCH, newCommit);
                if (!ff.ok) {
                    // SYMMETRIC with the main escalation (7b): a divergent mirror in the
                    // write-back branch is the SAME §5 invariant breach and must escalate
                    // (exit 1), not just log a soft warning.
                    divergentDocmost = true;
                    log(`push: WARNING — the 'docmost' mirror branch DIVERGED and was NOT ` +
                        `fast-forwarded to the pageId write-back commit ` +
                        `(${ff.reason ?? "not-fast-forward"}). The §5 invariant ('docmost' ` +
                        `mirrors what Docmost contains) is broken: reconcile 'docmost' ` +
                        `against the live Docmost tree before the next cycle.`);
                }
            }
        }
    }
    // 7b. ESCALATE a divergent-`docmost` fast-forward refusal (SPEC §5 invariant
    //     broken). The applier already refused to clobber a divergent mirror; make
    //     it LOUD (not silent) so the operator notices, and fold it into the exit.
    if (applied.docmostFastForward && !applied.docmostFastForward.ok) {
        divergentDocmost = true;
        log(`push: WARNING — the 'docmost' mirror branch DIVERGED and was NOT ` +
            `fast-forwarded (${applied.docmostFastForward.reason ?? "not-fast-forward"}). ` +
            `The §5 invariant ('docmost' mirrors what Docmost contains) is broken: ` +
            `reconcile 'docmost' against the live Docmost tree before the next cycle.`);
    }
    // 7c. One-line summary (mirrors pull.ts's summary line).
    log(`push complete: ${applied.created} created, ${applied.updated} updated, ` +
        `${applied.deleted} deleted, ${applied.moved} moved, ${applied.renamed} ` +
        `renamed, ${applied.noops.length} no-op(s), ${applied.skipped.length} ` +
        `skipped, ${applied.failures.length} failure(s)` +
        (divergentDocmost ? " [DIVERGENT docmost mirror]" : ""));
    return {
        mode: "apply",
        base,
        pushedCommit,
        planned,
        applied,
        divergentDocmost,
        failures: applied.failures,
    };
}
/** Synthetic native meta from the live working tree (`current` side). */
async function readMetaCurrent(deps, path, spaceId) {
    let text;
    try {
        text = await deps.readFile(path);
    }
    catch {
        return null; // absent on disk (e.g. a D row's path) -> no current meta.
    }
    return nativeMeta(text, path, spaceId);
}
/** Synthetic native meta from the base ref's pre-image (`prev` side). */
async function readMetaPrev(deps, baseRef, path, spaceId) {
    let text;
    try {
        text = await deps.git.showFileAtRef(baseRef, path);
    }
    catch {
        return null;
    }
    if (text === null)
        return null; // path absent at the base ref.
    return nativeMeta(text, path, spaceId);
}
/** Emit the full plan (counts + per-item) to the injected logger. */
function logPlan(log, base, pushedCommit, actions, planned, dryRun) {
    log(`push plan (${dryRun ? "DRY-RUN — no Docmost writes" : "APPLY"}): base=` +
        `${base.ref} (${base.source}${base.sha ? ` ${base.sha.slice(0, 8)}` : ""}) ` +
        `-> main ${pushedCommit.slice(0, 8)}`);
    log(`push plan counts: ${planned.creates} create, ${planned.updates} update, ` +
        `${planned.deletes} delete, ${planned.renamesMoves} rename/move, ` +
        `${planned.skipped} skipped`);
    for (const c of actions.creates)
        log(`  create: ${c.path}`);
    for (const u of actions.updates)
        log(`  update: ${u.pageId} (${u.path})`);
    for (const d of actions.deletes)
        log(`  delete: ${d.pageId}`);
    for (const rm of actions.renamesMoves)
        log(`  rename/move: ${rm.oldPath} -> ${rm.newPath} (${rm.pageId})`);
    for (const s of actions.skipped)
        log(`  skipped [${s.status}] ${s.path}: ${s.reason}`);
}
/**
 * Parse the `push` CLI flags. SAFE BY DEFAULT: without `--apply` the run is a
 * DRY-RUN (plan only). Exported so the flag handling is unit-testable.
 */
export function parseArgs(argv) {
    return { apply: argv.includes("--apply") };
}
