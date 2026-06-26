/**
 * Push cycle — vault -> Docmost (SPEC §6 "ФС → Docmost"), FIRST increment.
 *
 * This module mirrors the structure of `./pull.ts`: a set of VaultGit diff/ref
 * primitives (in `./git.ts`), a PURE planner (`computePushActions`) that turns
 * a git diff into a classified action set with NO IO, and a THIN injectable
 * applier (`applyPushActions`) exercised in tests via fakes only.
 *
 * Direction is vault -> Docmost. The diff is `main` against
 * `refs/docmost/last-pushed` (SPEC §6 step 2); each `A`/`M`/`D`/`R` row is
 * translated into a Docmost mutation by `pageId` identity (SPEC §4):
 *   - A without pageId   -> create_page (then write the assigned pageId back).
 *   - A with    pageId   -> update (restored/copied file; the page already exists).
 *   - M                  -> update content (collab/Yjs path, SPEC §2/§15.6).
 *   - D                  -> delete_page (pageId recovered from the PRE-IMAGE meta).
 *   - R                  -> rename/move (CLASSIFIED here, APPLIED in push #3).
 *
 * MOVE/RENAME APPLY (push #3) — DONE here. `classifyRenameMoves` (PURE) resolves
 * each `renamesMoves` entry into the Docmost op(s) it needs, comparing the PATH-
 * derived parent (SPEC §5: the file path is the source of truth for tree
 * position, NOT stale `meta.parentPageId`) and the meta title; `applyPushActions`
 * then calls `move_page` / `rename_page` (both for a reparent+retitle), or
 * records a NO-OP for a cosmetic local-only file-path rename.
 *
 * The client seam is the native `GitSyncClient` (`Pick<GitSyncClient, ...>`);
 * the gitmost server drives the engine in-process (there is no standalone CLI
 * entry point).
 */
import { type DocmostMdMeta } from "../lib/index.js";
import type { GitSyncClient } from "./client.types.js";
import type { DiffEntry } from "./git.js";
import { VaultGit } from "./git.js";
import { type Settings } from "./settings.js";
export type { DiffEntry } from "./git.js";
/** A page to CREATE in Docmost (new local file, meta has no pageId yet). */
export interface CreateAction {
    /** Vault-relative path of the new file. */
    path: string;
}
/** A page whose CONTENT changed (meta carries the existing pageId). */
export interface UpdateAction {
    pageId: string;
    /** Vault-relative path of the changed file. */
    path: string;
}
/** A page to soft-delete in Docmost (Trash, SPEC §8). */
export interface DeleteAction {
    pageId: string;
}
/** A renamed/moved page (same pageId, new path). Resolution DEFERRED. */
export interface RenameMoveAction {
    pageId: string;
    oldPath: string;
    newPath: string;
}
/**
 * A CLASSIFIED rename/move (push #3): a `RenameMoveAction` resolved into the
 * Docmost op(s) it actually needs. The file PATH is the source of truth for tree
 * position (SPEC §5: "истина связи — pageId, не путь" — the path is COSMETIC and
 * LOCAL, the page identity is its pageId), so we compare the RESOLVED parent of
 * the new path against the resolved parent of the old path, and the title in the
 * current meta against the title in the previous meta. Each sub-op is emitted
 * ONLY when something real changed:
 *   - `move`  — the resolved parent page changed (reparent in Docmost). A `null`
 *     `parentPageId` means the new parent is ROOT (the file sits at the space
 *     root, no enclosing folder).
 *   - `rename` — the page title changed (a pure title edit in Docmost).
 *   - `noop`  — neither changed: a purely LOCAL file-path rename (same parent,
 *     same title). The page identity is its pageId, so Docmost is NOT called.
 * `move` and `rename` are independent and may BOTH be present (reparent + retitle).
 */
export interface RenameMoveActionClassified {
    pageId: string;
    oldPath: string;
    newPath: string;
    /** Present iff the resolved parent changed -> `move_page` (reparent). */
    move?: {
        parentPageId: string | null;
    };
    /** Present iff the title changed -> `rename_page` (title-only). */
    rename?: {
        title: string;
    };
    /** True iff neither parent nor title changed (cosmetic local-only rename). */
    noop?: true;
}
/**
 * Injected resolvers for the PURE `classifyRenameMoves` (push #3). Both are PURE
 * given a path + side; the real `main` (a follow-up) wires them to the file tree
 * (`readFile` for `current`, `git.showFileAtRef` for `prev`), tests pass plain
 * lookups. SPEC §5 path-as-truth:
 *   - `metaAt`: the file's synthetic native meta at that side (title from the
 *     filename, pageId from the `gitmost_id` frontmatter).
 *   - `resolveParentPageId`: the pageId of the page whose FILE is the parent
 *     FOLDER's `.md` (one level up from the given path), or `null` for ROOT.
 */
