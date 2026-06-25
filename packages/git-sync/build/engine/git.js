/**
 * Thin async wrapper over the system `git` binary (SPEC §5: state store = git).
 *
 * IMPORTANT — VAULT-SCOPED: every operation here runs with `cwd = vaultPath`,
 * which is the vault's OWN git repository (default `data/vault`), SEPARATE from
 * the gitmost application repo. This module MUST NEVER run git against the
 * application repo. `data/` is gitignored, so a nested repo under `data/vault`
 * is safe. The pull cycle is READ-ONLY toward Docmost; this module only touches
 * the local vault git, never a git remote (push is deferred, see SPEC §7).
 *
 * Implementation notes:
 *   - We shell out via `node:child_process` `execFile` (promisified), passing
 *     ARGS AS AN ARRAY — no shell, so there is no command injection surface even
 *     if a page title / branch name contains shell metacharacters.
 *   - EVERY git invocation funnels through the single `runRaw` primitive, which
 *     ALWAYS prepends `--no-pager -c core.quotepath=false` to the argv (so git
 *     never blocks on a pager and always prints verbatim UTF-8 paths). There is
 *     no exception — even the `git --version` preflight goes through `runRaw`.
 *   - "nothing to commit" is treated as a graceful no-op, not an error.
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
/** Bot identity used for engine-authored vault commits (SPEC §7.3). */
export const BOT_AUTHOR_NAME = "Docmost Sync";
export const BOT_AUTHOR_EMAIL = "docmost-sync@local";
/** Default branch the vault repo is initialized on. */
export const DEFAULT_BRANCH = "main";
/**
 * A git wrapper bound to a single vault path. Construct once per vault; every
 * method runs git with `cwd = vaultPath`.
 */
