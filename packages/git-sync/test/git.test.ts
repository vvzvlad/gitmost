import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmod } from 'node:fs/promises';
import {
  VaultGit,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
  buildCommitMessage,
  vaultGitEnv,
} from '../src/engine/git';

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

/** Read the full commit message of HEAD (subject + body) in a repo dir. */
async function headMessage(dir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-pager', 'log', '-1', '--pretty=%B'],
    { cwd: dir },
  );
  return stdout.trim();
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

describe('buildCommitMessage (pure)', () => {
  it('returns the bare subject when there are no trailers', () => {
    expect(buildCommitMessage('subject')).toBe('subject');
    expect(buildCommitMessage('subject', [])).toBe('subject');
  });

  it('appends trailers separated from the subject by a blank line', () => {
    expect(buildCommitMessage('subject', ['Docmost-Sync-Source: docmost'])).toBe(
      'subject\n\nDocmost-Sync-Source: docmost',
    );
  });
});

describe('vaultGitEnv (pure)', () => {
  it('pins locale, pager and prompt, and strips GIT_DIR/GIT_WORK_TREE', () => {
    // Seed inputs that MUST be neutralized/stripped: a redirecting GIT_DIR and
    // GIT_WORK_TREE would defeat the cwd-isolation guarantee (SPEC §12).
    process.env.GIT_DIR = '/somewhere/else/.git';
    process.env.GIT_WORK_TREE = '/somewhere/else';
    try {
      const env = vaultGitEnv();
      // Locale-independent output.
      expect(env.LC_ALL).toBe('C');
      expect(env.LANG).toBe('C');
      // Never page, never block on an interactive prompt.
      expect(env.GIT_PAGER).toBe('cat');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      // The redirecting vars are removed regardless of what process.env held.
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_WORK_TREE).toBeUndefined();
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }
  });

  it('passes through caller extras (e.g. author/committer identity)', () => {
    const env = vaultGitEnv({ GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: 'x@y' });
    expect(env.GIT_AUTHOR_NAME).toBe('X');
    expect(env.GIT_AUTHOR_EMAIL).toBe('x@y');
    // Still strips the redirecting vars even with extras present.
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
  });
});