export interface ClassifyRenameMovesDeps {
    metaAt: (path: string, side: MetaSide) => DocmostMdMeta | null;
    resolveParentPageId: (path: string, side: MetaSide) => string | null;
}
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
export declare function classifyRenameMoves(renamesMoves: RenameMoveAction[], deps: ClassifyRenameMovesDeps): RenameMoveActionClassified[];
/** The classified set of push actions (PURE output of `computePushActions`). */
export interface PushActions {
    creates: CreateAction[];
    updates: UpdateAction[];
    deletes: DeleteAction[];
    renamesMoves: RenameMoveAction[];
    /**
     * Diff rows that could NOT be classified into an action, with a reason — e.g.
     * a deleted file whose PRE-IMAGE meta carried no recoverable pageId (the
     * untracked-file guard, SPEC §8: only files that were tracked with a pageId
     * are deleted in Docmost). Carried so the caller can log them.
     */
    skipped: {
        path: string;
        status: DiffEntry["status"];
        reason: string;
    }[];
}
/**
 * Which tree a `metaAt` lookup reads the file's native meta from:
 *   - `current`: the current `main` tree (the live file content) — used for
 *     A/M/R, where the file still exists.
 *   - `prev`: the last-pushed PRE-IMAGE (e.g. `refs/docmost/last-pushed:<path>`)
 *     — used for D, where the file is gone from `main` but its pageId must be
 *     recovered from the version Docmost last knew (SPEC §6/§8).
 */