export class VaultGit {
    vaultPath;
    constructor(vaultPath) {
        this.vaultPath = vaultPath;
    }
    /**
     * Preflight: verify a runnable `git` binary is on PATH. The daemon shells out
     * to system `git` for every vault operation, so a missing binary (e.g. a slim
     * container image without git) must fail fast with an actionable message
     * rather than a cryptic ENOENT deep inside the first real git call. Presence
     * check only — we do NOT gate on a specific version. Runs `git --version`
     * with NO `cwd` (the vault dir may not exist yet at preflight time).
     */
    async assertGitAvailable() {
        // Goes through the single `runRaw` primitive like every other invocation.
        // `cwd: null` means "do not set a cwd" — the vault dir may not exist yet at
        // preflight time, so we must not point git at a missing directory.
        const r = await this.runRaw(["--version"], { cwd: null });
        if (r.code !== 0) {
            const detail = (r.stderr || r.stdout || "").trim();
            throw new Error("git binary not found or not runnable — install git (the vault state " +
                `store requires it). Underlying error: ${detail}`);
        }
    }
    /**
     * Run a git command in the vault and return trimmed stdout. THIN wrapper over
     * the single `runRaw` primitive: throws a clear, unified Error (including
     * stderr/stdout) on a non-zero exit.
     */
    async run(args, opts) {
        const r = await this.runRaw(args, opts);
        if (r.code !== 0) {
            const detail = (r.stderr || r.stdout || "").trim();
            throw new Error(`git ${args.join(" ")} failed: ${detail}`);
        }
        return r.stdout.trim();
    }
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
    async runRaw(args, opts) {
        const cwd = opts?.cwd === null ? undefined : (opts?.cwd ?? this.vaultPath);
        try {
            const { stdout, stderr } = await execFileAsync("git", ["--no-pager", "-c", "core.quotepath=false", ...args], {
                // Generous buffer: file listings / porcelain output on a large vault
                // can be sizable.
                ...(cwd !== undefined ? { cwd } : {}),
                maxBuffer: 64 * 1024 * 1024,
                env: vaultGitEnv(opts?.env),
            });
            return { code: 0, stdout, stderr };
        }
        catch (err) {
            const e = err;
            return {
                code: typeof e.code === "number" ? e.code : 1,
                stdout: e.stdout ?? "",
                // Preserve the error message when there is no stderr (e.g. a spawn
                // failure like ENOENT, where promisified execFile sets stderr to an
                // EMPTY STRING — so `||`, not `??`, to fall through to `message`).
                stderr: e.stderr || e.message || "",
            };
        }
    }
    /**
     * Ensure the vault directory exists and is an initialized git repo on `main`
     * with an initial (empty) commit so branches exist. Idempotent: safe to call
     * on every run. Sets a LOCAL bot identity for the vault repo if none is set
     * (so engine commits never fall back to a global/unset identity).
     */
    async ensureRepo() {
        await mkdir(this.vaultPath, { recursive: true });
        if (!(await this.isRepo())) {
            // `git init -b main` sets the initial branch on modern git; we still
            // guard the branch name below for safety on older binaries.
            await this.run(["init", "-b", DEFAULT_BRANCH]);
        }
        // Set a local identity for the vault repo if unset, so engine commits have
        // a deterministic committer even on a machine with no global git config.
        if (!(await this.hasLocalConfig("user.name"))) {
            await this.run(["config", "user.name", BOT_AUTHOR_NAME]);
        }
        if (!(await this.hasLocalConfig("user.email"))) {
            await this.run(["config", "user.email", BOT_AUTHOR_EMAIL]);
        }
        // Neutralize correctness-affecting git config in the vault's LOCAL config so
        // a user's GLOBAL/system config cannot change porcelain BEHAVIOR (not just
        // output) and corrupt the vault. The vault is OUR dedicated repo, so LOCAL
        // values (which override global/system) are the right scope. Set
        // UNCONDITIONALLY every run — idempotent and cheap; `git config <key>`
        // writes to `--local` by default inside the repo. These MUST be in place
        // before any add/commit/checkout that could be affected, hence they run
        // before the initial-commit block below.
        //   - core.autocrlf=false — CRITICAL (SPEC §11): a global core.autocrlf=true
        //     would rewrite LF<->CRLF on add/checkout, making our deterministic,
        //     byte-stable markdown churn and breaking the round-trip invariant.
        //     `false` guarantees git stores/checks out verbatim bytes.
        //   - core.safecrlf=false — avoid CRLF-related warnings/aborts on add.
        //   - commit.gpgsign=false — the headless daemon must never try to GPG-sign
        //     a commit (would fail/hang; we already set GIT_TERMINAL_PROMPT=0).
        //   - core.attributesFile=/dev/null — neutralize the user's GLOBAL
        //     gitattributes so a global clean/smudge filter (filter.<name>.clean)
        //     cannot rewrite the STORED blob and break §11 byte-stability (a config
        //     that core.autocrlf=false does not cover). POSIX-only path, which is
        //     fine: the daemon runs on Linux (Docker) / macOS. A system
        //     /etc/gitattributes remains the host admin's domain (out of scope).
        // NOTE: these stay PERSISTED LOCAL config (not `-c` flags) on purpose — a
        // human running git by hand in the vault must inherit the same neutralized
        // behavior; a transient `-c` would not persist. (core.quotepath, by
        // contrast, only affects OUR parsing of output and so is baked into the
        // `runRaw` argv baseline instead.)
        try {
            await this.run(["config", "core.autocrlf", "false"]);
            await this.run(["config", "core.safecrlf", "false"]);
            await this.run(["config", "commit.gpgsign", "false"]);
            await this.run(["config", "core.attributesFile", "/dev/null"]);
        }
        catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(`failed to pin vault git config (SPEC §11) — ensure ${this.vaultPath}` +
                "/.git/config is writable and not locked (e.g. stale config.lock): " +
                detail);
        }
        // Create the initial empty commit on `main` if the repo has no commits yet,
        // so both `main` and (later) `docmost` branches have a common base.
        if (!(await this.hasAnyCommit())) {
            // Make sure we are on the default branch before the first commit (covers
            // the older-git case where `init -b` was not honored).
            await this.run(["checkout", "-B", DEFAULT_BRANCH]);
            await this.commitRaw("init vault", {
                authorName: BOT_AUTHOR_NAME,
                authorEmail: BOT_AUTHOR_EMAIL,
                allowEmpty: true,
            });
        }
    }
    /** True if `cwd` is inside a git work-tree (the vault is initialized). */
    async isRepo() {
        const r = await this.runRaw(["rev-parse", "--is-inside-work-tree"]);
        return r.code === 0 && r.stdout.trim() === "true";
    }
    /** True if a LOCAL git config key is set in the vault repo. */
    async hasLocalConfig(key) {
        const r = await this.runRaw(["config", "--local", "--get", key]);
        return r.code === 0 && r.stdout.trim().length > 0;
    }
    /** True if the repo has at least one commit (HEAD resolves). */
    async hasAnyCommit() {
        const r = await this.runRaw(["rev-parse", "--verify", "HEAD"]);
        return r.code === 0;
    }
    /** True if a branch with the given name exists. */
    async branchExists(name) {
        const r = await this.runRaw([
            "rev-parse",
            "--verify",
            `refs/heads/${name}`,
        ]);
        return r.code === 0;
    }
    /**
     * Create `name` from `fromBranch` if it does not already exist. No-op (and no
     * checkout) when the branch is already present.
     */
    async ensureBranch(name, fromBranch) {
        if (await this.branchExists(name))
            return;
        await this.run(["branch", name, fromBranch]);
    }
    /** Name of the currently checked-out branch. */
    async currentBranch() {
        return this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
    }
    /** Check out an existing branch. */
    async checkout(name) {
        await this.run(["checkout", name]);
    }
    /** Stage everything (adds, modifications, deletions). */
    async stageAll() {
        await this.run(["add", "-A"]);
    }
    /**
     * True if the vault is mid-merge (an unresolved merge from a previous run,
     * SPEC §9 / §12). Detected via a `MERGE_HEAD` ref OR any unmerged
     * (conflicted) index entries (`git ls-files -u`). The pull cycle checks this
     * BEFORE any checkout so a left-over merge produces a clear, actionable
     * message instead of a raw "you need to resolve your current index first"
     * failure deep inside `checkout`. This is what makes re-runs converge
     * (resumability, SPEC §12).
     */
    async isMergeInProgress() {
        // MERGE_HEAD exists exactly while a merge is in progress.
        const mergeHead = await this.runRaw([
            "rev-parse",
            "--verify",
            "--quiet",
            "MERGE_HEAD",
        ]);
        if (mergeHead.code === 0 && mergeHead.stdout.trim().length > 0)
            return true;
        // Fallback / belt-and-suspenders: any unmerged index entries also mean the
        // working tree is mid-conflict and a checkout would refuse.
        const unmerged = await this.runRaw(["ls-files", "-u"]);
        return unmerged.code === 0 && unmerged.stdout.trim().length > 0;
    }
    /**
     * Commit the currently STAGED changes with an explicit author/committer
     * identity and the given trailers appended to the message body (SPEC §7.3
     * provenance). Returns `true` if a commit was made, `false` if there was
     * nothing to commit (graceful no-op). The caller is expected to have staged
     * its changes first (e.g. via `stageAll`).
     */
    async commit(message, opts) {
        // Nothing staged -> nothing to commit. Treat as a no-op (SPEC §11: a
        // deterministic re-pull of unchanged pages produces identical bytes, so
        // git sees no diff and we must not error).
        const staged = await this.runRaw([
            "diff",
            "--cached",
            "--quiet",
        ]);
        // `diff --cached --quiet` exits 0 when the index matches HEAD (nothing
        // staged), 1 when there are staged changes.
        if (staged.code === 0)
            return false;
        await this.commitRaw(message, opts);
        return true;
    }
    /**
     * Low-level commit used by both `commit` and `ensureRepo`'s initial commit.
     * Builds the full message with appended trailers and sets author + committer
     * identity via env vars (so the committer matches the author, not the repo
     * default).
     */
    async commitRaw(message, opts) {
        const fullMessage = buildCommitMessage(message, opts.trailers);
        // `--no-verify` skips pre-commit/commit-msg hooks: a global core.hooksPath
        // (or any injected hook) must never interfere with engine commits in our
        // dedicated vault repo.
        const args = ["commit", "--no-verify", "-m", fullMessage];
        if (opts.allowEmpty)
            args.push("--allow-empty");
        // Route through the single `runRaw` primitive; set author + committer
        // identity via env vars (so the committer matches the author, not the repo
        // default). Throw via the same unified message on a non-zero exit.
        const r = await this.runRaw(args, {
            env: {
                GIT_AUTHOR_NAME: opts.authorName,
                GIT_AUTHOR_EMAIL: opts.authorEmail,
                GIT_COMMITTER_NAME: opts.authorName,
                GIT_COMMITTER_EMAIL: opts.authorEmail,
            },
        });
        if (r.code !== 0) {
            const detail = (r.stderr || r.stdout || "").trim();
            throw new Error(`git ${args.join(" ")} failed: ${detail}`);
        }
    }
    /**
     * Merge `fromBranch` into the current branch (`git merge --no-edit`).
     * Fast-forwards when possible; performs a real 3-way merge otherwise. Conflict
     * state is SURFACED (returned), NOT auto-resolved (SPEC §9): the conflict
     * markers are left in the worktree for manual resolution by a later increment,
     * and — critically — nothing is pushed to Docmost (we never write to Docmost
     * anyway).
     */
    async merge(fromBranch) {
        const r = await this.runRaw(["merge", "--no-edit", fromBranch]);
        const output = `${r.stdout}\n${r.stderr}`.trim();
        if (r.code === 0) {
            return { ok: true, conflict: false, output };
        }
        // A non-zero exit on merge most commonly means a conflict. Confirm by
        // checking for unmerged paths (porcelain "U" status) so we don't mislabel
        // an unrelated failure as a conflict.
        const conflict = await this.hasUnmergedPaths();
        return { ok: false, conflict, output };
    }
    /** True if the index has any unmerged (conflicted) paths. */
    async hasUnmergedPaths() {
        const r = await this.runRaw(["diff", "--name-only", "--diff-filter=U"]);
        return r.code === 0 && r.stdout.trim().length > 0;
    }
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
    async listTrackedFiles(glob) {
        const r = await this.runRaw(["ls-files", "-z", ...(glob ? [glob] : [])]);
        if (r.code !== 0) {
            const detail = (r.stderr || r.stdout || "").trim();
            throw new Error(`git ls-files failed: ${detail}`);
        }
        return r.stdout.split("\0").filter((p) => p.length > 0);
    }
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
    async diffNameStatus(fromRef, toRef) {
        const r = await this.runRaw([
            "diff",
            "--name-status",
            "-M",
            "-z",
            fromRef,
            toRef,
        ]);
        if (r.code !== 0) {
            const detail = (r.stderr || r.stdout || "").trim();
            throw new Error(`git diff --name-status failed: ${detail}`);
        }
        // Tokens alternate: <status> <path...> <status> <path...> ... With `-z`,
        // each token (status code AND each path) is its own NUL-delimited field.
        const tokens = r.stdout.split("\0").filter((t) => t.length > 0);
        const entries = [];
        let i = 0;
        while (i < tokens.length) {
            const raw = tokens[i++];
            // The status token is e.g. `A`, `M`, `D`, or `R100` / `C075`. The leading
            // letter is the change kind; any trailing digits are the similarity score.
            const letter = raw[0];
            if (letter === "R" || letter === "C") {
                const score = Number.parseInt(raw.slice(1), 10);
                const oldPath = tokens[i++];
                const path = tokens[i++];
                if (oldPath === undefined || path === undefined)
                    break; // malformed tail
                entries.push({
                    status: letter,
                    path,
                    oldPath,
                    ...(Number.isFinite(score) ? { score } : {}),
                });
            }
            else if (letter === "A" || letter === "M" || letter === "D") {
                const path = tokens[i++];
                if (path === undefined)
                    break; // malformed tail
                entries.push({ status: letter, path });
            }
            else {
                // Unknown/other status (e.g. T type-change, U unmerged) — consume one
                // path token defensively so the walk stays aligned, but do not emit it
                // (the push planner only handles A/M/D/R/C).
                i++;
            }
        }
        return entries;
    }
    /**
     * Resolve a ref/commit-ish to its full SHA, or `null` if it does not exist.
     * `rev-parse --verify --quiet` exits non-zero (and prints nothing) for an
     * unknown ref, so a non-zero exit maps cleanly to `null`. Used to read
     * `refs/docmost/last-pushed` (SPEC §5) — which is absent before the first push.
     */
    async revParse(ref) {
        const r = await this.runRaw(["rev-parse", "--verify", "--quiet", ref]);
        if (r.code !== 0)
            return null;
        const sha = r.stdout.trim();
        return sha.length > 0 ? sha : null;
    }
    /**
     * Read a ref to its SHA, or `null` if unset. Thin alias over `revParse`,
     * named for the push direction's marker `refs/docmost/last-pushed` (SPEC §5:
     * "что из `main` уже отражено в Docmost").
     */
    async readRef(ref) {
        return this.revParse(ref);
    }
    /**
     * Point `ref` at `target` (`git update-ref <ref> <target>`). Used to advance
     * `refs/docmost/last-pushed` to the just-pushed `main` commit after a push
     * (SPEC §6 step 3 / §5). `target` may be a SHA or any commit-ish git accepts.
     */
    async updateRef(ref, target) {
        await this.run(["update-ref", ref, target]);
    }
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
    async fastForwardBranch(branch, toCommit) {
        const branchRef = `refs/heads/${branch}`;
        // Resolve both endpoints first so a missing ref is a clean refusal, not a
        // confusing `merge-base` failure.
        const branchSha = await this.revParse(branchRef);
        if (branchSha === null) {
            return { ok: false, reason: `branch ${branch} does not exist` };
        }
        const targetSha = await this.revParse(toCommit);
        if (targetSha === null) {
            return { ok: false, reason: `target ${toCommit} does not resolve` };
        }
        // Already at the target -> a no-op fast-forward (still ok).
        if (branchSha === targetSha)
            return { ok: true };
        // `merge-base --is-ancestor A B` exits 0 iff A is an ancestor of B. Only a
        // true ancestor is a fast-forward; anything else is divergent and refused.
        const ancestor = await this.runRaw([
            "merge-base",
            "--is-ancestor",
            branchSha,
            targetSha,
        ]);
        if (ancestor.code !== 0) {
            return { ok: false, reason: "not-fast-forward" };
        }
        // Safe to advance: the branch is not checked out during push, so a direct
        // ref update avoids a checkout/working-tree touch.
        await this.updateRef(branchRef, targetSha);
        return { ok: true };
    }
    /**
     * Read a file's content at a specific ref (`git show <ref>:<path>`), or `null`
     * if the path does not exist there. Used by the push direction to read the
     * PRE-IMAGE of a DELETED file (e.g. at `refs/docmost/last-pushed`) so its
     * `docmost:meta` — and therefore its `pageId` — can be recovered to translate
     * the deletion into a `delete_page` (SPEC §6/§8: only TRACKED files, i.e. ones
     * that had a pageId, are deleted in Docmost). A non-zero exit (path absent at
     * that ref) maps to `null` rather than throwing.
     */
    async showFileAtRef(ref, path) {
        // `git show <ref>:<path>` requires the path relative to the repo root; pass
        // it verbatim (forward-slash, matching `listTrackedFiles` / diff output).
        const r = await this.runRaw(["show", `${ref}:${path}`]);
        if (r.code !== 0)
            return null;
        return r.stdout;
    }
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
export function vaultGitEnv(extra) {
    const env = {
        ...process.env,
        // Locale-independent output (defense in depth). We never parse localized
        // prose, but pinning the locale prevents a future regression where some
        // git message we DO key on is translated by an inherited LC_ALL/LANG.
        LC_ALL: "C",
        LANG: "C",
        // Never page (we already pass --no-pager, but a stray GIT_PAGER could still
        // bite) and never block on an interactive prompt (e.g. credentials) — the
        // daemon runs unattended and must not hang.
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        ...extra,
    };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    return env;
}
/**
 * Build a commit message body with trailer lines appended (SPEC §7.3). The
 * trailers are separated from the subject by a blank line so `git interpret-
 * trailers` / `git log --format=%(trailers)` parse them as trailers.
 * Exported for unit testing.
 */
export function buildCommitMessage(subject, trailers) {
    if (!trailers || trailers.length === 0)
        return subject;
    return `${subject}\n\n${trailers.join("\n")}`;
}