describe('VaultGit (integration; temp repo)', () => {
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

  /** Make a fresh temp dir for one test (under the OS tmpdir, NOT the repo). */
  async function freshDir(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'docmost-vault-'));
    return dir;
  }

  it('ensureRepo creates .git + main + an initial commit', async () => {
    if (!available) return; // skip gracefully when git is unavailable
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // It is a git work-tree now.
    const { stdout: insideWt } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: vault },
    );
    expect(insideWt.trim()).toBe('true');

    // On `main`.
    expect(await git.currentBranch()).toBe('main');

    // Has the initial commit.
    expect(await headMessage(vault)).toBe('init vault');

    // Idempotent: calling again does not create a second commit.
    await git.ensureRepo();
    const { stdout: count } = await execFileAsync(
      'git',
      ['rev-list', '--count', 'HEAD'],
      { cwd: vault },
    );
    expect(count.trim()).toBe('1');
  });

  it('clearStaleGitLocks removes a leftover index.lock so git ops work again (bug D3-N3)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // Simulate an interrupted git op: a stale index.lock left behind. Git now
    // refuses index-touching operations.
    const lockPath = join(vault, '.git', 'index.lock');
    await writeFile(lockPath, '');
    // Backdate the lock beyond the staleness threshold so it is treated as a
    // genuine crash-leftover (a live/fresh lock is preserved — see the test
    // below); mtime gating only removes locks older than the threshold.
    const anHourAgo = Date.now() / 1000 - 3600;
    await utimes(lockPath, anHourAgo, anHourAgo);
    await expect(
      execFileAsync('git', ['add', '-A'], { cwd: vault }),
    ).rejects.toThrow(/index\.lock/);

    // The preflight clears it (stale by mtime, no live git process holds it).
    await git.clearStaleGitLocks();

    // The lock is gone and git ops succeed again.
    await expect(
      execFileAsync('git', ['add', '-A'], { cwd: vault }),
    ).resolves.toBeDefined();

    // Idempotent / safe when no lock exists.
    await expect(git.clearStaleGitLocks()).resolves.toBeUndefined();
  });

  it('clearStaleGitLocks PRESERVES a fresh index.lock (a concurrent replica may hold it) (bug D3-N3 / F1)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // A FRESH lock (current mtime) — as a concurrently-running replica would
    // hold mid `git add`/`commit` during the multi-replica TTL-lapse window.
    // Removing it would corrupt the index/refs, so it MUST be preserved.
    const lockPath = join(vault, '.git', 'index.lock');
    await writeFile(lockPath, '');

    await git.clearStaleGitLocks();

    // Still there: a fresh (possibly live) lock is never deleted.
    await expect(
      execFileAsync('git', ['add', '-A'], { cwd: vault }),
    ).rejects.toThrow(/index\.lock/);
  });

  it('ensureMainBranch restores a deleted main from the docmost mirror (bug D3-N1)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();
    await git.ensureBranch('docmost', 'main');

    // Ref damage: delete refs/heads/main (git refuses to delete the current
    // branch, so move HEAD to docmost first — simulating a lost main ref).
    await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/docmost'], {
      cwd: vault,
    });
    await execFileAsync('git', ['branch', '-D', 'main'], { cwd: vault });
    await expect(
      execFileAsync('git', ['rev-parse', '--verify', 'main'], { cwd: vault }),
    ).rejects.toThrow();

    // The preflight re-creates main (from docmost).
    await git.ensureMainBranch();
    await expect(
      execFileAsync('git', ['rev-parse', '--verify', 'main'], { cwd: vault }),
    ).resolves.toBeDefined();
    // Idempotent when main already exists.
    await expect(git.ensureMainBranch()).resolves.toBeUndefined();
  });

  it('ensureMainBranch restores a deleted main from HEAD when docmost is gone too (bug D3-N1)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // The reachable HEAD commit that main should be restored to.
    const { stdout: headSha } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: vault },
    );
    const expectedSha = headSha.trim();

    // Ref damage: BOTH main AND docmost are gone, only HEAD/a commit is
    // reachable. Detach HEAD (so we can delete main), then delete both branches.
    await execFileAsync('git', ['checkout', '--detach', 'HEAD'], { cwd: vault });
    await git.ensureBranch('docmost', 'main');
    await execFileAsync('git', ['branch', '-D', 'main', 'docmost'], {
      cwd: vault,
    });
    expect(await git.branchExists('main')).toBe(false);
    expect(await git.branchExists('docmost')).toBe(false);

    // The preflight re-creates main from the HEAD commit.
    await git.ensureMainBranch();
    expect(await git.branchExists('main')).toBe(true);
    const { stdout: restored } = await execFileAsync(
      'git',
      ['rev-parse', 'main'],
      { cwd: vault },
    );
    expect(restored.trim()).toBe(expectedSha);
  });

  it('ensureMainBranch is a no-op on a repo with no commit at all (bug D3-N1)', async () => {
    if (!available) return;
    const vault = await freshDir();
    // A bare `git init` — no commit, so no branch/HEAD to restore from.
    await execFileAsync('git', ['init'], { cwd: vault });
    const git = new VaultGit(vault);

    // Nothing to do (ensureRepo's fresh-init path owns this case); must not throw.
    await expect(git.ensureMainBranch()).resolves.toBeUndefined();
    expect(await git.branchExists('main')).toBe(false);
  });

  it('ensureRepo neutralizes correctness-affecting LOCAL config', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // These LOCAL values neutralize a hostile GLOBAL/system config that would
    // otherwise change porcelain BEHAVIOR and corrupt the vault (SPEC §11 for
    // core.autocrlf; gpgsign/safecrlf for the headless daemon).
    const localConfig = async (key: string): Promise<string> => {
      const { stdout } = await execFileAsync(
        'git',
        ['config', '--local', '--get', key],
        { cwd: vault },
      );
      return stdout.trim();
    };
    expect(await localConfig('core.autocrlf')).toBe('false');
    expect(await localConfig('commit.gpgsign')).toBe('false');
    expect(await localConfig('core.safecrlf')).toBe('false');
    expect(await localConfig('core.attributesFile')).toBe('/dev/null');
    // merge.conflictStyle=merge keeps conflict markers to the canonical three
    // (no diff3 `|||||||` base section) regardless of the operator's global
    // config (bug #2 marker-leak determinism, SPEC §9).
    expect(await localConfig('merge.conflictStyle')).toBe('merge');

    // Idempotent: a second run leaves the same single values (no duplicates).
    await git.ensureRepo();
    expect(await localConfig('core.autocrlf')).toBe('false');
    expect(await localConfig('commit.gpgsign')).toBe('false');
    expect(await localConfig('core.safecrlf')).toBe('false');
  });

  it('preserves LF bytes verbatim on commit (SPEC §11: autocrlf=false)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // Write content with explicit LF line endings. With a hostile
    // core.autocrlf=true git would translate these to CRLF in the stored blob,
    // breaking the byte-stable round-trip invariant. ensureRepo pins
    // core.autocrlf=false locally, so the stored bytes must round-trip exactly.
    const fileName = 'lf.md';
    const content = 'line1\nline2\nline3\n';
    await writeFile(join(vault, fileName), content, 'utf8');
    await git.stageAll();
    const made = await git.commit('add LF file', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });
    expect(made).toBe(true);

    // Read the STORED blob (not the worktree file) and assert verbatim bytes:
    // still LF-only, no CRLF translation.
    const { stdout: stored } = await execFileAsync(
      'git',
      ['--no-pager', 'show', `HEAD:${fileName}`],
      { cwd: vault, encoding: 'buffer' },
    );
    const storedBuf = stored as unknown as Buffer;
    expect(storedBuf.includes(Buffer.from('\r\n'))).toBe(false);
    expect(storedBuf.toString('utf8')).toBe(content);
  });

  it('ensureBranch creates the docmost branch from main', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    expect(await git.branchExists('docmost')).toBe(false);
    await git.ensureBranch('docmost', 'main');
    expect(await git.branchExists('docmost')).toBe(true);

    // Idempotent.
    await git.ensureBranch('docmost', 'main');
    expect(await git.branchExists('docmost')).toBe(true);
  });

  it('commit writes a commit with the provenance trailer and the bot identity', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    await writeFile(join(vault, 'page.md'), 'hello\n', 'utf8');
    await git.stageAll();
    const made = await git.commit('docmost: sync 1 page(s)', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
      trailers: ['Docmost-Sync-Source: docmost'],
    });
    expect(made).toBe(true);

    const msg = await headMessage(vault);
    expect(msg).toContain('docmost: sync 1 page(s)');
    expect(msg).toContain('Docmost-Sync-Source: docmost');

    const author = await headAuthor(vault);
    expect(author).toBe(`${BOT_AUTHOR_NAME} <${BOT_AUTHOR_EMAIL}>`);

    // The trailer is parseable by git itself.
    const { stdout: trailers } = await execFileAsync(
      'git',
      ['--no-pager', 'log', '-1', '--pretty=%(trailers:key=Docmost-Sync-Source,valueonly)'],
      { cwd: vault },
    );
    expect(trailers.trim()).toBe('docmost');
  });

  it('commit is a no-op when there is nothing to commit', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    await git.stageAll(); // nothing changed since the init commit
    const made = await git.commit('docmost: sync 0 page(s)', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
      trailers: ['Docmost-Sync-Source: docmost'],
    });
    expect(made).toBe(false);

    // Still exactly one commit (the init one).
    const { stdout: count } = await execFileAsync(
      'git',
      ['rev-list', '--count', 'HEAD'],
      { cwd: vault },
    );
    expect(count.trim()).toBe('1');
  });

  it('commit honors --no-verify (a failing pre-commit hook does not block it)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // Commit count BEFORE: just the init commit.
    const countBefore = async (): Promise<number> => {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', '--count', 'HEAD'],
        { cwd: vault },
      );
      return Number(stdout.trim());
    };
    const before = await countBefore();

    // Install an EXECUTABLE pre-commit hook that always fails. Without
    // `--no-verify`, `git commit` would run it, the hook would `exit 1`, and the
    // commit would be ABORTED. So this test fails (no commit created, made !==
    // true) the moment `--no-verify` is removed from commitRaw.
    const hookPath = join(vault, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(hookPath, 0o755);

    await writeFile(join(vault, 'hooked.md'), 'content\n', 'utf8');
    await git.stageAll();
    const made = await git.commit('commit past a failing hook', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
      trailers: ['Docmost-Sync-Source: docmost'],
    });

    // The commit was reported made AND actually landed (HEAD advanced by one).
    expect(made).toBe(true);
    expect(await countBefore()).toBe(before + 1);
    expect(await headMessage(vault)).toContain('commit past a failing hook');
  });

  it('merge fast-forwards main to docmost', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();
    await git.ensureBranch('docmost', 'main');

    // Commit a file on docmost.
    await git.checkout('docmost');
    await writeFile(join(vault, 'a.md'), 'a\n', 'utf8');
    await git.stageAll();
    await git.commit('docmost: sync 1 page(s)', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
      trailers: ['Docmost-Sync-Source: docmost'],
    });

    // main has not diverged, so the merge is a clean fast-forward.
    await git.checkout('main');
    const res = await git.merge('docmost');
    expect(res.ok).toBe(true);
    expect(res.conflict).toBe(false);

    // main now contains the file and the docmost commit.
    const tracked = await git.listTrackedFiles();
    expect(tracked).toContain('a.md');
    expect(await headMessage(vault)).toContain('docmost: sync 1 page(s)');
  });

  it('merge surfaces a conflict distinctly (no auto-resolve)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();
    await git.ensureBranch('docmost', 'main');

    // Divergent edits to the SAME file on both branches -> real conflict.
    await git.checkout('docmost');
    await writeFile(join(vault, 'c.md'), 'from docmost\n', 'utf8');
    await git.stageAll();
    await git.commit('docmost edit', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });

    await git.checkout('main');
    await writeFile(join(vault, 'c.md'), 'from main\n', 'utf8');
    await git.stageAll();
    await git.commit('main edit', {
      authorName: 'Human',
      authorEmail: 'human@local',
    });

    const res = await git.merge('docmost');
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
  });

  it('isMergeInProgress is false on a clean repo and true mid-merge', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();
    await git.ensureBranch('docmost', 'main');

    // Clean repo, no merge in progress.
    expect(await git.isMergeInProgress()).toBe(false);

    // Create a REAL conflict: divergent edits to the same file on both branches.
    await git.checkout('docmost');
    await writeFile(join(vault, 'c.md'), 'from docmost\n', 'utf8');
    await git.stageAll();
    await git.commit('docmost edit', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });

    await git.checkout('main');
    await writeFile(join(vault, 'c.md'), 'from main\n', 'utf8');
    await git.stageAll();
    await git.commit('main edit', {
      authorName: 'Human',
      authorEmail: 'human@local',
    });

    // Merge conflicts -> the repo is now left mid-merge.
    const res = await git.merge('docmost');
    expect(res.conflict).toBe(true);
    expect(await git.isMergeInProgress()).toBe(true);

    // Aborting the merge clears the in-progress state again.
    await execFileAsync('git', ['--no-pager', 'merge', '--abort'], { cwd: vault });
    expect(await git.isMergeInProgress()).toBe(false);
  });

  it('listTrackedFiles supports a glob and returns forward-slash paths', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    await writeFile(join(vault, 'keep.md'), 'k\n', 'utf8');
    await writeFile(join(vault, 'note.txt'), 't\n', 'utf8');
    await git.stageAll();
    await git.commit('add files', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });

    const md = await git.listTrackedFiles('*.md');
    expect(md).toEqual(['keep.md']);
    const all = await git.listTrackedFiles();
    expect(new Set(all)).toEqual(new Set(['keep.md', 'note.txt']));
  });

  it('listTrackedFiles returns RAW UTF-8 Cyrillic paths (not octal-escaped/quoted)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // The target wiki is Russian, so file names contain Cyrillic. With git's
    // DEFAULT core.quotepath=true these come back as `"\320\232..."` from
    // ls-files; `listTrackedFiles` must return them verbatim as UTF-8.
    const topName = 'Колонка.md';
    const nestedDir = 'Раздел';
    const nestedName = 'Подстраница.md';
    await writeFile(join(vault, topName), 'top\n', 'utf8');
    await mkdir(join(vault, nestedDir), { recursive: true });
    await writeFile(join(vault, nestedDir, nestedName), 'nested\n', 'utf8');
    await git.stageAll();
    await git.commit('add cyrillic files', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });

    const md = await git.listTrackedFiles('*.md');
    // Exact UTF-8 names, forward-slash separated for the nested one — NOT an
    // escaped/quoted form like `"\320\232..."`.
    expect(new Set(md)).toEqual(
      new Set([topName, `${nestedDir}/${nestedName}`]),
    );
    // Guard explicitly against the quotepath regression: no entry is quoted or
    // contains a backslash escape sequence.
    for (const p of md) {
      expect(p.startsWith('"')).toBe(false);
      expect(p.includes('\\')).toBe(false);
    }

    // No-glob listing also returns the raw Cyrillic names.
    const all = await git.listTrackedFiles();
    expect(all).toContain(topName);
    expect(all).toContain(`${nestedDir}/${nestedName}`);
  });

  it('assertGitAvailable resolves when git is present', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    // No repo needed: it only probes `git --version` (and the vault dir need
    // not even exist yet).
    await expect(git.assertGitAvailable()).resolves.toBeUndefined();
  });

  // --- Push-direction primitives (SPEC §6 "ФС → Docmost", FIRST increment) ---

  it('diffNameStatus parses A / M / D rows between two commits', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // Commit 1: two files (keep.md will be modified, gone.md will be deleted).
    await writeFile(join(vault, 'keep.md'), 'v1\n', 'utf8');
    await writeFile(join(vault, 'gone.md'), 'old\n', 'utf8');
    await git.stageAll();
    await git.commit('base', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });
    const base = await git.revParse('HEAD');
    expect(base).toBeTruthy();

    // Commit 2: modify keep.md, add fresh.md, delete gone.md.
    await writeFile(join(vault, 'keep.md'), 'v2\n', 'utf8');
    await writeFile(join(vault, 'fresh.md'), 'new\n', 'utf8');
    await rm(join(vault, 'gone.md'));
    await git.stageAll();
    await git.commit('change', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });

    const entries = await git.diffNameStatus(base!, 'HEAD');
    // Sort for deterministic assertion regardless of git's row order.
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get('keep.md')).toEqual({ status: 'M', path: 'keep.md' });
    expect(byPath.get('fresh.md')).toEqual({ status: 'A', path: 'fresh.md' });
    expect(byPath.get('gone.md')).toEqual({ status: 'D', path: 'gone.md' });
    expect(entries.length).toBe(3);
  });

  it('diffNameStatus parses a real rename (R) with old + new path', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // A file with enough content that git's -M rename detection ties the rename
    // to the same blob (identical content -> R100).
    const body = 'line a\nline b\nline c\nline d\n';
    await writeFile(join(vault, 'old-name.md'), body, 'utf8');
    await git.stageAll();
    await git.commit('add', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });
    const base = await git.revParse('HEAD');

    // Rename it (same content) so -M detects a rename, not delete+add.
    await rm(join(vault, 'old-name.md'));
    await writeFile(join(vault, 'new-name.md'), body, 'utf8');
    await git.stageAll();
    await git.commit('rename', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });

    const entries = await git.diffNameStatus(base!, 'HEAD');
    expect(entries.length).toBe(1);
    const r = entries[0];
    expect(r.status).toBe('R');
    expect(r.oldPath).toBe('old-name.md');
    expect(r.path).toBe('new-name.md');
    // Identical content -> a 100% similarity score.
    expect(r.score).toBe(100);
  });

  it('diffNameStatus returns RAW UTF-8 Cyrillic paths (no quoting)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    const base = await git.revParse('HEAD');
    await writeFile(join(vault, 'Статья.md'), 'тело\n', 'utf8');
    await git.stageAll();
    await git.commit('add cyrillic', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });

    const entries = await git.diffNameStatus(base!, 'HEAD');
    expect(entries).toEqual([{ status: 'A', path: 'Статья.md' }]);
  });

  it('revParse / readRef resolve a ref to a SHA, null when missing', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    const head = await git.revParse('HEAD');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // A non-existent ref resolves to null (not a throw).
    expect(await git.revParse('refs/docmost/last-pushed')).toBeNull();
    expect(await git.readRef('refs/docmost/last-pushed')).toBeNull();
  });

  it('updateRef / readRef round-trip a custom ref', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    const head = await git.revParse('HEAD');
    expect(await git.readRef('refs/docmost/last-pushed')).toBeNull();

    await git.updateRef('refs/docmost/last-pushed', head!);
    // It now resolves to the same SHA as HEAD.
    expect(await git.readRef('refs/docmost/last-pushed')).toBe(head);
    expect(await git.revParse('refs/docmost/last-pushed')).toBe(head);
  });

  it('showFileAtRef returns a committed file content and null for a missing path', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    const content = 'hello at ref\nsecond line\n';
    await writeFile(join(vault, 'doc.md'), content, 'utf8');
    await git.stageAll();
    await git.commit('add doc', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });

    // The committed file is readable at HEAD verbatim.
    expect(await git.showFileAtRef('HEAD', 'doc.md')).toBe(content);
    // A path that does not exist at that ref maps to null (not a throw).
    expect(await git.showFileAtRef('HEAD', 'nope.md')).toBeNull();
  });

  it('showFileAtRef reads a DELETED file pre-image at an earlier ref', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // Commit a tracked page, capture the ref, then delete it.
    const meta =
      '<!-- docmost:meta\n{"version":1,"pageId":"page-123"}\n-->\n\nbody\n';
    await writeFile(join(vault, 'tracked.md'), meta, 'utf8');
    await git.stageAll();
    await git.commit('add tracked', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });
    const beforeDelete = await git.revParse('HEAD');

    await rm(join(vault, 'tracked.md'));
    await git.stageAll();
    await git.commit('delete tracked', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });

    // The pre-image (pageId) is recoverable at the earlier ref even though the
    // file is gone from HEAD — this is how the push direction recovers the
    // pageId of a deleted file (SPEC §6/§8).
    expect(await git.showFileAtRef('HEAD', 'tracked.md')).toBeNull();
    const preImage = await git.showFileAtRef(beforeDelete!, 'tracked.md');
    expect(preImage).toBe(meta);
    expect(preImage).toContain('page-123');
  });

  it('fastForwardBranch advances a true fast-forward (the loop-close, SPEC §6 step 3)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // docmost branches off main at the initial commit; main then moves ahead.
    await git.ensureBranch('docmost', 'main');
    const base = await git.revParse('refs/heads/docmost');

    await writeFile(join(vault, 'page.md'), 'pushed content\n', 'utf8');
    await git.stageAll();
    await git.commit('push page', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });
    const mainTip = await git.revParse('HEAD');

    // docmost is BEHIND main and an ancestor -> a true fast-forward advances it.
    expect(await git.revParse('refs/heads/docmost')).toBe(base);
    const res = await git.fastForwardBranch('docmost', mainTip!);
    expect(res).toEqual({ ok: true });
    // The branch now points at the pushed main commit (mirror reflects Docmost).
    expect(await git.revParse('refs/heads/docmost')).toBe(mainTip);

    // It does NOT touch the working tree / current branch (still on main).
    expect(await git.currentBranch()).toBe('main');
  });

  it('fastForwardBranch is a no-op (ok) when the branch is already at the target', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();
    await git.ensureBranch('docmost', 'main');
    const mainTip = await git.revParse('HEAD');

    // Already equal -> a degenerate fast-forward, still ok, branch unchanged.
    const res = await git.fastForwardBranch('docmost', mainTip!);
    expect(res).toEqual({ ok: true });
    expect(await git.revParse('refs/heads/docmost')).toBe(mainTip);
  });

  it('fastForwardBranch REFUSES a non-fast-forward (never clobbers divergent history)', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();

    // Make docmost diverge: it has a commit that main does NOT contain.
    await git.checkout('main'); // ensure on main first
    await git.ensureBranch('docmost', 'main');
    await git.checkout('docmost');
    await writeFile(join(vault, 'only-on-docmost.md'), 'mirror-only\n', 'utf8');
    await git.stageAll();
    await git.commit('docmost-only commit', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });
    const docmostTip = await git.revParse('refs/heads/docmost');

    // main moves ahead independently (divergent from docmost).
    await git.checkout('main');
    await writeFile(join(vault, 'only-on-main.md'), 'main-only\n', 'utf8');
    await git.stageAll();
    await git.commit('main-only commit', { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL });
    const mainTip = await git.revParse('HEAD');

    // docmost is NOT an ancestor of main -> the ff is REFUSED, branch untouched.
    const res = await git.fastForwardBranch('docmost', mainTip!);
    expect(res).toEqual({ ok: false, reason: 'not-fast-forward' });
    expect(await git.revParse('refs/heads/docmost')).toBe(docmostTip);
  });

  it('fastForwardBranch refuses a missing branch / unresolved target with a reason', async () => {
    if (!available) return;
    const vault = await freshDir();
    const git = new VaultGit(vault);
    await git.ensureRepo();
    const mainTip = await git.revParse('HEAD');

    const noBranch = await git.fastForwardBranch('nope', mainTip!);
    expect(noBranch.ok).toBe(false);
    expect(noBranch.reason).toContain('nope');

    await git.ensureBranch('docmost', 'main');
    const noTarget = await git.fastForwardBranch('docmost', 'deadbeefdeadbeef');
    expect(noTarget.ok).toBe(false);
    expect(noTarget.reason).toContain('deadbeefdeadbeef');
  });
});
