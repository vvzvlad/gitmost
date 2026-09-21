import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  VaultGit,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
} from '../src/engine/git';

// Integration coverage gaps for `git.ts` flagged by the PR #119 reviewers
// (test-strategy report, Module 2). These create REAL temp git repos (mirroring
// test/git.test.ts's setup/teardown) to exercise the actual `git` binary, since
// the behaviors under test (the `-z` NUL-token alignment, copy detection, and
// per-invocation committer identity) only manifest against real git.

const execFileAsync = promisify(execFile);

/** True if a usable `git` binary is on PATH (skip gracefully otherwise). */
async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** Read the author "Name <email>" of HEAD in a repo dir. */
async function headAuthor(dir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-pager', 'log', '-1', '--pretty=%an <%ae>'],
    { cwd: dir },
  );
  return stdout.trim();
}

/** Read the committer "Name <email>" of HEAD in a repo dir. */
async function headCommitter(dir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-pager', 'log', '-1', '--pretty=%cn <%ce>'],
    { cwd: dir },
  );
  return stdout.trim();
}

/** Read a LOCAL git config value (or '' if unset) in a repo dir. */
async function localConfig(dir: string, key: string): Promise<string> {
  const r = await execFileAsync('git', ['config', '--local', '--get', key], {
    cwd: dir,
  }).catch(() => ({ stdout: '' }) as { stdout: string });
  return r.stdout.trim();
}

