/**
 * Error-path coverage for the `VaultGit` git wrapper (engine/git.ts).
 *
 * These tests exclusively exercise the NON-ZERO-EXIT / SPAWN-FAILURE branches
 * that the rest of the suite leaves untested (reviewer-flagged branch-coverage
 * gap): the `run()` unified-error throw, the dedicated per-method throws in
 * `listTrackedFiles` / `diffNameStatus`, the `assertGitAvailable` preflight +
 * `runRaw` spawn-error (`||`-fallthrough) path, and the `ensureRepo`
 * config-pin try/catch wrapper.
 *
 * Style mirrors git.test.ts: real `git` binary, real temp repos under
 * os.tmpdir(), gitAvailable()-gated, temp dirs cleaned in afterEach.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VaultGit } from '../src/engine/git';

const execFileAsync = promisify(execFile);

/** True if a usable `git` binary is on PATH (skip the suite otherwise). */
async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

describe('VaultGit error paths (integration; temp repo)', () => {
  let available = false;
  // Track every temp dir created so afterEach can clean them all, even the
  // ones whose .git was chmod'd read-only mid-test.
  const dirs: string[] = [];

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    while (dirs.length) {
      const d = dirs.pop()!;
      // Restore perms first: a test may have left .git read-only (0o555),
      // which would make rm fail to descend into it.
      try {
        await chmod(join(d, '.git'), 0o755);
      } catch {
        /* not every dir has a .git */
      }
      await rm(d, { recursive: true, force: true });
    }
  });

  /** Make a fresh temp dir for one test (under the OS tmpdir, NOT the repo). */
  async function freshDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'docmost-vault-err-'));
    dirs.push(d);
    return d;
  }

  // 1. run() unified non-zero-exit throw, via checkout of a missing branch.
  it('checkout rejects with a unified "git checkout ... failed:" error for a missing branch', async () => {
    if (!available) return; // skip gracefully when git is unavailable
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // The branch was never created, so `git checkout does-not-exist` exits
    // non-zero; run() must surface that as a thrown, unified Error (not resolve).
    await expect(git.checkout('does-not-exist')).rejects.toThrow(
      /git checkout does-not-exist failed:/,
    );
    // And the underlying git stderr detail must be preserved in the message.
    await expect(git.checkout('does-not-exist')).rejects.toThrow(
      /pathspec 'does-not-exist' did not match/,
    );
  });

  // 2. diffNameStatus's OWN non-zero-exit throw, via an unresolvable second ref.
  it('diffNameStatus rejects with "git diff --name-status failed:" for an unresolvable ref', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo(); // gives us a HEAD (the initial "init vault" commit)

    // `refs/does/not/exist` resolves to nothing -> git exits 128; the dedicated
    // throw in diffNameStatus (separate from run()) must fire.
    await expect(
      git.diffNameStatus('HEAD', 'refs/does/not/exist'),
    ).rejects.toThrow(/git diff --name-status failed:/);
    // git's underlying "unknown revision" / "ambiguous argument" detail is kept.
    await expect(
      git.diffNameStatus('HEAD', 'refs/does/not/exist'),
    ).rejects.toThrow(/unknown revision|ambiguous argument/);
  });

  // 3. listTrackedFiles's dedicated non-zero-exit throw, run OUTSIDE a work-tree.
  it('listTrackedFiles rejects with "git ls-files failed: ... not a git repository" when the cwd is not a repo', async () => {
    if (!available) return;
    // Fresh temp dir, deliberately NOT initialized as a git repo (no ensureRepo).
    const notARepo = await freshDir();
    const git = new VaultGit(notARepo);

    // `git ls-files -z` outside a work-tree exits 128 with "not a git repository".
    await expect(git.listTrackedFiles()).rejects.toThrow(
      /git ls-files failed:/,
    );
    await expect(git.listTrackedFiles()).rejects.toThrow(
      /not a git repository/,
    );
  });

  // 4. assertGitAvailable preflight throw + runRaw spawn-error (`||`) fallthrough.
  it('assertGitAvailable rejects with the spawn (ENOENT) message preserved when git cannot be spawned', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);

    // Point PATH at an empty/garbage directory so spawning `git` fails with
    // ENOENT. vaultGitEnv() spreads process.env, so the child inherits this PATH.
    // execFile rejects with err.code === 'ENOENT' (a STRING, not a number) and
    // an EMPTY-STRING stderr, which is exactly the case that forces runRaw's
    // `e.stderr || e.message` fallthrough (|| not ??) to surface e.message.
    const savedPath = process.env.PATH;
    const garbage = await freshDir(); // an existing dir with no `git` in it
    try {
      process.env.PATH = garbage;
      let err: unknown;
      try {
        await git.assertGitAvailable();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      // The preflight's actionable wrapper.
      expect(message).toContain('git binary not found or not runnable');
      // Proof the empty-stderr -> e.message fallthrough preserved the spawn
      // error: the "Underlying error:" suffix must carry the ENOENT detail.
      expect(message).toContain('Underlying error:');
      expect(message).toMatch(/ENOENT/);
    } finally {
      // ALWAYS restore PATH so the rest of the suite can spawn git again.
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  // 5. ensureRepo config-pin try/catch wrapper.
  it('ensureRepo rejects with "failed to pin vault git config" when the config write cannot acquire its lock', async () => {
    if (!available) return;
    // chmod-based denial does not apply to the superuser, so skip under root.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return; // running as root: chmod cannot block the write -> nothing to test
    }
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo(); // first run sets up .git + identity + initial commit

    // NOTE(review): the spec proposed `chmod 0o444 .git/config`, but git does
    // NOT write config in place — it writes via a `config.lock` file created in
    // the `.git` DIRECTORY and renames it over config. So a read-only
    // `.git/config` file does NOT block the write (verified: exit 0). To
    // actually fail the unconditional `git config core.autocrlf false` write we
    // must make the `.git` DIRECTORY non-writable (0o555), which denies creating
    // `config.lock` -> git exits 255 with "could not lock config file". The
    // assertion below still checks the spec's intended wrapped error
    // ("failed to pin vault git config", the vault path, and the writable/locked
    // `.git/config` hint), which is the branch under test.
    const gitDir = join(vault, '.git');
    await chmod(gitDir, 0o555);
    try {
      let err: unknown;
      try {
        // Second ensureRepo(): identity is already set (reads pass), so the
        // FIRST write it attempts is the SPEC §11 config-pin block, which now
        // cannot lock -> the try/catch rethrows the actionable error.
        await git.ensureRepo();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain('failed to pin vault git config');
      // References the vault path and the writable/locked .git/config hint.
      expect(message).toContain(vault);
      expect(message).toContain('.git/config');
      expect(message).toMatch(/writable|locked/);
    } finally {
      // Restore perms so afterEach (and rm) can descend into .git.
      await chmod(gitDir, 0o755);
    }
  });
});
