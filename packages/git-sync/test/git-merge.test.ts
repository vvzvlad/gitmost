import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  VaultGit,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
} from '../src/engine/git';

// git 3-way merge integration (test-strategy report §2 git gap). The existing
// git.test.ts covers a fast-forward merge and a conflicting merge; this file
// adds the two MISSING cases against a REAL temp git repo under os.tmpdir():
//   1. a clean NON-fast-forward 3-way merge of non-overlapping changes ->
//      { ok:true, conflict:false } and a real merge commit (two parents);
//   2. a NON-conflict merge FAILURE -> { ok:false, conflict:false } so the pull
//      cycle does not mislabel it a "conflict markers in vault" situation.
// The conflicting-merge case (markers + conflict:true) already lives in
// git.test.ts and is NOT duplicated here. Skips gracefully if git is missing.

const execFileAsync = promisify(execFile);

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** Number of parents of HEAD (2 => a real merge commit). */
async function headParentCount(dir: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-pager', 'rev-list', '--parents', '-n', '1', 'HEAD'],
    { cwd: dir },
  );
  // Output: "<commit> <parent1> <parent2?>..." — parents are the trailing ids.
  return stdout.trim().split(/\s+/).length - 1;
}

describe('VaultGit.merge — 3-way merge integration (temp repo)', () => {
  let available = false;
  let dir: string;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function freshRepo(): Promise<{ vault: string; git: VaultGit }> {
    dir = await mkdtemp(join(tmpdir(), 'docmost-merge-'));
    const git = new VaultGit(dir);
    await git.ensureRepo();
    await git.ensureBranch('docmost', 'main');
    return { vault: dir, git };
  }

  async function commit(
    git: VaultGit,
    subject: string,
    author = { name: BOT_AUTHOR_NAME, email: BOT_AUTHOR_EMAIL },
  ): Promise<void> {
    await git.stageAll();
    await git.commit(subject, {
      authorName: author.name,
      authorEmail: author.email,
    });
  }

  it('clean NON-fast-forward 3-way merge of non-overlapping changes -> merge commit', async () => {
    if (!available) return; // skip gracefully when git is unavailable
    const { vault, git } = await freshRepo();

    // Seed a shared base file on main so both branches diverge from a real
    // merge-base (not an empty tree).
    await writeFile(join(vault, 'base.md'), 'shared base\n', 'utf8');
    await commit(git, 'base');
    // Re-create docmost from this base so the merge-base is `base`.
    await execFileAsync('git', ['--no-pager', 'branch', '-f', 'docmost', 'main'], {
      cwd: vault,
    });

    // docmost adds doc-only.md (a DIFFERENT file than main touches).
    await git.checkout('docmost');
    await writeFile(join(vault, 'doc-only.md'), 'from docmost\n', 'utf8');
    await commit(git, 'docmost: add doc-only');

    // main adds main-only.md AND advances past the merge-base, so the merge can
    // NOT fast-forward — it must create a real 3-way merge commit.
    await git.checkout('main');
    await writeFile(join(vault, 'main-only.md'), 'from main\n', 'utf8');
    await commit(git, 'local: add main-only', {
      name: 'Human',
      email: 'human@local',
    });

    const res = await git.merge('docmost');
    expect(res.ok).toBe(true);
    expect(res.conflict).toBe(false);

    // A real (non-FF) merge: HEAD has TWO parents.
    expect(await headParentCount(vault)).toBe(2);

    // Both non-overlapping changes are present on main after the merge.
    const tracked = await git.listTrackedFiles();
    expect(new Set(tracked)).toEqual(
      new Set(['base.md', 'main-only.md', 'doc-only.md']),
    );
  });

  it('NON-conflict merge FAILURE -> { ok:false, conflict:false } (not mislabeled a conflict)', async () => {
    if (!available) return;
    const { vault, git } = await freshRepo();

    // base file on main, then fork docmost from this base.
    await writeFile(join(vault, 'f.md'), 'base\n', 'utf8');
    await commit(git, 'base');
    await execFileAsync('git', ['--no-pager', 'branch', '-f', 'docmost', 'main'], {
      cwd: vault,
    });

    // docmost modifies f.md (committed).
    await git.checkout('docmost');
    await writeFile(join(vault, 'f.md'), 'docmost change\n', 'utf8');
    await commit(git, 'docmost: edit f');

    // Back on main, leave an UNCOMMITTED local change to f.md. git refuses the
    // merge ("Your local changes ... would be overwritten by merge") and exits
    // non-zero — but there are NO unmerged index paths, so this is a clean
    // FAILURE, not a conflict. `merge()` must report { ok:false, conflict:false }
    // so pull.ts does not falsely claim conflict markers are in the vault.
    await git.checkout('main');
    await writeFile(join(vault, 'f.md'), 'uncommitted local edit\n', 'utf8');
    // NOTE: deliberately NOT staged/committed.

    const res = await git.merge('docmost');
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(false);
    // The merge did not start: HEAD is still a single-parent commit.
    expect(await headParentCount(vault)).toBe(1);
    // And the repo is NOT left mid-merge (no MERGE_HEAD / unmerged paths).
    expect(await git.isMergeInProgress()).toBe(false);
  });
});
