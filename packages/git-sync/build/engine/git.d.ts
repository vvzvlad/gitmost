/** Bot identity used for engine-authored vault commits (SPEC §7.3). */
export declare const BOT_AUTHOR_NAME = "Docmost Sync";
export declare const BOT_AUTHOR_EMAIL = "docmost-sync@local";
/** Default branch the vault repo is initialized on. */
export declare const DEFAULT_BRANCH = "main";
/**
 * One row of `git diff --name-status` (SPEC §6 "ФС → Docmost"). `status` is the
 * single-letter change code (`-M` rename detection on), `path` is the (new) file
 * path; for a rename/copy (`R`/`C`) `oldPath` is the source and `path` is the
 * destination, with `score` carrying git's similarity index (0–100).
 */
export interface DiffEntry {
    status: "A" | "M" | "D" | "R" | "C";
    /** New (destination) path. For A/M/D it is the only path. */
    path: string;
    /** Source path — present only for R/C. */
    oldPath?: string;
    /** Rename/copy similarity score (0–100) — present only for R/C. */
    score?: number;
}
/** Result of a `merge`: whether it succeeded cleanly or left conflict markers. */
export interface MergeResult {
    /** True when the merge applied cleanly (fast-forward or clean 3-way). */
    ok: boolean;
    /** True when the merge stopped on conflicts (markers left in the worktree). */
    conflict: boolean;
    /** Raw combined stdout+stderr, for logging/diagnostics. */
    output: string;
}
/** Options for an engine-authored commit (provenance, SPEC §7.3). */
export interface CommitOptions {
    authorName: string;
    authorEmail: string;
    /**
     * Trailer lines appended to the commit message body (e.g.
     * `Docmost-Sync-Source: docmost`). These are the machine-readable provenance
     * the loop-guard keys on (SPEC §12, "commit-attribution").
     */
    trailers?: string[];
}
/**
 * A git wrapper bound to a single vault path. Construct once per vault; every
 * method runs git with `cwd = vaultPath`.
 */
