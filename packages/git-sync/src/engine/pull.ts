/**
 * Pull cycle — Docmost -> vault (SPEC §6 "Docmost -> FS").
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
import {
  markdownToProseMirror,
  parsePageFile,
  serializePageFile,
} from "@docmost/prosemirror-markdown";
import type { GitSyncClient } from "./client.types.js";
import { buildVaultLayout, type PageNode } from "./layout.js";
import {
  VaultGit,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
} from "./git.js";
import {
  planReconciliation,
  decideAbsenceDeletions,
  type LiveEntry,
  type MovedEntry,
  type DeletionDecision,
} from "./reconcile.js";
import { stabilizePageBody } from "./stabilize.js";
import { isPageFile } from "./push.js";
import { gitCopyStem } from "./sanitize.js";

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
function relToAbs(vaultRoot: string, relPath: string): string {
  return [vaultRoot, ...relPath.split("/")].join("/");
}

/**
 * Canonicalize a file's TRAILING whitespace: drop any trailing blank /
 * whitespace-only lines (and trailing spaces on the last line) and end with
 * exactly one newline; an empty body becomes a single "\n". This matches
 * `serializePageFile`'s trailing form (`body.trim()` + a single "\n").
 *
 * Why (SPEC §9 spurious-conflict fix): the engine writes pages in their
 * normalize-on-write form (one trailing newline), but a user can push a `.md` to
 * `main` with EXTRA trailing/empty lines (e.g. a double-blank-line append). When
 * the docmost mirror (normalized) and `main` (raw) both change near end-of-file,
 * git's line-based 3-way merge reports a CONFLICT even though the only difference
 * is trailing blank lines. Normalizing BOTH sides before comparing collapses that
 * difference to nothing, so the pull cycle can recognize the conflict as SPURIOUS
 * and resolve it cleanly instead of committing raw conflict markers onto `main`.
 */
function normalizeTrailingWhitespace(text: string): string {
  const body = text.replace(/[\s﻿]+$/, "");
  return body.length > 0 ? `${body}\n` : "\n";
}

/** Convert an absolute/relative segment list under the vault to a relPath. */
function segmentsToRelPath(segments: string[], stem: string): string {
  return [...segments, `${stem}.md`].join("/");
}

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
export async function readExisting(
  deps: ReadExistingDeps,
): Promise<{ pageId: string; relPath: string }[]> {
  const tracked = await deps.listTracked();
  const existing: { pageId: string; relPath: string }[] = [];
  for (const relPath of tracked) {
    // git ls-files always emits forward-slash paths; normalize just in case.
    const rel = relPath.split(sep).join("/");
    let text: string;
    try {
      text = await deps.readFile(rel);
    } catch {
      // Tracked but missing on disk (mid-operation race) — skip; the next pull
      // converges.
      continue;
    }
    const { id } = parsePageFile(text);
    if (id) existing.push({ pageId: id, relPath: rel });
  }
  return existing;
}

/**
 * Input to the PURE `computePullActions` (R-Pull-2). All data, no IO: the live
 * tree nodes + completeness flag (from `listSpaceTree`) and the parsed
 * `existing` tracked files (from `readExisting`).
 */
export interface PullActionsInput {
  /**
   * Live page nodes for the space (from `listSpaceTree`). `updatedAt` feeds the
   * export key; a node without it is never treated as unchanged.
   */
  pages: (PageNode & { updatedAt?: string })[];
  /** Whether the live tree fetch was COMPLETE (SPEC §8 suppression). */
  treeComplete: boolean;
  /** Parsed tracked files: `{ pageId, relPath }` (from `readExisting`). */
  existing: { pageId: string; relPath: string }[];
  /**
   * The subset of tracked pageIds that correspond to a REAL page row (D-P3-1
   * ghost guard, from `client.pageIdsExist`). Only ids in this set may be
   * absence-deleted; a ghost id (never a page) is preserved. When omitted, all
   * absent ids are deletable (the historical behavior; pure unit callers that
   * do not model ghosts).
   */
  deletableIds?: string[];
  /**
   * pageId -> export key recorded after that page's last SUCCESSFUL export
   * (owned by the caller, see `RunCycleDeps.exportKeys`). A live page whose
   * current key equals its recorded key AND whose file is tracked at its relPath
   * is left out of `toWrite` (no `getPageJson`, no conversion). Omitted -> every
   * live page is written (a full pass).
   */
  exportKeys?: ReadonlyMap<string, string>;
}

/**
 * The export key of a live page: everything that decides the exported file —
 * the body version (`updatedAt`), its location (`relPath`, which already folds
 * in the ancestor names, the folder-note shape and sibling disambiguation) and
 * the node's own tree fields. The file itself carries only `gitmost_id` + the
 * body (`serializePageFile`). `null` when the node has no `updatedAt`: such a
 * page can never be proven unchanged, so it is always exported.
 */