describe('VaultGit integration gaps (temp repo)', () => {
  let available = false;
  let dir: string;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function freshDir(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'docmost-vault-gap-'));
    return dir;
  }

  // --- 7. diffNameStatus: rename mixed with add + modify in ONE diff ----------
  //
  // The `-z` parser walks NUL-delimited tokens pulling 1 or 2 path tokens per
  // status (R/C take TWO: old + new; A/M/D take ONE). A misalignment — pulling
  // the wrong number of tokens for any row — would SHIFT every subsequent path
  // and misclassify a move as a delete (or vice versa). This test mixes an R
  // (rename) with an A (add) and an M (modify) in a SINGLE diff so the walk MUST
  // stay aligned across the 2-token R row and the 1-token A/M rows.
  it('diffNameStatus keeps -z token alignment with R + A + M in one diff', async (ctx) => {
    // Truly SKIP (not silently pass) when git is unavailable — a green result on
    // a git-less machine would falsely claim this integration ran.
    if (!available) ctx.skip();
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // Base commit: `keep.md` (to be modified) and `old-name.md` (to be renamed).
    const renameBody = 'line a\nline b\nline c\nline d\n';
    await writeFile(join(vault, 'keep.md'), 'v1\n', 'utf8');
    await writeFile(join(vault, 'old-name.md'), renameBody, 'utf8');
    await git.stageAll();
    await git.commit('base', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });
    const base = await git.revParse('HEAD');
    expect(base).toBeTruthy();

    // Second commit: MODIFY keep.md, ADD fresh.md, RENAME old-name.md ->
    // new-name.md (identical content so -M detects a rename, not delete+add).
    await writeFile(join(vault, 'keep.md'), 'v2\n', 'utf8');
    await writeFile(join(vault, 'fresh.md'), 'brand new\n', 'utf8');
    await rm(join(vault, 'old-name.md'));
    await writeFile(join(vault, 'new-name.md'), renameBody, 'utf8');
    await git.stageAll();
    await git.commit('mixed change', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });

    const entries = await git.diffNameStatus(base!, 'HEAD');
    const byPath = new Map(entries.map((e) => [e.path, e]));

    // The modify and the add are each classified correctly (1 path token each).
    expect(byPath.get('keep.md')).toEqual({ status: 'M', path: 'keep.md' });
    expect(byPath.get('fresh.md')).toEqual({ status: 'A', path: 'fresh.md' });

    // The rename is a SINGLE R row carrying BOTH old + new paths (2 path tokens)
    // — proof the walk consumed exactly two tokens here and stayed aligned. If
    // alignment were off, the rename would surface as a D (delete) of
    // old-name.md and/or an A of new-name.md instead.
    const r = byPath.get('new-name.md');
    expect(r?.status).toBe('R');
    expect(r?.oldPath).toBe('old-name.md');
    expect(r?.score).toBe(100);

    // Exactly three rows, and crucially NO stray D/A for the renamed file (which
    // is the tell-tale of a -z misalignment).
    expect(entries.length).toBe(3);
    expect(entries.some((e) => e.status === 'D')).toBe(false);
    expect(byPath.has('old-name.md')).toBe(false);
  });

  // --- 8. diffNameStatus: copy (C) status lines -------------------------------
  //
  // DOCUMENTED OUTCOME (reported as such): `C` (copy) rows are NOT reachable
  // through the engine's actual git invocation. `diffNameStatus` invokes
  // `git diff --name-status -M -z` — `-M` enables rename detection ONLY; copy
  // detection requires `-C`/`--find-copies`, which the engine does NOT pass. So a
  // file that is a verbatim COPY of another (the original is KEPT) is reported as
  // a plain ADD (`A`), never `C`. This test pins that real behavior so a future
  // change that turns on `-C` (and would start emitting `C` rows) is caught.
  it('diffNameStatus reports a pure copy as A, not C (engine uses -M only)', async (ctx) => {
    if (!available) ctx.skip();
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // Base: a single source file with enough content to be copy-detectable.
    const body = 'aaa\nbbb\nccc\nddd\neee\nfff\n';
    await writeFile(join(vault, 'src.md'), body, 'utf8');
    await git.stageAll();
    await git.commit('add src', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });
    const base = await git.revParse('HEAD');

    // KEEP src.md and add an identical copy dup.md (a pure copy, not a rename).
    await copyFile(join(vault, 'src.md'), join(vault, 'dup.md'));
    await git.stageAll();
    await git.commit('add copy of src', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });

    const entries = await git.diffNameStatus(base!, 'HEAD');

    // With -M only (no -C), git does NOT emit a C row: the copy is a plain add.
    expect(entries).toEqual([{ status: 'A', path: 'dup.md' }]);
    expect(entries.some((e) => e.status === 'C')).toBe(false);
  });

  // --- 9. commit: per-invocation committer/author does NOT leak into config ----
  //
  // The engine sets author + committer identity via GIT_AUTHOR_*/GIT_COMMITTER_*
  // env vars per `git commit` invocation (commitRaw). This underpins the §10
  // provenance/loop-guard: the identity must travel WITH the commit, not be
  // written into the repo config (which would make it global to every later
  // hand-run commit). We commit with the distinct "Local" identity (different
  // from the repo's default `user.name`/`user.email`, which ensureRepo seeds as
  // the bot identity) and assert the commit carries the passed identity while the
  // repo config is UNCHANGED (still the bot default).
  it('commit passes committer/author per-invocation without mutating repo config', async (ctx) => {
    if (!available) ctx.skip();
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // ensureRepo seeds the repo's LOCAL user.* with the bot identity. Capture it
    // so we can prove the per-commit identity does NOT overwrite it.
    expect(await localConfig(vault, 'user.name')).toBe(BOT_AUTHOR_NAME);
    expect(await localConfig(vault, 'user.email')).toBe(BOT_AUTHOR_EMAIL);

    // Commit with a DIFFERENT identity, passed per-invocation only.
    const LOCAL_NAME = 'Local';
    const LOCAL_EMAIL = 'local@local';
    await writeFile(join(vault, 'page.md'), 'hello\n', 'utf8');
    await git.stageAll();
    const made = await git.commit('docmost: sync 1 page(s)', {
      authorName: LOCAL_NAME,
      authorEmail: LOCAL_EMAIL,
    });
    expect(made).toBe(true);

    // The commit's author AND committer are the passed per-invocation identity
    // (committer matches author via GIT_COMMITTER_* — not the repo default).
    expect(await headAuthor(vault)).toBe(`${LOCAL_NAME} <${LOCAL_EMAIL}>`);
    expect(await headCommitter(vault)).toBe(`${LOCAL_NAME} <${LOCAL_EMAIL}>`);

    // CRITICAL: the per-commit identity did NOT leak into the repo config — the
    // LOCAL user.* is still the bot default ensureRepo seeded.
    expect(await localConfig(vault, 'user.name')).toBe(BOT_AUTHOR_NAME);
    expect(await localConfig(vault, 'user.email')).toBe(BOT_AUTHOR_EMAIL);

    // And the identity never reached the GLOBAL config either (the env-var path
    // writes no config at all). `--global --get` exits non-zero / empty when the
    // value differs or is unset; assert it is NOT the per-commit identity.
    const globalName = await execFileAsync('git', [
      'config',
      '--global',
      '--get',
      'user.name',
    ])
      .then((r) => r.stdout.trim())
      .catch(() => '');
    expect(globalName).not.toBe(LOCAL_NAME);
  });
});