export type MetaSide = "current" | "prev";
/** Input to the PURE planner. `metaAt` is injected (no IO inside the planner). */
export interface PushActionsInput {
    /** Diff rows of `main` vs `refs/docmost/last-pushed` (SPEC §6 step 2). */
    changes: DiffEntry[];
    /**
     * Resolve a file's synthetic native meta at a given side, or `null` if the file is
     * absent there / has no parseable meta. PURE injection: the real `main` reads
     * the working tree (current) or `git show <last-pushed>:<path>` (prev); tests
     * pass a plain lookup.
     */
    metaAt: (path: string, side: MetaSide) => DocmostMdMeta | null;
    /**
     * The pageIds present at ANY path in the current `main` tree (optional). When
     * given, a deleted file whose pageId still lives somewhere in the tree is NOT
     * a deletion but a MOVE — guards against trashing a live page when a layout
     * reshuffle relocated its file (possibly across two cycles, so the matching
     * add isn't in THIS diff). When omitted, only the in-diff D+A/M coalescing
     * applies.
     */
    currentPageIds?: Set<string>;
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
export declare function computePushActions(input: PushActionsInput): PushActions;
/** The marker the push direction advances after a successful push (SPEC §5/§6). */
export declare const LAST_PUSHED_REF = "refs/docmost/last-pushed";
/**
 * The mirror branch fast-forwarded after a clean push (SPEC §5/§6 step 3). It
 * reflects "what Docmost currently contains"; advancing it to the pushed `main`
 * commit closes the loop so the next pull diffs empty for the pushed pages.
 */
export declare const DOCMOST_BRANCH = "docmost";
/**
 * Injectable IO for `applyPushActions`. The real `main` (NEXT increment) wires
 * these to the live client, `node:fs/promises`, and the vault git wrapper; this
 * increment drives them only through FAKES in tests (no live destructive run).
 *   - `client`: the create/update/delete/move/rename subset of `GitSyncClient`.
 *   - `readFile`/`writeFile`: read a changed file's body / write a file back
 *     (by vault-relative path; the applier does not resolve absolute paths so
 *     fakes stay trivial).
 *   - `git`: `updateRef` (advance `refs/docmost/last-pushed`) and
 *     `fastForwardBranch` (advance the `docmost` mirror after a clean push, the
 *     loop-close — SPEC §6 step 3 / §10).
 */
export interface ApplyPushDeps {
    client: Pick<GitSyncClient, "importPageMarkdown" | "createPage" | "deletePage" | "movePage" | "renamePage">;
    /** Read a changed file's full text by its vault-relative path. */
    readFile: (path: string) => Promise<string>;
    /** Write a file's full text by its vault-relative path. */
    writeFile: (path: string, text: string) => Promise<void>;
    /**
     * The Docmost spaceId this vault mirrors. A CREATE targets this space (the
     * native file carries no spaceId — every file in the vault belongs to it), and
     * it backs the synthetic native meta the classifier reads.
     */
    spaceId: string;
    /**
     * `updateRef` advances `refs/docmost/last-pushed`; `fastForwardBranch` advances
     * the `docmost` mirror after a clean push. `showFileAtRef` reads a file's text
     * at a ref (used by the move/rename classifier to resolve the PREVIOUS parent
     * folder's `.md` at `refs/docmost/last-pushed`, SPEC §5 path-as-truth).
     */
    git: Pick<VaultGit, "updateRef" | "fastForwardBranch" | "showFileAtRef">;
}
/** A file whose meta was rewritten with a freshly-assigned pageId (post-create). */
export interface WrittenBackPage {
    path: string;
    pageId: string;
}
/**
 * The per-page push record consulted by a FUTURE poll-suppression (SPEC §10): a
 * pulled page whose body hash + `updatedAt` match a record here is OUR OWN write
 * and must not be re-pulled. PRODUCED here; CONSUMED on the pull side later.
 */
export interface PushedPageRecord {
    /** The Docmost pageId that was updated/created. */
    pageId: string;
    /**
     * The `updatedAt` from the create/update client result, when the result
     * exposed one. Absent when the (fake) client did not return it.
     */
    updatedAt?: string;
    /** Stable hash of the markdown BODY that was pushed (SPEC §10 "хэш тела"). */
    bodyHash: string;
}
/**
 * One page whose operation FAILED during apply (SPEC §12 resumability). The bad
 * page is isolated — recorded here — and the rest of the batch still runs; the
 * refs are NOT advanced when there is any failure, so a re-run retries cleanly.
 */
export interface PushFailure {
    kind: "update" | "create" | "delete" | "move" | "rename";
    /** The pageId for update/delete/move/rename; absent for a never-id'd create. */
    pageId?: string;
    /** The vault-relative path for create/update/move/rename; absent for delete. */
    path?: string;
    /** The error message captured from the thrown error. */
    error: string;
}
/**
 * A rename/move action that resolved to a NO-OP (push #3, SPEC §5): a purely
 * LOCAL file-path rename whose resolved parent AND title are both unchanged. The
 * page identity is its pageId and the path is COSMETIC/local-only, so Docmost is
 * NOT called — the skip is recorded here (with the reason) for logging.
 */
export interface PushNoop {
    pageId: string;
    oldPath: string;
    newPath: string;
    /** Why no Docmost op was emitted (currently always a path-only rename). */
    reason: "path-only-rename";
}
/** Structured outcome of `applyPushActions` (counts + write-backs + noops). */
export interface ApplyPushResult {
    created: number;
    updated: number;
    deleted: number;
    /** Pages reparented in Docmost via `move_page` (push #3, SPEC §5/§16). */
    moved: number;
    /** Pages retitled in Docmost via `rename_page` (push #3, SPEC §5/§6). */
    renamed: number;
    /**
     * Files whose `gitmost_id` frontmatter was written with the pageId Docmost assigned on
     * create — these now need a FOLLOW-UP commit (the meta on disk changed). The
     * commit itself is the caller's job (NEXT increment); recorded here so it is
     * not lost.
     */
    writtenBack: WrittenBackPage[];
    /**
     * Per-page push records (pageId + optional `updatedAt` + body hash) for every
     * page successfully updated/created — the §10 loop-guard data a future
     * poll-suppression (pull side) will consult so it does not re-pull our own
     * write. Deletes are not included (no body was pushed).
     */
    pushed: PushedPageRecord[];
    /**
     * Pages whose operation threw — isolated and recorded, the batch continued
     * (SPEC §12). Non-empty here means the refs were NOT advanced.
     */
    failures: PushFailure[];
    /**
     * Rename/move actions that resolved to a NO-OP — a purely LOCAL file-path
     * rename (same parent, same title). NO Docmost call was made for these (SPEC
     * §5: the page is its pageId, the path is local-only). Recorded for logging.
     */
    noops: PushNoop[];
    /** Diff rows the planner could not classify (carried through for logging). */
    skipped: PushActions["skipped"];
    /** Whether `refs/docmost/last-pushed` was advanced (only on a CLEAN push). */
    lastPushedAdvanced: boolean;
    /**
     * Result of fast-forwarding the `docmost` mirror branch after a CLEAN push
     * (the loop-close, SPEC §6 step 3 / §10). `null` when no advance was attempted
     * (no `pushedCommit`, or there were failures). `{ ok:false, reason }` when a
     * non-fast-forward was REFUSED (divergent `docmost` history is never clobbered).
     */
    docmostFastForward: {
        ok: boolean;
        reason?: string;
    } | null;
}
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
export declare function applyPushActions(deps: ApplyPushDeps, actions: PushActions, pushedCommit?: string): Promise<ApplyPushResult>;
/**
 * SPEC §5 path-as-truth: the parent FOLDER's `.md` file for a vault-relative
 * (forward-slash) path. `buildVaultLayout` puts a page with children at
 * `<...>/Title.md` and nests its children under `<...>/Title/`, so for
 * `newPath = <dir>/Child.md` the parent page's file is `<dir>.md` (the enclosing
 * folder, one level up). A path with NO enclosing folder (`Child.md`, at the
 * space root) has no parent folder file -> `null` (the parent is ROOT).
 */
export declare function parentFolderFile(path: string): string | null;
/**
 * Whether a vault path is a Docmost PAGE file (design §"Адопция"): a `.md` file
 * with NO dot-segment anywhere in its path. This excludes `.obsidian/` config,
 * `.trash/`, dotfiles (`.foo.md`), and every non-`.md` file (attachments, JSON,
 * …) — Obsidian owns those; they live in the vault but are never pages. Used to
 * screen the PUSH diff so non-page files are never created/updated/deleted in
 * Docmost (and never get a `gitmost_id` frontmatter written into them).
 */
export declare function isPageFile(path: string): boolean;
/**
 * The human ("local") git identity used for engine-made commits on `main` in the
 * push direction (SPEC §7.3). The provenance is carried by the trailer (below),
 * which the loop-guard keys on; the identity is for history readability only.
 * When the vault repo already has a configured `user.name`/`user.email`, git
 * uses that for the working-tree commit; this is the fallback the daemon stamps.
 */
export declare const LOCAL_AUTHOR_NAME = "Local";
export declare const LOCAL_AUTHOR_EMAIL = "local@local";
/** The provenance trailer marking a `main`-side (human/local) commit (SPEC §7.3). */
export declare const LOCAL_SOURCE_TRAILER = "Docmost-Sync-Source: local";
/**
 * Injectable deps for `runPush` (mirrors `pull.ts`'s wiring; everything that
 * touches the outside world is here so tests pass fakes). `makeClient` is a
 * FACTORY, not a client — a dry-run must build NO client at all (it is never
 * called), and only `--apply` invokes it.
 */
export interface PushDeps {
    settings: Settings;
    git: Pick<VaultGit, "assertGitAvailable" | "ensureRepo" | "isMergeInProgress" | "checkout" | "stageAll" | "commit" | "readRef" | "revParse" | "diffNameStatus" | "showFileAtRef" | "updateRef" | "fastForwardBranch" | "listTrackedFiles">;
    /** Build a real client — called ONLY on `--apply`, never on dry-run. */
    makeClient: (settings: Settings) => ApplyPushDeps["client"];
    /** Read a file's full text by its vault-relative (forward-slash) path. */
    readFile: (path: string) => Promise<string>;
    /** Write a file's full text by its vault-relative path. */
    writeFile: (path: string, text: string) => Promise<void>;
    /** Structured logger (defaults to console in `main`; a recorder in tests). */
    log: (line: string) => void;
}
/** The structured outcome of a `runPush` cycle (returned + summarized). */
export interface PushRunResult {
    /** Which path ran: `dry-run` (plan only) or `apply` (Docmost mutated). */
    mode: "dry-run" | "apply";
    /** Why the cycle stopped before planning, if it did (e.g. a left-over merge). */
    aborted?: "merge-in-progress";
    /** The diff base the plan was computed against (`last-pushed` else `docmost`). */
    base?: {
        ref: string;
        source: "last-pushed" | "docmost";
        sha: string | null;
    };
    /** The `main` commit the plan targets (the would-be pushed commit). */
    pushedCommit?: string;
    /** Planned action counts from the PURE planner (present once a plan was built). */
    planned?: {
        creates: number;
        updates: number;
        deletes: number;
        renamesMoves: number;
        skipped: number;
    };
    /** The applier's structured result — ONLY present on the `--apply` path. */
    applied?: ApplyPushResult;
    /**
     * True when `applyPushActions` REFUSED to fast-forward a divergent `docmost`
     * mirror (SPEC §5 invariant broken). Escalated (logged prominently) and folded
     * into the CLI's non-zero exit.
     */
    divergentDocmost?: boolean;
    /** Per-page failures from the applier (empty/absent on a clean run). */
    failures?: PushFailure[];
}
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
export declare function runPush(deps: PushDeps, opts: {
    dryRun: boolean;
}): Promise<PushRunResult>;
/** Parsed `push` CLI flags. DRY-RUN is the default; `--apply` opts into writes. */
export interface PushParsedArgs {
    /** True when `--apply` was passed (the ONLY path that writes to Docmost). */
    apply: boolean;
}
/**
 * Parse the `push` CLI flags. SAFE BY DEFAULT: without `--apply` the run is a
 * DRY-RUN (plan only). Exported so the flag handling is unit-testable.
 */
export declare function parseArgs(argv: string[]): PushParsedArgs;
