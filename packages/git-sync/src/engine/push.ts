/**
 * Push cycle — vault -> Docmost (SPEC §6 "FS -> Docmost"), FIRST increment.
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
import {
  type DocmostMdMeta,
  parsePageFile,
  serializePageFile,
} from "@docmost/prosemirror-markdown";
import type { GitSyncClient } from "./client.types.js";
import type { DiffEntry } from "./git.js";
import { VaultGit, DEFAULT_BRANCH } from "./git.js";
import { bodyHash } from "./loop-guard.js";
import { type Settings } from "./settings.js";

// Re-export so callers/tests can import the diff row shape from either module.
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
  /**
   * Ref-tree path (at `LAST_PUSHED_REF`) to resolve the 3-way merge BASE from;
   * defaults to `path`. Set to the OLD path for RENAME-derived updates: a renamed
   * file lives at its NEW `path` in the working tree, but in the last-pushed tree
   * the file was at its OLD path — so the merge base must be looked up there, or
   * it resolves to `null` and the merge degrades to a 2-way (clobbering concurrent
   * Docmost-side edits). For a plain `M` update this is undefined -> uses `path`,
   * an honest 3-way merge at the same path (unchanged behavior).
   */
  basePath?: string;
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
 * position (SPEC §5: "the identity is the pageId, not the path" — the path is COSMETIC and
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
  move?: { parentPageId: string | null };
  /** Present iff the title changed -> `rename_page` (title-only). */
  rename?: { title: string };
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
export function classifyRenameMoves(
  renamesMoves: RenameMoveAction[],
  deps: ClassifyRenameMovesDeps,
): RenameMoveActionClassified[] {
  return renamesMoves.map((rm) => {
    const newParent = deps.resolveParentPageId(rm.newPath, "current");
    const oldParent = deps.resolveParentPageId(rm.oldPath, "prev");
    // Strip the cosmetic ` ~<slugId>` disambiguation suffix before comparing
    // titles: it is a LOCAL filesystem artifact (`buildVaultLayout` appends it to
    // a colliding sibling's stem), NOT part of the page's real title. A pure
    // disambiguation file-rename ('Report.md' -> 'Report ~a1.md') must therefore
    // NOT be pushed to Docmost as a title change (red-team #4b), and any title we
    // DO push must carry the real title ('Report'), never the suffixed form.
    const rawNewTitle = deps.metaAt(rm.newPath, "current")?.title;
    const rawOldTitle = deps.metaAt(rm.oldPath, "prev")?.title;
    // A PURE disambiguation rename only APPENDS a cosmetic ` ~<suffix>` to the
    // SAME title (layout.ts), so the real Docmost title is unchanged. Strip the
    // suffix ONLY when the new name is exactly the old title plus that suffix —
    // never blindly strip a genuine retitle whose new title legitimately ends in
    // ` ~token` (e.g. "Budget ~draft" -> "Budget ~final"), which would corrupt
    // the title in Docmost / drop a real rename (review finding).
    const isCosmeticDisambiguation =
      typeof rawNewTitle === "string" &&
      typeof rawOldTitle === "string" &&
      rawNewTitle !== rawOldTitle &&
      stripDisambiguationSuffix(rawNewTitle) === rawOldTitle;
    const newTitle = isCosmeticDisambiguation ? rawOldTitle : rawNewTitle;
    const oldTitle = rawOldTitle;

    const out: RenameMoveActionClassified = {
      pageId: rm.pageId,
      oldPath: rm.oldPath,
      newPath: rm.newPath,
    };
    // A reparent: the new path's resolved parent page differs from the old's.
    if (newParent !== oldParent) {
      out.move = { parentPageId: newParent };
    }
    // A title edit: only when there is a real, non-empty new title that changed.
    if (
      typeof newTitle === "string" &&
      newTitle.length > 0 &&
      newTitle !== oldTitle
    ) {
      out.rename = { title: newTitle };
    }
    // Neither changed -> a purely LOCAL file-path rename; do NOT call Docmost.
    if (!out.move && !out.rename) {
      out.noop = true;
    }
    return out;
  });
}

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
  skipped: { path: string; status: DiffEntry["status"]; reason: string }[];
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
 * Emit the action PAIR a move/rename needs (F4): a `renamesMoves` entry (the
 * relocation, applied later as a move/rename — those ops are content-free) AND a
 * body `updates` entry for the NEW path, so a body edit riding along in the SAME
 * diff is not lost. `importPageMarkdown` targets by pageId and is a near-no-op for
 * a pure relocation. The merge BASE is taken from the OLD path (`basePath`): the
 * file lives at its NEW `path` in the working tree, but at last-pushed it was at
 * `oldPath`, so the 3-way base must be looked up THERE — otherwise it resolves to
 * null and the merge degrades to a 2-way, clobbering a concurrent Docmost-side
 * edit. A PURE relocation is then a no-op that PRESERVES the live page. Shared by
 * all three emit sites (ghost-move A, ghost-move M, and R/C).
 */
function emitMoveWithBody(
  actions: PushActions,
  pageId: string,
  oldPath: string,
  newPath: string,
): void {
  actions.renamesMoves.push({ pageId, oldPath, newPath });
  actions.updates.push({ pageId, path: newPath, basePath: oldPath });
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
export function computePushActions(input: PushActionsInput): PushActions {
  const { metaAt, currentPageIds } = input;
  // PAGE-FILE FILTER (design §"Adoption"): only `.md` files OUTSIDE any dot-folder
  // are Docmost pages. `.obsidian/*`, attachments, and other non-page files are
  // committed to the vault (no `.gitignore`) and so appear in the diff, but they
  // are NEVER pages — Obsidian owns them. Without this filter every ADDED such
  // file would be mis-classified as a CREATE (nativeMeta always supplies a
  // spaceId, so the old `create-without-spaceId` skip no longer screens them),
  // creating junk pages in Docmost and corrupting the file with a `gitmost_id`
  // frontmatter. Filter BEFORE any classification so non-page A/M/D/R are ignored.
  const changes = input.changes.filter((c) => isPageFile(c.path));
  const actions: PushActions = {
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
  const deletedPath = new Map<string, string>();
  const survivingPath = new Map<string, string>();
  for (const change of changes) {
    if (change.status === "D") {
      const pid = metaAt(change.path, "prev")?.pageId;
      if (pid) deletedPath.set(pid, change.path);
    } else if (change.status === "A" || change.status === "M") {
      const pid = metaAt(change.path, "current")?.pageId;
      if (pid) survivingPath.set(pid, change.path);
    }
  }
  const ghostMove = new Map<string, { oldPath: string; newPath: string }>();
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
          // as a rename/move (like a real `R`) PLUS a body update for the new path
          // (F4); the `D` side is suppressed so the page is never soft-deleted.
          emitMoveWithBody(
            actions,
            pageId,
            ghostMove.get(pageId)!.oldPath,
            change.path,
          );
        } else if (pageId) {
          // Added but already carries a pageId (restored/copied file): the page
          // exists in Docmost, so push content as an UPDATE — never a duplicate.
          actions.updates.push({ pageId, path: change.path });
        } else if (meta?.spaceId) {
          // Brand-new local file with a target space -> create the page, then
          // write the assigned pageId back into its meta (in `applyPushActions`).
          // `meta.spaceId` is truthy here, so empty-string is also rejected.
          actions.creates.push({ path: change.path });
        } else {
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
          // — coalesce into a rename/move (plus a body update for the new path, F4)
          // so the page is never trashed.
          emitMoveWithBody(
            actions,
            pageId,
            ghostMove.get(pageId)!.oldPath,
            change.path,
          );
        } else if (pageId) {
          actions.updates.push({ pageId, path: change.path });
        } else {
          // The current file has no `gitmost_id` — but it was MODIFIED, so a prior
          // version existed at this path. Recover the identity from the PRE-IMAGE
          // (the last-pushed version at the same path, which still carried the id),
          // mirroring the `D` branch. Without this, an edit that also dropped the
          // frontmatter (e.g. a tool that rewrote the whole file) is silently
          // skipped and then reverted by the next Docmost->git push — the edit is
          // lost (bug C10-D1). The pushed-back re-serialize restores the frontmatter
          // next cycle, so the file self-heals. If the pre-image ALSO lacked an id
          // (a page never tracked), there is genuinely nothing to update -> skip.
          const prevPageId = metaAt(change.path, "prev")?.pageId;
          if (prevPageId && !ghostMove.has(prevPageId)) {
            actions.updates.push({ pageId: prevPageId, path: change.path });
          } else {
            actions.skipped.push({
              path: change.path,
              status: "M",
              reason: "modified file has no pageId in meta (nor in pre-image)",
            });
          }
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
        } else if (pageId && currentPageIds?.has(pageId)) {
          // The pageId still EXISTS elsewhere in the current tree: the file moved
          // (a layout reshuffle whose matching add was in an earlier cycle, so it
          // is not in this diff). A live page must never be trashed because its
          // FILENAME changed — identity is the pageId (⭐ data-loss guard).
          actions.skipped.push({
            path: change.path,
            status: "D",
            reason: "pageId still present in the tree (moved) — not a deletion",
          });
        } else if (pageId) {
          actions.deletes.push({ pageId });
        } else {
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
          // Record the rename/move PLUS a body update for the new path (F4): git
          // `-M` reports a rename+edit as a SINGLE `R` row, so a body edit made in
          // the same commit as the move would otherwise be lost. For a `C` copy
          // `oldPath` is the SOURCE (it exists in the ref tree), so the copy's body
          // 3-way-merges against its source's last-pushed text.
          emitMoveWithBody(actions, pageId, oldPath, change.path);
        } else {
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
 * Injectable IO for `applyPushActions`. In production these are wired to the live
 * client (the native GitmostDataSource), `node:fs/promises`, and the vault git
 * wrapper — `applyPushActions` runs LIVE via runPush -> runCycle -> the
 * orchestrator's driveCycle. Tests substitute FAKES through the same seam.
 *   - `client`: the create/update/delete/move/rename subset of `GitSyncClient`.
 *   - `readFile`/`writeFile`: read a changed file's body / write a file back
 *     (by vault-relative path; the applier does not resolve absolute paths so
 *     fakes stay trivial).
 *   - `git`: `updateRef` (advance `refs/docmost/last-pushed`) and
 *     `fastForwardBranch` (advance the `docmost` mirror after a clean push, the
 *     loop-close — SPEC §6 step 3 / §10).
 */
export interface ApplyPushDeps {
  client: Pick<
    GitSyncClient,
    | "listSpaceTree"
    | "importPageMarkdown"
    | "createPage"
    | "deletePage"
    | "movePage"
    | "renamePage"
  >;
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
  /**
   * Per-space PUSH policy for a page body that still carries unresolved git
   * conflict markers (SPEC §9). When TRUE, the marker lines are stripped and both
   * sides' content is pushed (the legacy `stripConflictMarkers` behavior). When
   * FALSE/undefined (the SAFE DEFAULT), the conflicted page is NOT pushed: it is
   * recorded as a per-page FAILURE (so the refs are not advanced and the page is
   * retried) and the user resolves the git conflict first.
   */
  autoMergeConflicts?: boolean;
}

/**
 * Reason recorded on a per-page push FAILURE when a page is skipped because its
 * body still carries unresolved git conflict markers and `autoMergeConflicts` is
 * off (the SAFE default). Recorded as a failure (not a soft skip) on purpose: it
 * HOLDS the refs so the conflict commit is never marked as pushed and the page is
 * retried until the human resolves the conflict in git (SPEC §9).
 */
export const CONFLICT_MARKERS_FAILURE_REASON =
  "unresolved conflict markers — resolve in git first";

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
  /** Stable hash of the markdown BODY that was pushed (SPEC §10 "body hash"). */
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
  docmostFastForward: { ok: boolean; reason?: string } | null;
}

/**
 * THIN IO applier for the COMMON push cases (create/update/delete). Runs LIVE in
 * production (via runPush -> runCycle -> orchestrator); tests drive it with FAKES.
 *
 *   - UPDATE: read the file body, then `client.importPageMarkdown(pageId, body)`.
 *     This is the collab/Yjs write path (SPEC §2/§15.6) — NEVER a raw jsonb
 *     overwrite. The file's markdown is sent as-is; `importPageMarkdown` parses
 *     the meta/body itself.
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
export async function applyPushActions(
  deps: ApplyPushDeps,
  actions: PushActions,
  pushedCommit?: string,
): Promise<ApplyPushResult> {
  const { client, git } = deps;

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let moved = 0;
  let renamed = 0;
  const writtenBack: WrittenBackPage[] = [];
  const pushed: PushedPageRecord[] = [];
  const failures: PushFailure[] = [];
  const noops: PushNoop[] = [];

  // 1. UPDATES — collab/Yjs write path (SPEC §2/§15.6), never a raw overwrite.
  //    Each update is isolated: a thrown page is recorded and the batch goes on.
  for (const u of actions.updates) {
    try {
      // Push the CLEAN body only (no `gitmost_id` frontmatter): the frontmatter
      // is engine metadata, never page content. The server converts the markdown
      // it receives verbatim, so stripping here keeps the id out of Docmost.
      const rawBody = parsePageFile(await deps.readFile(u.path)).body;
      // Git conflict markers must NEVER reach Docmost (SPEC §9, red-team #13).
      // Per-space policy (`autoMergeConflicts`): when OFF (the SAFE default), a
      // still-conflicted body is NOT pushed — record a failure so the refs are
      // held and the page is retried once the human resolves the conflict in git.
      // When ON, strip the marker lines and push both sides' content.
      if (!deps.autoMergeConflicts && hasConflictMarkers(rawBody)) {
        failures.push({
          kind: "update",
          pageId: u.pageId,
          path: u.path,
          error: CONFLICT_MARKERS_FAILURE_REASON,
        });
        continue;
      }
      const conflicted = hasConflictMarkers(rawBody);
      const body = stripConflictMarkers(rawBody);
      // The last-synced version of this file (pre-image) is the common ancestor
      // for a 3-way merge against the live page, so concurrent human edits are
      // not clobbered (review #5). Null when the file is new at last-pushed. Its
      // body is stripped the SAME way (frontmatter AND conflict markers) so the
      // merge compares clean body-to-body: a base that itself carried markers
      // (from a prior conflict commit) must never reintroduce marker syntax or a
      // stale diff3 base region into the 3-way merge.
      // Resolve the merge base from `basePath` when set (the OLD path for a
      // rename-derived update), falling back to `u.path` for a plain `M` update —
      // identical behavior to before for non-renames. The BODY is still read from
      // `u.path` (the new working-tree location); only the BASE lookup changes.
      const baseFull = await deps.git.showFileAtRef(
        LAST_PUSHED_REF,
        u.basePath ?? u.path,
      );
      const baseMarkdown =
        baseFull === null
          ? null
          : stripConflictMarkers(parsePageFile(baseFull).body);
      const result = await client.importPageMarkdown(
        u.pageId,
        body,
        baseMarkdown,
      );
      updated++;
      // CONFLICT VAULT-CLEAN (autoMergeConflicts ON, SPEC §9 marker leak). On ON
      // a conflicted page is auto-merged INTO Docmost (the clean `body` above),
      // but the file on `main` still carries the raw `<<<<<<<`/`>>>>>>>` markers
      // the pull-side `commitMerge` committed. Left as-is they would (1) stay in
      // the PUBLISHED vault forever (external clones see raw markers) and (2)
      // re-conflict every cycle. So write the CLEAN body back to the vault file
      // and record it in `writtenBack` — `runPush` step 7a commits it on `main`
      // and re-advances the refs, so the published vault converges to the merged
      // content. Only conflicted files are rewritten (no churn for clean updates).
      if (conflicted) {
        await deps.writeFile(u.path, serializePageFile(u.pageId, body));
        writtenBack.push({ path: u.path, pageId: u.pageId });
      }
      // §10 loop-guard data: hash the BODY we pushed + capture `updatedAt`.
      pushed.push({
        pageId: u.pageId,
        ...extractUpdatedAt(result),
        bodyHash: bodyHash(body),
      });
    } catch (err: unknown) {
      failures.push({
        kind: "update",
        pageId: u.pageId,
        path: u.path,
        error: errMessage(err),
      });
    }
  }

  // 2. CREATES — create the page, then write the assigned pageId back to meta so
  //    the file becomes tracked (SPEC §4 "write the assigned pageId back").
  //    Isolated per page like updates.
  //
  // RETRY-ADOPT (#1 idempotency): create is NOT atomic with the pageId write-back
  // (createPage runs, then writeFile, then the write-back commit at runPush 7a). If
  // the write-back dies in between, the file on disk still has no pageId and the
  // next cycle re-classifies it as a CREATE -> a DUPLICATE page would be created.
  // To guard against this, build a (parentPageId|root, title) -> existing pageId map
  // ONCE from the LIVE Docmost tree (only when there is at least one create). The
  // native-Obsidian layout makes filenames — and therefore titles — unique within a
  // folder, so (parentPageId, title) identifies the page; a match means a prior
  // cycle already created it, so we ADOPT instead of duplicating.
  let liveByParentTitle: Map<string, string> | null = null;
  // A (parentPageId, title) that more than ONE live page shares is AMBIGUOUS:
  // adopting one of them would silently overwrite an arbitrary, possibly-unrelated
  // sibling (red-team #6). Such keys are recorded here and EXCLUDED from adoption.
  const ambiguousAdoptKeys = new Set<string>();
  if (actions.creates.length > 0) {
    const live = await client.listSpaceTree(deps.spaceId);
    // Only trust a COMPLETE tree for retry-adopt: a truncated tree could miss an
    // already-created page and let us create a DUPLICATE (the very thing adopt
    // prevents). The native client always returns complete:true (reads the DB);
    // on an incomplete tree we leave the map null -> fall back to plain createPage.
    if (live.complete) {
      liveByParentTitle = new Map();
      for (const n of live.pages) {
        const key = `${n.parentPageId ?? " root"} ${n.title ?? ""}`;
        // First node claims the key; a SECOND match marks it ambiguous so neither
        // is ever adopted-over (the create falls back to a fresh createPage).
        if (liveByParentTitle.has(key)) ambiguousAdoptKeys.add(key);
        else liveByParentTitle.set(key, n.id);
      }
    }
  }
  // Order creates PARENT-before-CHILD (red-team #12): a child whose parent is
  // ALSO a fresh create must run AFTER its parent so the parent's just-assigned
  // pageId is available to parent it (otherwise it is placed at the space ROOT).
  const orderedCreates = orderCreatesParentFirst(actions.creates);
  // Track pageIds assigned (or adopted) to each create's PATH in THIS batch, so a
  // child can resolve its freshly-created parent's id without depending on the
  // on-disk write-back being observable yet (red-team #12).
  const createdIdByPath = new Map<string, string>();
  for (const c of orderedCreates) {
    try {
      const text = await deps.readFile(c.path);
      const rawBody = parsePageFile(text).body;
      // Conflict markers must never reach Docmost (SPEC §9, red-team #13). Honor
      // the per-space `autoMergeConflicts` policy on the create path too: OFF (the
      // SAFE default) records a failure (refs held, retried) rather than creating
      // a page from conflicted content; ON strips the markers and pushes both
      // sides' content.
      if (!deps.autoMergeConflicts && hasConflictMarkers(rawBody)) {
        failures.push({
          kind: "create",
          path: c.path,
          error: CONFLICT_MARKERS_FAILURE_REASON,
        });
        continue;
      }
      const body = stripConflictMarkers(rawBody);
      // Derive create args from the PATH (native-Obsidian, SPEC §5): title from
      // the filename, parent from the enclosing folder's folder-note, space from
      // the run (the vault's space). `parentPageId: null` -> created at ROOT.
      const title = titleFromPath(c.path);
      // Resolve the parent from the PATH (SPEC §5). Prefer an id assigned to the
      // parent's folder-note EARLIER in this same batch — a freshly-created parent
      // whose on-disk write-back may not be observable yet (red-team #12; creates
      // are ordered parent-before-child so the parent already ran).
      const parentFile = parentFolderFile(c.path);
      const parentPageId =
        (parentFile !== null ? createdIdByPath.get(parentFile) : undefined) ??
        (await resolveParentPageIdViaTree(deps, c.path, "current")) ??
        undefined;
      // Retry-adopt (#1 idempotency): a prior cycle already created this page in
      // Docmost but failed to persist the pageId back to the file, so it was
      // re-seen as a create. Adopt the existing page instead of duplicating it:
      // write the id back (file becomes tracked) and push the body as an UPDATE
      // (idempotent — targets by pageId). Do NOT call createPage again. SKIP
      // adoption when the (parent, title) is AMBIGUOUS — adopting an arbitrary
      // duplicate-title sibling would silently overwrite it (red-team #6).
      const adoptKey = `${parentPageId ?? " root"} ${title}`;
      const existingId = ambiguousAdoptKeys.has(adoptKey)
        ? undefined
        : liveByParentTitle?.get(adoptKey);
      if (existingId) {
        const rewritten = serializePageFile(existingId, body);
        await deps.writeFile(c.path, rewritten);
        writtenBack.push({ path: c.path, pageId: existingId });
        createdIdByPath.set(c.path, existingId);
        const adopted = await client.importPageMarkdown(existingId, body, null);
        pushed.push({
          pageId: existingId,
          ...extractUpdatedAt(adopted),
          bodyHash: bodyHash(body),
        });
        created++;
        continue;
      }
      const result = await client.createPage(
        title,
        body,
        deps.spaceId,
        parentPageId,
      );
      // `createPage` returns `{ data: { id, ... }, success }`; the assigned
      // pageId is at `result.data.id`.
      const assignedPageId: string | undefined = result?.data?.id;
      if (assignedPageId) {
        // Write the assigned pageId back as the `gitmost_id` frontmatter, body
        // preserved — the file becomes engine-tracked (SPEC §4).
        const rewritten = serializePageFile(assignedPageId, body);
        await deps.writeFile(c.path, rewritten);
        writtenBack.push({ path: c.path, pageId: assignedPageId });
        createdIdByPath.set(c.path, assignedPageId);
        // §10 loop-guard data for the created page (hash the pushed BODY).
        pushed.push({
          pageId: assignedPageId,
          ...extractUpdatedAt(result),
          bodyHash: bodyHash(body),
        });
      }
      created++;
    } catch (err: unknown) {
      failures.push({ kind: "create", path: c.path, error: errMessage(err) });
    }
  }

  // 3. DELETES — soft-delete to Trash (SPEC §8), reversible. Isolated per page.
  for (const d of actions.deletes) {
    try {
      await client.deletePage(d.pageId);
      deleted++;
    } catch (err: unknown) {
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
    const parentTable = new Map<string, string | null>();
    const metaTable = new Map<string, DocmostMdMeta | null>();
    // A tree read (readFile / git.showFileAtRef) throwing must isolate THAT page
    // into `failures`, NOT abort the whole batch (§12 resumability). The helpers
    // already swallow their own errors, but this per-entry try/catch keeps the
    // batch-isolation invariant holding regardless of future changes to them.
    const prefetchFailed = new Set<string>();
    for (const rm of actions.renamesMoves) {
      // newParent + newTitle from the CURRENT tree; oldParent + oldTitle from the
      // last-pushed pre-image (`prev`). Keyed by `path|side` so duplicates fold.
      try {
        parentTable.set(
          `${rm.newPath}|current`,
          await resolveParentPageIdViaTree(deps, rm.newPath, "current"),
        );
        parentTable.set(
          `${rm.oldPath}|prev`,
          await resolveParentPageIdViaTree(deps, rm.oldPath, "prev"),
        );
        metaTable.set(
          `${rm.newPath}|current`,
          await metaAtViaTree(deps, rm.newPath, "current", deps.spaceId),
        );
        metaTable.set(
          `${rm.oldPath}|prev`,
          await metaAtViaTree(deps, rm.oldPath, "prev", deps.spaceId),
        );
      } catch (err: unknown) {
        prefetchFailed.add(rm.pageId);
        failures.push({
          kind: "move",
          pageId: rm.pageId,
          path: rm.newPath,
          error: errMessage(err),
        });
      }
    }
    const classified = classifyRenameMoves(
      actions.renamesMoves.filter((rm) => !prefetchFailed.has(rm.pageId)),
      {
        metaAt: (path, side) => metaTable.get(`${path}|${side}`) ?? null,
        resolveParentPageId: (path, side) =>
          parentTable.get(`${path}|${side}`) ?? null,
      },
    );

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
      let failingKind: "move" | "rename" = c.move ? "move" : "rename";
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
      } catch (err: unknown) {
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
  let docmostFastForward: { ok: boolean; reason?: string } | null = null;
  if (pushedCommit && failures.length === 0) {
    await git.updateRef(LAST_PUSHED_REF, pushedCommit);
    lastPushedAdvanced = true;
    // Fast-forward the mirror (refused, not forced, on a non-fast-forward — the
    // caller logs the reason). Surfaced in the result.
    docmostFastForward = await git.fastForwardBranch(
      DOCMOST_BRANCH,
      pushedCommit,
    );
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
function errMessage(err: unknown): string {
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
export function parentFolderFile(path: string): string | null {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return null; // root-level file: parent is ROOT.
  const dir = path.slice(0, slash); // the enclosing folder
  // The page that OWNS the enclosing folder is its folder-note `<dir>/<base>.md`.
  const folderNote = `${dir}/${baseSegment(dir)}.md`;
  if (path === folderNote) {
    // This path IS its folder's folder-note, so its parent is ONE LEVEL UP: the
    // folder-note of the grandparent folder (or ROOT at the top level).
    const up = dir.lastIndexOf("/");
    if (up < 0) return null; // top-level folder -> parent is ROOT.
    const grandDir = dir.slice(0, up);
    return `${grandDir}/${baseSegment(grandDir)}.md`;
  }
  // A leaf (or a nested folder-note) sitting inside `dir`: its parent is `dir`'s
  // folder-note.
  return folderNote;
}

/**
 * Order CREATE actions so a create whose parent folder-note is ALSO being created
 * appears AFTER its parent (red-team #12). A child created before its fresh parent
 * cannot resolve the parent's pageId and would be placed at the space ROOT.
 * Topological over the `parentFolderFile` relation, restricted to paths within the
 * create set; an `inProgress` guard makes a malformed parent cycle safe.
 */
export function orderCreatesParentFirst(creates: CreateAction[]): CreateAction[] {
  const byPath = new Map<string, CreateAction>();
  for (const c of creates) byPath.set(c.path, c);
  const ordered: CreateAction[] = [];
  const visited = new Set<string>();
  const inProgress = new Set<string>();
  const visit = (c: CreateAction): void => {
    if (visited.has(c.path) || inProgress.has(c.path)) return;
    inProgress.add(c.path);
    const parent = parentFolderFile(c.path);
    if (parent !== null && parent !== c.path) {
      const parentCreate = byPath.get(parent);
      if (parentCreate) visit(parentCreate);
    }
    inProgress.delete(c.path);
    visited.add(c.path);
    ordered.push(c);
  };
  for (const c of creates) visit(c);
  return ordered;
}

/**
 * Whether a vault path is a Docmost PAGE file (design §"Adoption"): a `.md` file
 * with NO dot-segment anywhere in its path. This excludes `.obsidian/` config,
 * `.trash/`, dotfiles (`.foo.md`), and every non-`.md` file (attachments, JSON,
 * …) — Obsidian owns those; they live in the vault but are never pages. Used to
 * screen the PUSH diff so non-page files are never created/updated/deleted in
 * Docmost (and never get a `gitmost_id` frontmatter written into them).
 */
export function isPageFile(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  return !path.split("/").some((seg) => seg.startsWith("."));
}

/**
 * Git conflict-marker scan + strip (SPEC §9 — conflict markers must NEVER reach
 * Docmost). A body is treated as conflicted only when it carries BOTH a begin
 * (`<<<<<<<`) and an end (`>>>>>>>`) marker line, so a legitimate Markdown setext
 * heading underline (`=======`) is not mistaken for a conflict. When conflicted,
 * every marker line type is removed while the human-visible content is preserved
 * (no data loss): the marker SYNTAX never reaches Docmost, but the content does —
 * where the conflict is visible and fixable rather than silently dropped.
 *
 * `diff3`/`zdiff3` style: a conflict in that style adds a `|||||||` base section
 * (`|||||||` line + the merge-BASE content + `=======`). `ensureRepo` pins
 * `merge.conflictStyle=merge` so the engine never produces it, but a vault that
 * predates the pin — or content arriving via an external push that a human
 * committed in diff3 style — could still carry it. So we ALSO recognize the
 * `|||||||` marker and DROP the stale base region it introduces (between
 * `|||||||` and `=======`): the base text is neither side's current content, so
 * keeping it would inject obsolete lines AND leak a raw `|||||||` marker.
 */
const CONFLICT_BEGIN_LINE_RE = /^<{7}/;
const CONFLICT_BASE_LINE_RE = /^\|{7}/;
const CONFLICT_SEP_LINE_RE = /^={7}/;
const CONFLICT_END_LINE_RE = /^>{7}/;

// A code-fence open/close line (``` or ~~~), matching markdown-to-prosemirror's
// CODE_FENCE_RE. Used to make conflict-marker detection fence-aware.
const CONFLICT_CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

export function hasConflictMarkers(body: string): boolean {
  // Fence-aware scan (review #9). A page documenting git (a ```-fenced block that
  // literally contains `<<<<<<< HEAD` ... `>>>>>>>`) must NOT be flagged as a
  // conflict: with autoMergeConflicts OFF the all-or-nothing gate would then jam
  // the ENTIRE space's refs forever, re-failing the batch every cycle. Only count
  // begin/end marker lines that live OUTSIDE a fenced code block.
  let inFence = false;
  let fenceMarker = "";
  let sawBegin = false;
  for (const line of body.split("\n")) {
    const fence = line.match(CONFLICT_CODE_FENCE_RE);
    if (inFence) {
      // Close on a fence line of the same marker char, length >= the opener.
      if (
        fence &&
        fence[2][0] === fenceMarker[0] &&
        fence[2].length >= fenceMarker.length
      ) {
        inFence = false;
        fenceMarker = "";
      }
      continue; // everything inside a fence is inert
    }
    if (fence) {
      inFence = true;
      fenceMarker = fence[2];
      continue;
    }
    if (CONFLICT_BEGIN_LINE_RE.test(line)) sawBegin = true;
    else if (sawBegin && CONFLICT_END_LINE_RE.test(line)) return true;
  }
  return false;
}

function stripConflictMarkers(body: string): string {
  if (!hasConflictMarkers(body)) return body;
  // Track where we are inside a conflict block so a `=======` line is treated as
  // a conflict separator ONLY between a `<<<<<<<` begin and a `>>>>>>>` end — a
  // legitimate Markdown setext heading underline (`=======`) outside a conflict
  // block is preserved (review finding). State machine over the block:
  //   'no'   — outside any conflict block.
  //   'ours' — after `<<<<<<<`, before `|||||||`/`=======` (our side: KEEP).
  //   'base' — after `|||||||`, before `=======` (diff3 base region: DROP).
  //   'theirs' — after `=======`, before `>>>>>>>` (their side: KEEP).
  // Every marker LINE itself is dropped; only the base region's content is also
  // dropped (it is stale and not part of either current side).
  let state: "no" | "ours" | "base" | "theirs" = "no";
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (CONFLICT_BEGIN_LINE_RE.test(line)) {
      state = "ours";
      continue;
    }
    if (state !== "no" && CONFLICT_END_LINE_RE.test(line)) {
      state = "no";
      continue;
    }
    if (state === "ours" && CONFLICT_BASE_LINE_RE.test(line)) {
      state = "base";
      continue;
    }
    if ((state === "ours" || state === "base") && CONFLICT_SEP_LINE_RE.test(line)) {
      state = "theirs";
      continue;
    }
    // Drop the diff3 base region's content (stale, neither current side).
    if (state === "base") {
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** The last path segment of a forward-slash path (the folder/file base name). */
function baseSegment(path: string): string {
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
function titleFromPath(path: string): string {
  const base = baseSegment(path);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/**
 * The exact ` ~<slugId>` disambiguation suffix `buildVaultLayout`/`disambiguate`
 * append to a colliding sibling's file stem (layout.ts): a single trailing
 * ` ~<one path component>` (no slash, no further `~`). It is a COSMETIC, local
 * filesystem artifact — never part of the page's real Docmost title — so it is
 * stripped before a path-derived title is compared/pushed (red-team #4b).
 */
const DISAMBIGUATION_SUFFIX_RE = / ~[^/~]+$/;

/** Remove a single trailing ` ~<slugId>` disambiguation suffix, if present. */
function stripDisambiguationSuffix(title: string): string {
  return title.replace(DISAMBIGUATION_SUFFIX_RE, "");
}

/**
 * Build the synthetic `DocmostMdMeta` the planner/classifier consume, from the
 * NATIVE format: `pageId` from the `gitmost_id` frontmatter, `title` from the
 * filename, `spaceId` from the run (the vault's space — every file belongs to
 * it). `parentPageId` is intentionally absent: tree position is resolved from the
 * PATH (`resolveParentPageId`), never from a stored field (SPEC §5).
 */
function nativeMeta(
  text: string,
  path: string,
  spaceId: string,
): DocmostMdMeta {
  const { id } = parsePageFile(text);
  const meta: DocmostMdMeta = { version: 1, title: titleFromPath(path), spaceId };
  if (id) meta.pageId = id;
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
 * `parentPageId: null`, SPEC §16 "parentPageId: null -> to root").
 *
 * The IO is async, so this returns an ASYNC resolver; the call sites prefetch the
 * parent pageIds (the classifier itself stays pure/sync over a plain table).
 */
async function resolveParentPageIdViaTree(
  deps: Pick<ApplyPushDeps, "readFile" | "git">,
  path: string,
  side: MetaSide,
): Promise<string | null> {
  const parentFile = parentFolderFile(path);
  if (parentFile === null) return null; // root-level: parent is ROOT.
  let text: string | null;
  try {
    text =
      side === "current"
        ? await deps.readFile(parentFile)
        : await deps.git.showFileAtRef(LAST_PUSHED_REF, parentFile);
  } catch {
    // Parent folder file missing/unreadable at that side -> treat as ROOT.
    return null;
  }
  if (text === null) return null; // showFileAtRef returns null when absent.
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
async function metaAtViaTree(
  deps: Pick<ApplyPushDeps, "readFile" | "git">,
  path: string,
  side: MetaSide,
  spaceId: string,
): Promise<DocmostMdMeta | null> {
  let text: string | null;
  try {
    text =
      side === "current"
        ? await deps.readFile(path)
        : await deps.git.showFileAtRef(LAST_PUSHED_REF, path);
  } catch {
    return null;
  }
  if (text === null) return null;
  return nativeMeta(text, path, spaceId);
}

/**
 * Pull an `updatedAt` out of a create/update client result, if present. The
 * shape is `{ data: { updatedAt? }, ... }` (createPage) or a flatter object;
 * absent in the simple fakes, so the field is omitted rather than `undefined`.
 */
function extractUpdatedAt(result: unknown): { updatedAt?: string } {
  const r = result as
    | { updatedAt?: unknown; data?: { updatedAt?: unknown } }
    | null
    | undefined;
  const raw = r?.data?.updatedAt ?? r?.updatedAt;
  return typeof raw === "string" ? { updatedAt: raw } : {};
}

// --- runnable push orchestration (`runPush`) ---------------------------------
//
// `runPush` is the FS->Docmost twin of the pull direction: it wires the VaultGit
// diff/ref primitives + the PURE `computePushActions` planner + the THIN
// `applyPushActions` applier into one runnable cycle. It is driven IN-PROCESS by
// the NestJS server (there is no standalone CLI). SAFE BY DEFAULT — a cycle
// defaults to DRY-RUN (plan only, NO Docmost writes, NO ref advance) unless the
// caller passes `opts.dryRun === false`; that apply path is the ONLY one that
// builds a client and mutates Docmost.
//
// Every external effect is injected (`PushDeps`): production wires the live
// Docmost client, git, and fs; tests substitute FAKES through the same seam.

/**
 * The human ("local") git identity used for engine-made commits on `main` in the
 * push direction (SPEC §7.3). The provenance is carried by the trailer (below),
 * which the loop-guard keys on; the identity is for history readability only.
 * When the vault repo already has a configured `user.name`/`user.email`, git
 * uses that for the working-tree commit; this is the fallback the engine stamps.
 */
export const LOCAL_AUTHOR_NAME = "Local";
export const LOCAL_AUTHOR_EMAIL = "local@local";

/** The provenance trailer marking a `main`-side (human/local) commit (SPEC §7.3). */
export const LOCAL_SOURCE_TRAILER = "Docmost-Sync-Source: local";

/**
 * Injectable deps for `runPush` (mirrors `pull.ts`'s wiring; everything that
 * touches the outside world is here so tests pass fakes). `makeClient` is a
 * FACTORY, not a client — a dry-run must build NO client at all (it is never
 * called), and only the apply path (`opts.dryRun === false`) invokes it.
 */
export interface PushDeps {
  settings: Settings;
  git: Pick<
    VaultGit,
    | "assertGitAvailable"
    | "ensureRepo"
    | "isMergeInProgress"
    | "checkout"
    | "stageAll"
    | "commit"
    | "readRef"
    | "revParse"
    | "diffNameStatus"
    | "showFileAtRef"
    | "updateRef"
    | "fastForwardBranch"
    | "listTrackedFiles"
  >;
  /** Build a real client — called ONLY on the apply path, never on dry-run. */
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
  base?: { ref: string; source: "last-pushed" | "docmost"; sha: string | null };
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
  /** The applier's structured result — ONLY present on the apply path. */
  applied?: ApplyPushResult;
  /**
   * True when `applyPushActions` REFUSED to fast-forward a divergent `docmost`
   * mirror (SPEC §5 invariant broken). Logged prominently and surfaced on this
   * result so the caller (the server orchestrator) escalates it.
   */
  divergentDocmost?: boolean;
  /** Per-page failures from the applier (empty/absent on a clean run). */
  failures?: PushFailure[];
}

/**
 * Run one FS->Docmost push cycle (SPEC §6 "FS -> Docmost"), DRY-RUN BY DEFAULT
 * (the apply path runs only when `opts.dryRun === false`).
 *
 * Steps (mirrors `pull.ts`):
 *   1. Preflight git: `assertGitAvailable` + `ensureRepo`; ABORT (clear message +
 *      an `aborted: "merge-in-progress"` result) if a merge is in progress —
 *      never push on top of an
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
 *   7. Apply path (`opts.dryRun === false`): build the client, run `applyPushActions(..., pushedCommit=main)`,
 *      then (a) if any pageIds were written back (creates), commit them on `main`
 *      with the `local` trailer and RE-advance `refs/docmost/last-pushed` to the
 *      new commit so the recorded pageIds are persisted in what Docmost mirrors;
 *      (b) ESCALATE a divergent-`docmost` ff refusal (SPEC §5) with a prominent
 *      WARNING and the `divergentDocmost` result flag. Then log a one-line summary.
 */
export async function runPush(
  deps: PushDeps,
  opts: { dryRun: boolean },
): Promise<PushRunResult> {
  const { git, settings, log } = deps;
  const dryRun = opts.dryRun;

  // 1. Preflight git. Fail fast (the thrown error propagates to the caller) if
  //    the git binary is missing — the vault state store relies on it.
  await git.assertGitAvailable();
  await git.ensureRepo();

  // 1b. Refuse to push on top of an unresolved merge (SPEC §9/§12). A previous
  //     conflicting pull leaves the vault mid-merge; pushing now could leak
  //     conflict markers into Docmost (SPEC §9, the cardinal invariant). Detect
  //     it BEFORE any checkout/diff and stop with a clear, actionable message so
  //     re-runs converge once the human resolves (or aborts) the merge.
  if (await git.isMergeInProgress()) {
    log(
      `push: vault has an unresolved merge at ${settings.vaultPath} — resolve ` +
        `it (or 'git merge --abort') and re-run. Nothing was pushed to Docmost ` +
        `(conflict markers must never reach Docmost, SPEC §9).`,
    );
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
    log(
      `push: committed local working-tree changes on main` +
        (sha ? ` as ${sha.slice(0, 8)}` : "") +
        ` (local git only — nothing sent to Docmost).`,
    );
  } else {
    log("push: working tree clean (no local changes to push).");
  }

  // 4. Pick the diff BASE (SPEC §5/§6): `refs/docmost/last-pushed` if it resolves
  //    (the marker of what `main` is already in Docmost), else fall back to the
  //    `docmost` mirror branch (the mirror of what Docmost currently has) — which
  //    is what exists before the first push ever advanced last-pushed.
  let base: { ref: string; source: "last-pushed" | "docmost"; sha: string | null };
  const lastPushedSha = await git.readRef(LAST_PUSHED_REF);
  if (lastPushedSha) {
    base = { ref: LAST_PUSHED_REF, source: "last-pushed", sha: lastPushedSha };
  } else {
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
  const metaTable = new Map<string, DocmostMdMeta | null>();
  for (const change of changes) {
    // `current`: A/M/R/C still have the file on `main`. `prev`: D needs the
    // pre-image; R/C also benefit (old title). Prefetch both sides per path.
    const currentPath = change.path;
    const prevPath = change.oldPath ?? change.path;
    if (!metaTable.has(`${currentPath}|current`)) {
      metaTable.set(
        `${currentPath}|current`,
        await readMetaCurrent(deps, currentPath, settings.docmostSpaceId),
      );
    }
    if (!metaTable.has(`${prevPath}|prev`)) {
      metaTable.set(
        `${prevPath}|prev`,
        await readMetaPrev(deps, base.ref, prevPath, settings.docmostSpaceId),
      );
    }
  }
  const metaAt = (path: string, side: MetaSide): DocmostMdMeta | null =>
    metaTable.get(`${path}|${side}`) ?? null;

  // The set of pageIds that STILL EXIST somewhere in the current `main` tree.
  // Identity is the pageId, NOT the filename: a file vanishing from one path
  // while the SAME pageId lives at another path is a MOVE (often a layout
  // reshuffle of `_`-fallback names, whose two halves can even land in separate
  // cycles), never a deletion. Built only when the diff contains deletes — the
  // guard's whole job is to stop a phantom delete from trashing a live page.
  let currentPageIds: Set<string> | undefined;
  if (changes.some((c) => c.status === "D")) {
    currentPageIds = new Set<string>();
    for (const relPath of await git.listTrackedFiles("*.md")) {
      const pid = (await readMetaCurrent(deps, relPath, settings.docmostSpaceId))
        ?.pageId;
      if (pid) currentPageIds.add(pid);
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

  // 7. Apply path: build the REAL client and execute. This is the ONLY write path.
  const client = deps.makeClient(settings);
  const applied = await applyPushActions(
    {
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
      // Per-space PUSH policy for still-conflicted bodies (SPEC §9). Default OFF:
      // a conflicted page is skipped (recorded as a failure) instead of pushed.
      autoMergeConflicts: settings.autoMergeConflicts ?? false,
    },
    actions,
    pushedCommit,
  );

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
          log(
            `push: WARNING — the 'docmost' mirror branch DIVERGED and was NOT ` +
              `fast-forwarded to the pageId write-back commit ` +
              `(${ff.reason ?? "not-fast-forward"}). The §5 invariant ('docmost' ` +
              `mirrors what Docmost contains) is broken: reconcile 'docmost' ` +
              `against the live Docmost tree before the next cycle.`,
          );
        }
      }
    }
  }

  // 7b. ESCALATE a divergent-`docmost` fast-forward refusal (SPEC §5 invariant
  //     broken). The applier already refused to clobber a divergent mirror; make
  //     it LOUD (not silent) so the operator notices, and fold it into the exit.
  if (applied.docmostFastForward && !applied.docmostFastForward.ok) {
    divergentDocmost = true;
    log(
      `push: WARNING — the 'docmost' mirror branch DIVERGED and was NOT ` +
        `fast-forwarded (${applied.docmostFastForward.reason ?? "not-fast-forward"}). ` +
        `The §5 invariant ('docmost' mirrors what Docmost contains) is broken: ` +
        `reconcile 'docmost' against the live Docmost tree before the next cycle.`,
    );
  }

  // 7c. One-line summary (mirrors pull.ts's summary line).
  log(
    `push complete: ${applied.created} created, ${applied.updated} updated, ` +
      `${applied.deleted} deleted, ${applied.moved} moved, ${applied.renamed} ` +
      `renamed, ${applied.noops.length} no-op(s), ${applied.skipped.length} ` +
      `skipped, ${applied.failures.length} failure(s)` +
      (divergentDocmost ? " [DIVERGENT docmost mirror]" : ""),
  );

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
async function readMetaCurrent(
  deps: Pick<PushDeps, "readFile">,
  path: string,
  spaceId: string,
): Promise<DocmostMdMeta | null> {
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch {
    return null; // absent on disk (e.g. a D row's path) -> no current meta.
  }
  return nativeMeta(text, path, spaceId);
}

/** Synthetic native meta from the base ref's pre-image (`prev` side). */
async function readMetaPrev(
  deps: Pick<PushDeps, "git">,
  baseRef: string,
  path: string,
  spaceId: string,
): Promise<DocmostMdMeta | null> {
  let text: string | null;
  try {
    text = await deps.git.showFileAtRef(baseRef, path);
  } catch {
    return null;
  }
  if (text === null) return null; // path absent at the base ref.
  return nativeMeta(text, path, spaceId);
}

/** Emit the full plan (counts + per-item) to the injected logger. */
function logPlan(
  log: (line: string) => void,
  base: { ref: string; source: string; sha: string | null },
  pushedCommit: string,
  actions: PushActions,
  planned: PushRunResult["planned"],
  dryRun: boolean,
): void {
  log(
    `push plan (${dryRun ? "DRY-RUN — no Docmost writes" : "APPLY"}): base=` +
      `${base.ref} (${base.source}${base.sha ? ` ${base.sha.slice(0, 8)}` : ""}) ` +
      `-> main ${pushedCommit.slice(0, 8)}`,
  );
  log(
    `push plan counts: ${planned!.creates} create, ${planned!.updates} update, ` +
      `${planned!.deletes} delete, ${planned!.renamesMoves} rename/move, ` +
      `${planned!.skipped} skipped`,
  );
  for (const c of actions.creates) log(`  create: ${c.path}`);
  for (const u of actions.updates) log(`  update: ${u.pageId} (${u.path})`);
  for (const d of actions.deletes) log(`  delete: ${d.pageId}`);
  for (const rm of actions.renamesMoves)
    log(`  rename/move: ${rm.oldPath} -> ${rm.newPath} (${rm.pageId})`);
  for (const s of actions.skipped)
    log(`  skipped [${s.status}] ${s.path}: ${s.reason}`);
}