export function exportKeyOf(
  node: PageNode & { updatedAt?: string },
  relPath: string,
): string | null {
  if (typeof node.updatedAt !== "string" || node.updatedAt.length === 0) {
    return null;
  }
  return JSON.stringify([
    node.updatedAt,
    relPath,
    node.title ?? null,
    node.slugId ?? null,
    node.parentPageId ?? null,
  ]);
}

/**
 * The PURE decisions object computed by `computePullActions` (no IO). It holds
 * the reconciliation plan plus the SPEC §8 absence-deletion decision, with the
 * suppression already folded in: `toDelete` is the POST-suppression set the
 * caller should actually remove (empty when `deletionDecision.apply` is false).
 */
export interface PullActions {
  /**
   * Pages to (re)write at their relPath (add + update + move target). Excludes
   * live pages proven unchanged by `PullActionsInput.exportKeys`.
   */
  toWrite: { pageId: string; relPath: string }[];
  /**
   * The CURRENT export key of every live page that has one (see `exportKeyOf`).
   * The caller records these after the cycle commits the exports.
   */
  liveExportKeys: Map<string, string>;
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
export function computePullActions(input: PullActionsInput): PullActions {
  const { pages, treeComplete, existing, deletableIds, exportKeys } = input;
  const layout = buildVaultLayout(pages);

  const live: LiveEntry[] = [];
  const liveExportKeys = new Map<string, string>();
  for (const p of pages) {
    if (!p || !p.id) continue;
    const entry = layout.get(p.id);
    if (!entry) continue;
    const relPath = segmentsToRelPath(entry.segments, entry.stem);
    live.push({ pageId: p.id, relPath });
    const key = exportKeyOf(p, relPath);
    if (key !== null) liveExportKeys.set(p.id, key);
  }

  // Plan reconciliation (pure). `plan.toDelete` is ABSENCE-based only;
  // `plan.moved` carries move old-path removals separately. The ghost guard
  // (D-P3-1) gates absence-deletes to ids that are a real page row; when
  // `deletableIds` is omitted, all absent ids are deletable (historical).
  const plan = planReconciliation(
    live,
    existing,
    deletableIds === undefined ? undefined : new Set(deletableIds),
  );

  // Decide whether the ABSENCE-based deletions may be applied this cycle
  // (SPEC §8): incomplete-fetch suppression + empty-live + mass-delete guard.
  // Moves are NOT governed by this.
  const deletionDecision = decideAbsenceDeletions({
    treeComplete,
    liveCount: live.length,
    existingCount: existing.length,
    deleteCount: plan.toDelete.length,
  });

  // Change detection: skip a live page whose export key is unchanged since its
  // last successful export AND whose file is still tracked at that exact path
  // (a deleted/moved/never-written file is re-exported even with a matching key).
  const trackedAt = new Set(existing.map((e) => `${e.pageId}\u0000${e.relPath}`));
  const toWrite = exportKeys
    ? plan.toWrite.filter((w) => {
        const key = liveExportKeys.get(w.pageId);
        const unchanged =
          key !== undefined &&
          exportKeys.get(w.pageId) === key &&
          trackedAt.has(`${w.pageId}\u0000${w.relPath}`);
        return !unchanged;
      })
    : plan.toWrite;

  return {
    toWrite,
    liveExportKeys,
    moved: plan.moved,
    // Fold the suppression in: a suppressed cycle deletes nothing.
    toDelete: deletionDecision.apply ? plan.toDelete : [],
    deletionDecision,
    existingCount: existing.length,
    plannedDeleteCount: plan.toDelete.length,
  };
}

/**
 * Injectable IO for `applyPullActions` (R-Pull-2). The real `main` wires these
 * to the live client, the vault git wrapper, and `node:fs/promises`; tests pass
 * fakes that RECORD calls so the ordering + the move-on-success data-loss guard
 * are testable without real git/fs/network.
 */
export interface ApplyPullActionsDeps {
  client: Pick<GitSyncClient, "getPageJson">;
  git: Pick<
    VaultGit,
    | "stageAll"
    | "commit"
    | "checkout"
    | "merge"
    | "listUnmergedPaths"
    | "commitMerge"
    | "showStage"
    | "mergeFileOurs"
    | "pageIdsAtRef"
    | "showFileAtRef"
    | "listTrackedFiles"
    | "mergeBase"
    | "revParse"
    | "isMergeInProgress"
    | "diffNameStatus"
  >;
  /** Write a file by ABSOLUTE path; its parent directory must exist. */
  writeFile: (absPath: string, text: string) => Promise<void>;
  /** Recursive mkdir of an ABSOLUTE directory path. */
  mkdir: (absDir: string) => Promise<void>;
  /** Remove a file by ABSOLUTE path (force: a missing file is a no-op). */
  rm: (absPath: string) => Promise<void>;
  /**
   * Injected logger for cycle diagnostics (mirrors the push side). Optional —
   * falls back to `console.log` so existing callers stay green.
   */
  log?: (line: string) => void;
  /** Injected WARN-level logger; falls back to `log`. */
  warn?: (line: string) => void;
}

/** Outcome counters from `applyPullActions` (for the summary + tests). */
export interface ApplyResult {
  written: number;
  movedApplied: number;
  deleted: number;
  failed: number;
  /** pageIds whose fetch/convert/write FAILED this pull (never recorded as exported). */
  failedPageIds: string[];
  committed: boolean;
  merge: { ok: boolean; conflict: boolean; output: string };
  /**
   * Vault-relative paths of the page(s) that had a GENUINE conflict in the
   * docmost -> main merge and were AUTO-RESOLVED (conflicting hunks to the
   * git/main side, SPEC §9) — committed CLEAN, never with raw conflict markers. Empty on a
   * clean merge AND when the only conflicts were spurious trailing-whitespace
   * differences (those are normalized, not reported). Surfaced for logging /
   * /status visibility; the docmost-side content stays recoverable via the
   * `docmost` branch + page history.
   */
  conflictedPaths: string[];
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
export async function applyPullActions(
  deps: ApplyPullActionsDeps,
  actions: PullActions,
  vaultRoot: string,
): Promise<ApplyResult> {
  const { client, git } = deps;
  // One channel, mirroring the push side: route every cycle diagnostic through
  // the injected logger; fall back to `console.log` when none is supplied.
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? log;

  // Emit the SPEC §8 suppression warnings (preserved from the original `main`).
  const decision = actions.deletionDecision;
  if (!decision.apply) {
    if (decision.reason === "incomplete-fetch") {
      log(
        "pull: tree fetch incomplete — deletions suppressed this cycle (SPEC §8)",
      );
    } else if (decision.reason === "empty-live") {
      log(
        `pull: live fetch returned 0 pages but ${actions.existingCount} file(s) are ` +
          `tracked — deletions suppressed this cycle (SPEC §8). Re-run when ` +
          `Docmost is reachable.`,
      );
    } else {
      log(
        `pull: plan would delete ${actions.plannedDeleteCount} of ${actions.existingCount} ` +
          `tracked file(s) (mass-delete guard) — deletions suppressed this ` +
          `cycle (SPEC §8). Verify the live Docmost tree, then re-run.`,
      );
    }
  }

  // 1. Write each live page in its fixpoint form (normalize-on-write, SPEC §11).
  let written = 0;
  let failed = 0;
  let completed = 0;
  let nextIndex = 0;
  // pageIds whose write FAILED. A moved page whose new-path write failed must
  // NOT have its old path removed (otherwise the page vanishes entirely).
  const failedPageIds = new Set<string>();

  const writeOne = async (w: {
    pageId: string;
    relPath: string;
  }): Promise<void> => {
    try {
      const page = await client.getPageJson(w.pageId);
      // Native-Obsidian format: a minimal `gitmost_id` frontmatter + the fixpoint
      // markdown body. title/parent/space are DERIVED (filename / folder / repo),
      // so nothing but the pageId is persisted as meta.
      const text = serializePageFile(
        page.id,
        await stabilizePageBody(page.content),
      );
      const abs = relToAbs(vaultRoot, w.relPath);
      await deps.mkdir(dirname(abs));
      await deps.writeFile(abs, text);
      written++;
    } catch (err) {
      failed++;
      failedPageIds.add(w.pageId);
      log(
        `pull: failed page ${w.pageId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      completed++;
      if (completed % PROGRESS_EVERY === 0) {
        log(`pulled ${completed}/${actions.toWrite.length}`);
      }
    }
  };

  // Bounded-concurrency pool (dependency-free): a fixed set of runners each
  // take the next index until the write list is exhausted. One bad page never
  // aborts the whole pull (mirrors the fault-tolerant tree walk).
  const runner = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= actions.toWrite.length) return;
      await writeOne(actions.toWrite[i]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, actions.toWrite.length) || 1 },
      () => runner(),
    ),
  );

  // Helper: `rm` with force:true is a no-op if the file is already gone.
  const removePath = async (rel: string, what: string): Promise<boolean> => {
    try {
      await deps.rm(relToAbs(vaultRoot, rel));
      return true;
    } catch (err) {
      log(
        `pull: failed to ${what} ${rel}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
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
    if (!m.removeOldPath) continue;
    if (failedPageIds.has(m.pageId)) {
      log(
        `pull: move write for ${m.pageId} failed — keeping old path ` +
          `${m.fromRelPath} (SPEC §8)`,
      );
      continue;
    }
    if (await removePath(m.fromRelPath, "remove moved old path")) movedApplied++;
  }

  // 3. Apply ABSENCE-based deletions — `actions.toDelete` is ALREADY the
  //    post-suppression set (empty when the decision suppressed them, SPEC §8).
  let deleted = 0;
  for (const rel of actions.toDelete) {
    if (await removePath(rel, "delete")) deleted++;
  }

  // 4. Stage + commit on `docmost` (only if there is something to commit).
  //    Deterministic stabilized output means unchanged pages produce identical
  //    bytes -> git sees no diff -> no churn (SPEC §11). The subject reflects the
  //    ACTUAL work applied (pages written + files deleted), not the planned size,
  //    so a run with failures does not over-report (SPEC §5 nit).
  const subject =
    deleted > 0
      ? `docmost: sync ${written} page(s), ${deleted} deleted`
      : `docmost: sync ${written} page(s)`;
  await git.stageAll();
  const committed = await git.commit(subject, {
    authorName: BOT_AUTHOR_NAME,
    authorEmail: BOT_AUTHOR_EMAIL,
    trailers: [SOURCE_TRAILER],
  });

  // Merge docmost -> main. A CONFLICT must NOT wedge the whole space (the
  // reported bug: ONE same-line conflict on ONE page froze sync for EVERY page
  // in both directions because the next cycle's `isMergeInProgress` check kept
  // skipping the entire space). It must ALSO never commit raw `<<<<<<<`/`>>>>>>>`
  // markers onto the published `main` (round-1 round-2: external clones would see
  // the markers AND the body re-conflicts every cycle while git and Docmost
  // silently diverge). So on a conflict we RESOLVE each conflicted file to a
  // clean, marker-free form and commit that (SPEC §9):
  //
  //   - SPURIOUS conflict — the ROOT CAUSE of the leak: the two sides differ ONLY
  //     in trailing/empty-line normalization (the engine writes one trailing
  //     newline; a user pushed extra blank lines). Once both sides are
  //     `normalizeTrailingWhitespace`d they are IDENTICAL, so this is no real
  //     conflict at all: write the normalized form. Content stays in sync; git
  //     and the page never diverge.
  //   - GENUINE content conflict: resolve PER HUNK — only the hunks BOTH sides
  //     changed take OURS (the `main`/git side, mirroring the live-doc 3-way "git
  //     wins" rule); every hunk only Docmost changed is kept. Writing OURS whole
  //     would make the push (diffed from the `docmost` tip) revert Docmost's
  //     edits in blocks git never touched. The docmost-side text of the
  //     conflicting hunks stays on the `docmost` branch and in page history.
  //     add/add (no common ancestor) keeps the Docmost side and git's version
  //     as a new sibling file — see below. No markers ever reach `main`.
  await git.checkout(DEFAULT_BRANCH);
  // IDENTITY (the gitmost_id), not the path, decides which page a file holds.
  // The merge below is path-based (rename detection off), so `main` is first
  // ALIGNED to the paths Docmost gave its pages since the merge base: then each
  // path holds the same page on both sides, and a path Docmost handed to another
  // page (a retitle freeing a bare name, a removed page's name reused) never
  // merges one page's edits into another. Skipped when either side has nothing
  // of its own since the merge base (a no-op or fast-forward merge).
  const mergeBaseSha = await git.mergeBase(DOCMOST_BRANCH, DEFAULT_BRANCH);
  const ident =
    mergeBaseSha !== null &&
    mergeBaseSha !== (await git.revParse(DOCMOST_BRANCH)) &&
    mergeBaseSha !== (await git.revParse(DEFAULT_BRANCH))
      ? {
          mb: mergeBaseSha,
          base: await idPathMap(git, mergeBaseSha),
          doc: await idPathMap(git, DOCMOST_BRANCH),
        }
      : null;
  if (ident !== null) {
    await alignToDocmostLayout(deps, ident, vaultRoot, log, warn);
  }
  // The `main` side of the merge (after the alignment commit).
  const oursSha = await git.revParse(DEFAULT_BRANCH);
  const merge = await git.merge(DOCMOST_BRANCH);
  let conflictedPaths: string[] = [];
  let mergeResult = merge;
  const unmerged = merge.conflict ? await git.listUnmergedPaths() : [];
  // Pages git moved keep git's path; paths settled there are skipped below.
  const settled = new Set<string>();
  const relocated =
    ident !== null && oursSha !== null && (merge.ok || merge.conflict)
      ? await relocateGitMovedPages(
          deps,
          ident,
          oursSha,
          new Set(unmerged),
          settled,
          vaultRoot,
        )
      : [];
  if (merge.conflict) {
    const genuine: string[] = [];
    const addAdd: string[] = [];
    const adopted: string[] = [];
    let normalized = 0;
    // Paths taken in the merge result (lazily listed on the first add/add).
    let taken: Set<string> | null = null;
    for (const rel of unmerged) {
      if (settled.has(rel)) continue;
      const ours = await git.showStage(2, rel); // main side
      const theirs = await git.showStage(3, rel); // docmost side
      if (
        ours !== null &&
        theirs !== null &&
        normalizeTrailingWhitespace(ours) === normalizeTrailingWhitespace(theirs)
      ) {
        // SPURIOUS: identical once trailing/empty-line normalization is applied.
        // Commit the canonical (normalized) form — no conflict, no markers.
        normalized++;
        await writeVaultFile(deps, vaultRoot, rel, normalizeTrailingWhitespace(theirs));
      } else {
        const base = await git.showStage(1, rel);
        let resolved: string | null;
        const pageBase =
          ours !== null && theirs !== null
            ? await pageMergeBase(git, ident, base, ours, theirs)
            : null;
        if (ours !== null && theirs !== null && pageBase !== null) {
          // One page, both sides changed it: per hunk, git wins only the
          // conflicting hunks. The engine writes exactly one trailing newline; a
          // git side that drops it or adds blank lines would otherwise "change"
          // the last line and win that hunk over a Docmost edit of the last block.
          const merged = await git.mergeFileOurs(
            normalizeTrailingWhitespace(pageBase),
            normalizeTrailingWhitespace(ours),
            normalizeTrailingWhitespace(theirs),
          );
          resolved = merged.text;
          // A clean merge of one page (e.g. a path new on both sides after the
          // alignment) is not a conflict.
          if (merged.conflicts > 0) genuine.push(rel);
        } else if (ours !== null && theirs !== null) {
          const adoptId = await unfinishedCreateId(client, ident, ours, theirs);
          if (adoptId !== null) {
            // git-sync's own create of git's new file, cut off before its id
            // write-back: ONE page — git's content under that page's id; the
            // push then writes git's body into that page.
            resolved = normalizeTrailingWhitespace(
              serializePageFile(adoptId, parsePageFile(ours).body),
            );
            adopted.push(rel);
          } else {
            // add/add, or two different pages at one path: nothing tells which
            // blocks git changed, and OURS would push git's whole body over the
            // page. Keep the Docmost side at the path and keep git's version as
            // a NEW file at a disambiguated sibling path, its gitmost_id
            // stripped so the push creates it as a new page.
            genuine.push(rel);
            resolved = theirs;
            if (taken === null) taken = new Set(await git.listTrackedFiles());
            const copy = freeGitSibling(rel, taken);
            await writeVaultFile(
              deps,
              vaultRoot,
              copy,
              normalizeTrailingWhitespace(parsePageFile(ours).body),
            );
            addAdd.push(`${rel} -> ${copy}`);
          }
        } else {
          // modify/delete: keep the remaining content. delete/delete: nothing to
          // write; commitMerge's `git add -A` stages the deletion.
          genuine.push(rel);
          resolved = ours ?? theirs;
        }
        if (resolved !== null) {
          await writeVaultFile(deps, vaultRoot, rel, resolved);
        }
      }
    }
    conflictedPaths = genuine;
    await git.commitMerge(
      genuine.length > 0
        ? `docmost: sync, ${genuine.length} page(s) auto-resolved (conflicting hunks to git, SPEC §9)`
        : normalized > 0
          ? `docmost: sync (trailing-whitespace conflicts normalized, SPEC §9)`
          : `docmost: sync, ${unmerged.length} path(s) merged by page identity`,
      {
        authorName: BOT_AUTHOR_NAME,
        authorEmail: BOT_AUTHOR_EMAIL,
        trailers: [SOURCE_TRAILER],
      },
    );
    // The committed tree is CLEAN (every conflicted file was overwritten with a
    // marker-free resolution). `conflict` now reflects only the GENUINE conflicts
    // that were auto-resolved (git won); a merge that conflicted ONLY on trailing
    // whitespace is reported as clean so /status does not cry wolf.
    mergeResult = { ok: true, conflict: genuine.length > 0, output: merge.output };
    if (adopted.length > 0) {
      warn(
        `pull: git's new file(s) took over the page git-sync had created ` +
          `for them before an interruption cut off the id write-back (one ` +
          `page each, no copy): ${adopted.join(", ")}.`,
      );
    }
    if (genuine.length > 0) {
      log(
        `pull: merge of docmost -> main had ${genuine.length} GENUINE conflict(s) ` +
          `auto-resolved per hunk — only the conflicting hunks take the git/main ` +
          `side (git wins, SPEC §9): ${genuine.join(", ")}. NO conflict markers ` +
          `were written to main; the docmost-side text of those hunks is on the ` +
          `'docmost' branch and recoverable via page history.`,
      );
      if (addAdd.length > 0) {
        warn(
          `pull: add/add conflict(s) kept the DOCMOST version at the path (no ` +
            `common ancestor to tell which blocks git changed); the git version ` +
            `was kept as a new file (created as a new page by the push): ` +
            `${addAdd.join(", ")}.`,
        );
      }
    } else if (normalized > 0) {
      log(
        `pull: merge of docmost -> main conflicted ONLY on trailing/empty-line ` +
          `normalization (${normalized} file(s)) — auto-normalized, no ` +
          `markers, content stays in sync (SPEC §9 spurious-conflict fix).`,
      );
    }
  } else if (!merge.ok) {
    log(`pull: merge of docmost -> main failed: ${merge.output}`);
  } else if (await git.isMergeInProgress()) {
    // A clean non-fast-forward merge stops before committing (VaultGit.merge):
    // commit it, with the relocations above, as one merge commit.
    await git.commitMerge(
      relocated.length > 0
        ? `docmost: sync, ${relocated.length} page(s) kept at git's path`
        : `Merge branch '${DOCMOST_BRANCH}'`,
      {
        authorName: BOT_AUTHOR_NAME,
        authorEmail: BOT_AUTHOR_EMAIL,
        trailers: [SOURCE_TRAILER],
      },
    );
  }
  if (relocated.length > 0) {
    log(
      `pull: page(s) git moved keep git's path, their Docmost edits merged per ` +
        `hunk: ${relocated.join(", ")}.`,
    );
  }

  return {
    written,
    movedApplied,
    deleted,
    failed,
    failedPageIds: [...failedPageIds],
    committed,
    merge: mergeResult,
    conflictedPaths,
  };
}

/** Write a vault file by relative path, creating its parent directory first. */
async function writeVaultFile(
  deps: Pick<ApplyPullActionsDeps, "mkdir" | "writeFile">,
  vaultRoot: string,
  rel: string,
  text: string,
): Promise<void> {
  const abs = relToAbs(vaultRoot, rel);
  await deps.mkdir(dirname(abs));
  await deps.writeFile(abs, text);
}

/** Page identity around one pull merge: the merge base and id -> path maps. */
interface MergeIdentity {
  mb: string;
  /** Page id -> its file path at the merge base. */
  base: Map<string, string>;
  /** Page id -> its file path at the `docmost` tip. */
  doc: Map<string, string>;
}

/**
 * The id of the Docmost page at an add/add path when that page is git-sync's
 * own unfinished create of git's new file there (cut off before its id
 * write-back, with or without its body written): git's file has no
 * gitmost_id, the page is new since the merge base, last written by git-sync,
 * and still empty or already holding git's body. `null` otherwise.
 *
 * Taking a page over writes git's body into it, so the body check keeps that
 * from changing anything the page holds: a page that only looks like such a
 * create (restored from the trash, or every page of a re-made vault) keeps its
 * own text, and git's file becomes a copy.
 */
async function unfinishedCreateId(
  client: Pick<GitSyncClient, "getPageJson">,
  ident: MergeIdentity | null,
  ours: string,
  theirs: string,
): Promise<string | null> {
  const gitFile = parsePageFile(ours);
  if (gitFile.id !== null) return null;
  const page = parsePageFile(theirs);
  if (page.id === null) return null;
  if (ident === null || ident.base.has(page.id)) return null;
  const live = await client.getPageJson(page.id);
  if (live.lastUpdatedSource !== "git-sync") return null;
  if (page.body.trim().length === 0) return page.id;
  // git's body as the page would export after git-sync wrote it.
  const gitBody = await stabilizePageBody(
    await markdownToProseMirror(gitFile.body),
  );
  return normalizeTrailingWhitespace(gitBody) ===
    normalizeTrailingWhitespace(page.body)
    ? page.id
    : null;
}

/** Page id -> file path of every page file at `ref` (first file wins). */
async function idPathMap(
  git: Pick<VaultGit, "pageIdsAtRef">,
  ref: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const { path, id } of await git.pageIdsAtRef(ref)) {
    if (isPageFile(path) && !out.has(id)) out.set(id, path);
  }
  return out;
}

/**
 * A free `<name> ~git.md` (then `~git-2`, …) sibling of `rel`, following the
 * layout's ` ~<suffix>` disambiguation; reserved in `taken`.
 */
function freeGitSibling(rel: string, taken: Set<string>): string {
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : "";
  const stem = rel.slice(dir.length).replace(/\.md$/, "");
  let out = `${dir}${gitCopyStem(stem, 1)}.md`;
  for (let n = 2; taken.has(out); n++) {
    out = `${dir}${gitCopyStem(stem, n)}.md`;
  }
  taken.add(out);
  return out;
}

/**
 * The 3-way base for the two versions met at a conflicted path, or null when
 * they are not the same page (different gitmost_ids) or the page has no merge-
 * base version. The path's own base (stage 1) is used only when it holds that
 * page; otherwise the page's merge-base file, found by id at any path. A git
 * version without frontmatter counts as the path's page.
 */
async function pageMergeBase(
  git: Pick<VaultGit, "showFileAtRef">,
  ident: MergeIdentity | null,
  base: string | null,
  ours: string,
  theirs: string,
): Promise<string | null> {
  const baseId = base !== null ? parsePageFile(base).id : null;
  const theirsId = parsePageFile(theirs).id;
  if ((parsePageFile(ours).id ?? baseId) !== theirsId) return null;
  if (base !== null && baseId === theirsId) return base;
  const at = theirsId !== null ? ident?.base.get(theirsId) : undefined;
  return ident !== null && at !== undefined
    ? git.showFileAtRef(ident.mb, at)
    : null;
}

/**
 * Before the path-based merge, move on `main` the file of every page Docmost
 * moved since the merge base to the page's Docmost path, in one commit — only
 * where `main` still has the page at its merge-base path (a page git moved
 * keeps git's path, see `relocateGitMovedPages`). A file `main` has at a target
 * path that is not itself moving away is git's: dropped when it is unchanged
 * since the merge base (Docmost removed its page), else moved aside to a free
 * `<name> ~git` sibling.
 */
async function alignToDocmostLayout(
  deps: ApplyPullActionsDeps,
  ident: MergeIdentity,
  vaultRoot: string,
  log: (line: string) => void,
  warn: (line: string) => void,
): Promise<void> {
  const { git } = deps;
  const moves: { from: string; to: string; text: string }[] = [];
  for (const [id, from] of ident.base) {
    const to = ident.doc.get(id);
    if (to === undefined || to === from) continue;
    const text = await git.showFileAtRef("HEAD", from);
    if (text !== null && parsePageFile(text).id === id) {
      moves.push({ from, to, text });
    }
  }
  if (moves.length === 0) return;
  const sources = new Set(moves.map((m) => m.from));
  const taken = new Set([
    ...(await git.listTrackedFiles()),
    ...ident.doc.values(),
    ...moves.map((m) => m.to),
  ]);
  const aside: { from: string; to: string; text: string }[] = [];
  const dropped: string[] = [];
  for (const m of moves) {
    if (sources.has(m.to)) continue;
    const occupant = await git.showFileAtRef("HEAD", m.to);
    if (occupant === null) continue;
    if (occupant === (await git.showFileAtRef(ident.mb, m.to))) {
      dropped.push(m.to);
    } else {
      aside.push({ from: m.to, to: freeGitSibling(m.to, taken), text: occupant });
    }
  }
  // Every target is written before any source goes.
  const written = new Set<string>();
  for (const m of [...moves, ...aside]) {
    await writeVaultFile(deps, vaultRoot, m.to, m.text);
    written.add(m.to);
  }
  for (const m of moves) {
    if (!written.has(m.from)) await deps.rm(relToAbs(vaultRoot, m.from));
  }
  await git.stageAll();
  await git.commit(
    `docmost: align ${moves.length} page path(s) to the Docmost layout`,
    {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
      trailers: [SOURCE_TRAILER],
    },
  );
  log(
    `pull: aligned main to the Docmost layout before the merge: ` +
      moves.map((m) => `${m.from} -> ${m.to}`).join(", ") +
      (dropped.length > 0
        ? `; replaced unchanged file(s) of removed page(s): ${dropped.join(", ")}`
        : "") +
      ".",
  );
  if (aside.length > 0) {
    warn(
      `pull: git file(s) at a path Docmost gave to another page were moved ` +
        `aside: ${aside.map((m) => `${m.from} -> ${m.to}`).join(", ")}.`,
    );
  }
}

/**
 * Pages git moved (on `main` the page's file left its merge-base path) keep
 * GIT's path: the page's Docmost-side edits are merged per hunk into git's file
 * and its Docmost-side file goes. A path-based merge alone would leave the page
 * in two files (Docmost's edits at Docmost's path, git's at its own). If Docmost
 * put another page at git's path, that page keeps it and git's file of the page
 * moves to a free `~git` sibling. When git both moved and copied the page (two
 * files with its id, neither at its merge-base path), the page is the file git
 * paired with that path as a rename (else the first by path); the copies lose
 * the gitmost_id so the push creates them as new pages. Returns
 * "docmost path -> kept path" per page and marks every path it settled.
 */
async function relocateGitMovedPages(
  deps: ApplyPullActionsDeps,
  ident: MergeIdentity,
  oursSha: string,
  unmerged: Set<string>,
  settled: Set<string>,
  vaultRoot: string,
): Promise<string[]> {
  const { git } = deps;
  const pathsById = new Map<string, string[]>();
  for (const { path, id } of await git.pageIdsAtRef(oursSha)) {
    if (isPageFile(path)) pathsById.set(id, [...(pathsById.get(id) ?? []), path]);
  }
  const out: string[] = [];
  let taken: Set<string> | null = null;
  // git's renames on `main` since the merge base: old path -> new path.
  let renames: Map<string, string> | null = null;
  for (const [id, paths] of pathsById) {
    const basePath = ident.base.get(id);
    const docPath = ident.doc.get(id);
    if (basePath === undefined || docPath === undefined) continue;
    let gitPath = paths[0];
    let copies: string[] = [];
    if (paths.length > 1) {
      // A file still at the page's own path is the page; the push makes the
      // other files new pages.
      if (paths.includes(basePath) || paths.includes(docPath)) continue;
      if (renames === null) {
        renames = new Map();
        for (const c of await git.diffNameStatus(ident.mb, oursSha)) {
          if (c.status === "R" && c.oldPath !== undefined) {
            renames.set(c.oldPath, c.path);
          }
        }
      }
      const paired = renames.get(basePath);
      gitPath =
        paired !== undefined && paths.includes(paired)
          ? paired
          : [...paths].sort()[0];
      copies = paths.filter((p) => p !== gitPath && !unmerged.has(p));
    }
    if (gitPath === basePath || gitPath === docPath) continue;
    const gitText = await git.showFileAtRef(oursSha, gitPath);
    const baseText = await git.showFileAtRef(ident.mb, basePath);
    const docText = await git.showFileAtRef(DOCMOST_BRANCH, docPath);
    if (
      gitText === null ||
      baseText === null ||
      docText === null ||
      parsePageFile(gitText).id !== id
    ) {
      continue;
    }
    // Docmost left the page alone: the merge already carried git's move.
    if (
      docPath === basePath &&
      docText === baseText &&
      !unmerged.has(gitPath) &&
      copies.length === 0
    ) {
      continue;
    }
    let target = gitPath;
    if (unmerged.has(gitPath)) {
      const theirsAt = await git.showFileAtRef(DOCMOST_BRANCH, gitPath);
      if (theirsAt !== null && parsePageFile(theirsAt).id !== id) {
        await writeVaultFile(deps, vaultRoot, gitPath, theirsAt);
        settled.add(gitPath);
        if (taken === null) {
          taken = new Set([
            ...(await git.listTrackedFiles()),
            ...ident.doc.values(),
          ]);
        }
        target = freeGitSibling(gitPath, taken);
      }
    }
    await writeVaultFile(
      deps,
      vaultRoot,
      target,
      docText === baseText
        ? gitText
        : (
            await git.mergeFileOurs(
              normalizeTrailingWhitespace(baseText),
              normalizeTrailingWhitespace(gitText),
              normalizeTrailingWhitespace(docText),
            )
          ).text,
    );
    settled.add(target);
    // The page's Docmost-side file goes; a file git put at that path stays.
    const gitAtDocPath = await git.showFileAtRef(oursSha, docPath);
    if (gitAtDocPath !== null && parsePageFile(gitAtDocPath).id !== id) {
      await writeVaultFile(deps, vaultRoot, docPath, gitAtDocPath);
    } else {
      await deps.rm(relToAbs(vaultRoot, docPath));
    }
    settled.add(docPath);
    for (const copy of copies) {
      const text = await git.showFileAtRef(oursSha, copy);
      if (text === null) continue;
      await writeVaultFile(
        deps,
        vaultRoot,
        copy,
        normalizeTrailingWhitespace(parsePageFile(text).body),
      );
      settled.add(copy);
    }
    out.push(
      `${docPath} -> ${target}` +
        (copies.length > 0 ? ` (copies made new pages: ${copies.join(", ")})` : ""),
    );
  }
  return out;
}