export declare class VaultGit {
    private readonly vaultPath;
    constructor(vaultPath: string);
    /**
     * Preflight: verify a runnable `git` binary is on PATH. The daemon shells out
     * to system `git` for every vault operation, so a missing binary (e.g. a slim
     * container image without git) must fail fast with an actionable message
     * rather than a cryptic ENOENT deep inside the first real git call. Presence
     * check only — we do NOT gate on a specific version. Runs `git --version`
     * with NO `cwd` (the vault dir may not exist yet at preflight time).
     */
    assertGitAvailable(): Promise<void>;
    /**
     * Run a git command in the vault and return trimmed stdout. THIN wrapper over
     * the single `runRaw` primitive: throws a clear, unified Error (including
     * stderr/stdout) on a non-zero exit.
     */
    private run;
    /**
     * The ONE primitive every git invocation in this module flows through. Builds
     * the full argv (`--no-pager -c core.quotepath=false <args>`), env, cwd, and
     * maxBuffer, runs git, and NEVER throws — it returns the exit info so callers
     * can treat a non-zero exit as either an error (`run`) or a meaningful state
     * (e.g. a merge conflict, a porcelain diff that "fails" deliberately).
     *
     *   - argv: ALWAYS prepends `--no-pager -c core.quotepath=false`, so git never
     *     blocks on a pager and always prints verbatim UTF-8 paths (no octal
     *     escaping/quoting). `quotepath=false` is the baseline for ALL path-
     *     printing commands (ls-files, diff --name-only, …).
     *   - cwd: `opts.cwd === null` -> do NOT set cwd (the preflight, where the
     *     vault dir may not exist); otherwise `opts.cwd ?? this.vaultPath`.
     *   - env: `vaultGitEnv(opts?.env)` (cwd-isolation + caller extras).
     *   - On a spawn/exec error we capture the error `message` too, so a failure
     *     before git could write to stderr (e.g. ENOENT) is NOT lost.
     */
    private runRaw;
    /**
     * Ensure the vault directory exists and is an initialized git repo on `main`
     * with an initial (empty) commit so branches exist. Idempotent: safe to call
     * on every run. Sets a LOCAL bot identity for the vault repo if none is set
     * (so engine commits never fall back to a global/unset identity).
     */
    ensureRepo(): Promise<void>;
    /** True if `cwd` is inside a git work-tree (the vault is initialized). */
    private isRepo;
    /** True if a LOCAL git config key is set in the vault repo. */
    private hasLocalConfig;
    /** True if the repo has at least one commit (HEAD resolves). */
    private hasAnyCommit;
    /** True if a branch with the given name exists. */
    branchExists(name: string): Promise<boolean>;
    /**
     * Create `name` from `fromBranch` if it does not already exist. No-op (and no
     * checkout) when the branch is already present.
     */
    ensureBranch(name: string, fromBranch: string): Promise<void>;
    /** Name of the currently checked-out branch. */
    currentBranch(): Promise<string>;
    /** Check out an existing branch. */
    checkout(name: string): Promise<void>;
    /** Stage everything (adds, modifications, deletions). */
    stageAll(): Promise<void>;
    /**
     * True if the vault is mid-merge (an unresolved merge from a previous run,
     * SPEC §9 / §12). Detected via a `MERGE_HEAD` ref OR any unmerged
     * (conflicted) index entries (`git ls-files -u`). The pull cycle checks this
     * BEFORE any checkout so a left-over merge produces a clear, actionable
     * message instead of a raw "you need to resolve your current index first"
     * failure deep inside `checkout`. This is what makes re-runs converge
     * (resumability, SPEC §12).
     */
    isMergeInProgress(): Promise<boolean>;
    /**
     * Commit the currently STAGED changes with an explicit author/committer
     * identity and the given trailers appended to the message body (SPEC §7.3
     * provenance). Returns `true` if a commit was made, `false` if there was
     * nothing to commit (graceful no-op). The caller is expected to have staged
     * its changes first (e.g. via `stageAll`).
     */
    commit(message: string, opts: CommitOptions): Promise<boolean>;
    /**
     * Low-level commit used by both `commit` and `ensureRepo`'s initial commit.
     * Builds the full message with appended trailers and sets author + committer
     * identity via env vars (so the committer matches the author, not the repo
     * default).
     */
    private commitRaw;
    /**
     * Merge `fromBranch` into the current branch (`git merge --no-edit`).
     * Fast-forwards when possible; performs a real 3-way merge otherwise. Conflict
     * state is SURFACED (returned), NOT auto-resolved (SPEC §9): the conflict
     * markers are left in the worktree for manual resolution by a later increment,
     * and — critically — nothing is pushed to Docmost (we never write to Docmost
     * anyway).
     */
    merge(fromBranch: string): Promise<MergeResult>;
    /** True if the index has any unmerged (conflicted) paths. */
    private hasUnmergedPaths;
    /**
     * List tracked files on the current branch (paths relative to the vault
     * root, forward-slash separated). An optional glob (a git pathspec) narrows
     * the listing, e.g. `"*.md"`.
     *
     * The target wiki is RUSSIAN, so vault file names routinely contain Cyrillic
     * (e.g. `Колонка.md`). With git's DEFAULT `core.quotepath=true`, `ls-files`
     * returns non-ASCII paths octal-escaped and double-quoted (`"\320\232..."`),
     * which `src/pull.ts` `readExisting` would then parse as garbage paths,
     * breaking move/duplicate detection. We defeat that two ways at once:
     *   - `core.quotepath=false` disables the octal-escape/quoting. It is now the
     *     `runRaw` argv baseline (prepended to EVERY invocation), so we no longer
     *     pass it inline here.
     *   - `-z` emits NUL-delimited RAW UTF-8 paths (no quoting, no newline
     *     ambiguity), which we split on `\0`.
     * We read the RAW stdout (NOT the trimming `run()` helper, which would mangle
     * the NUL-delimited bytes) and split on `\0`, dropping empty entries. Paths
     * are returned verbatim — git already emits forward slashes.
     */
    listTrackedFiles(glob?: string): Promise<string[]>;
    /**
     * Diff two refs with `--name-status -M -z` and parse the NUL-delimited output
     * (SPEC §6: the FS→Docmost push direction diffs `main` against
     * `refs/docmost/last-pushed`). Rename detection is ON (`-M`), so a moved/renamed
     * file is reported as a single `R` row with both its old and new path instead
     * of a delete+add pair — that distinction is what lets the push planner tell a
     * move from a delete+create (SPEC §8 "Move vs delete").
     *
     * `-z` makes git emit NUL-delimited RAW UTF-8 records (the Russian wiki has
     * Cyrillic file names) with NO quoting/escaping. The record shape differs by
     * status:
     *   - A/M/D:  `status\0path\0`
     *   - R/C:    `Rnnn\0oldPath\0newPath\0`  (nnn = similarity score, e.g. `R100`)
     * We read the RAW stdout (not the trimming `run()` helper, which would mangle
     * the NUL bytes), split on `\0`, drop the trailing empty entry, and walk the
     * tokens pulling 1 or 2 path tokens per status. Paths are returned verbatim.
     */
    diffNameStatus(fromRef: string, toRef: string): Promise<DiffEntry[]>;
    /**
     * Resolve a ref/commit-ish to its full SHA, or `null` if it does not exist.
     * `rev-parse --verify --quiet` exits non-zero (and prints nothing) for an
     * unknown ref, so a non-zero exit maps cleanly to `null`. Used to read
     * `refs/docmost/last-pushed` (SPEC §5) — which is absent before the first push.
     */
    revParse(ref: string): Promise<string | null>;
    /**
     * Read a ref to its SHA, or `null` if unset. Thin alias over `revParse`,
     * named for the push direction's marker `refs/docmost/last-pushed` (SPEC §5:
     * "что из `main` уже отражено в Docmost").
     */
    readRef(ref: string): Promise<string | null>;
    /**
     * Point `ref` at `target` (`git update-ref <ref> <target>`). Used to advance
     * `refs/docmost/last-pushed` to the just-pushed `main` commit after a push
     * (SPEC §6 step 3 / §5). `target` may be a SHA or any commit-ish git accepts.
     */
    updateRef(ref: string, target: string): Promise<void>;
    /**
     * Fast-forward `branch` to `toCommit` — but ONLY if it is a TRUE fast-forward,
     * i.e. the current `branch` tip is an ancestor of `toCommit` (verified via
     * `git merge-base --is-ancestor <branch> <toCommit>`). Used to advance the
     * `docmost` mirror branch after a clean push (SPEC §6 step 3 / §10): once a
     * push succeeds, Docmost already contains the pushed `main` content, so the
     * mirror must reflect it — otherwise the NEXT pull would diff our own write
     * back and re-pull it (loop-guard).
     *
     * SAFETY — never force, never clobber divergent history:
     *   - If `branch` IS an ancestor of `toCommit`, advance it with
     *     `git update-ref refs/heads/<branch> <toCommit>`. The `docmost` branch is
     *     NOT checked out during a push (push works on `main`), so updating the ref
     *     directly is safe and avoids any working-tree touch.
     *   - If `branch` is NOT an ancestor (divergent / would-be non-fast-forward),
     *     do NOT move it — return `{ ok: false, reason: 'not-fast-forward' }` and
     *     let the caller log it. We must never overwrite a `docmost` history that
     *     has commits the push base does not contain.
     *
     * Returns `{ ok: true }` when the branch was advanced (or already at
     * `toCommit`, a degenerate fast-forward), `{ ok: false, reason }` otherwise.
     * A missing `branch` or `toCommit` also yields `{ ok: false }` with a reason.
     */
    fastForwardBranch(branch: string, toCommit: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /**
     * Read a file's content at a specific ref (`git show <ref>:<path>`), or `null`
     * if the path does not exist there. Used by the push direction to read the
     * PRE-IMAGE of a DELETED file (e.g. at `refs/docmost/last-pushed`) so its
     * `docmost:meta` — and therefore its `pageId` — can be recovered to translate
     * the deletion into a `delete_page` (SPEC §6/§8: only TRACKED files, i.e. ones
     * that had a pageId, are deleted in Docmost). A non-zero exit (path absent at
     * that ref) maps to `null` rather than throwing.
     */
    showFileAtRef(ref: string, path: string): Promise<string | null>;
}
/**
 * Build the environment for a vault git invocation (SPEC §12 cwd-isolation).
 * Used by the single `runRaw` primitive every git command flows through, so
 * these pins apply uniformly (including the `git --version` preflight).
 *
 * cwd-isolation is this module's central safety guarantee: every git command
 * MUST operate on the vault repo at `cwd: vaultPath` and nothing else. An
 * inherited `GIT_DIR` / `GIT_WORK_TREE` in `process.env` would silently
 * redirect the operation away from `cwd` (e.g. to the source repo or another
 * checkout), defeating that guarantee. So we always strip them, regardless of
 * whatever else the caller adds (author/committer identity, etc.).
 *
 * Exported for unit testing.
 */
export declare function vaultGitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv;
/**
 * Build a commit message body with trailer lines appended (SPEC §7.3). The
 * trailers are separated from the subject by a blank line so `git interpret-
 * trailers` / `git log --format=%(trailers)` parse them as trailers.
 * Exported for unit testing.
 */
export declare function buildCommitMessage(subject: string, trailers?: string[]): string;