// Parser/error-fallback gaps for `git.ts` exercised WITHOUT a real git binary by
// monkey-patching the private `runRaw` primitive (every git invocation funnels
// through it, per the module header). These pin defensive arms the accepted
// integration specs above could not reach: the unknown-status consume in the
// `-z` walk, and the `|| r.stdout` empty-stderr error-detail fallbacks.
describe('VaultGit parser/error-fallback gaps (runRaw stubbed)', () => {
  // --- 1. diffNameStatus: unknown status (T) sandwiched between A and M --------
  //
  // Protects the default arm of the status switch (git.ts ~lines 497-502): an
  // unknown status like `T` (type-change) consumes ONE path token defensively
  // but emits nothing. If the walk pulled the wrong count here it would desync
  // and misclassify the trailing M row.
  it('diffNameStatus swallows an unknown T status mid-stream and stays aligned', async () => {
    const git = new VaultGit('/tmp/any');
    (git as any).runRaw = async () => ({
      code: 0,
      // A\0a.md  T\0t.md  M\0m.md  — T is the unknown status mid-stream.
      stdout: 'A\0a.md\0T\0t.md\0M\0m.md\0',
      stderr: '',
    });

    const entries = await git.diffNameStatus('X', 'Y');

    // The T row's path token 't.md' is consumed but NOT emitted; the walk stays
    // aligned so the trailing M/m.md parses cleanly (no off-by-one).
    expect(entries).toEqual([
      { status: 'A', path: 'a.md' },
      { status: 'M', path: 'm.md' },
    ]);
    expect(entries.length).toBe(2);
    expect(entries.some((e) => e.status === ('T' as any))).toBe(false);
    expect(entries.some((e) => e.path === 't.md')).toBe(false);
  });

  // --- 2. diffNameStatus: unknown status (T) FIRST in the stream --------------
  //
  // Leading-position variant: a `T` at the head must consume its own path token
  // without swallowing the following real A entry.
  it('diffNameStatus swallows a leading unknown T status and parses the next A', async () => {
    const git = new VaultGit('/tmp/any');
    (git as any).runRaw = async () => ({
      code: 0,
      stdout: 'T\0t.md\0A\0a.md\0',
      stderr: '',
    });

    const entries = await git.diffNameStatus('X', 'Y');

    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual({ status: 'A', path: 'a.md' });
  });

  // --- 3. listTrackedFiles: non-zero exit, EMPTY stderr, stdout carries detail -
  //
  // The thrown message is built from `(r.stderr || r.stdout || '')`. This pins
  // the `|| r.stdout` arm (empty stderr, non-empty stdout) — distinct from the
  // non-empty-stderr and spawn-ENOENT paths the accepted specs cover.
  it('listTrackedFiles uses stdout in the error message when stderr is empty', async () => {
    const git = new VaultGit('/tmp/any');
    (git as any).runRaw = async () => ({
      code: 1,
      stderr: '',
      stdout: 'some detail',
    });

    await expect(git.listTrackedFiles()).rejects.toThrow(
      'git ls-files failed: some detail',
    );
  });

  // --- 4. diffNameStatus: non-zero exit, EMPTY stderr, stdout carries detail ---
  //
  // diffNameStatus has its OWN independent `(r.stderr || r.stdout || '').trim()`
  // fallback (git.ts ~line 469), separate from listTrackedFiles. Pin the
  // empty-stderr/non-empty-stdout arm of THIS branch.
  it('diffNameStatus uses stdout in the error message when stderr is empty', async () => {
    const git = new VaultGit('/tmp/any');
    (git as any).runRaw = async () => ({
      code: 1,
      stderr: '',
      stdout: 'diff detail',
    });

    await expect(git.diffNameStatus('X', 'Y')).rejects.toThrow(
      'git diff --name-status failed: diff detail',
    );
  });
});
