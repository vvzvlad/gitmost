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

/**
 * QA #119 bug #3 — the smart-HTTP host advertises whatever `HEAD` resolves to as
 * a clone's default branch. The engine transiently checks out the read-only
 * `docmost` mirror during a cycle, so a clone racing a cycle could default to
 * `docmost`. `VaultGit.pinHeadToMain()` pins the symref back to `main` so the
 * advertised HEAD is deterministic. Verified against a REAL temp git repo,
 * including the actual `git upload-pack --advertise-refs` HEAD symref capability
 * a clone reads. Skips gracefully if git is unavailable.
 */

const execFileAsync = promisify(execFile);

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

describe('VaultGit.pinHeadToMain — advertised HEAD is stably main (real git)', () => {
  let available = false;
  let dir: string;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function headSymref(vault: string): Promise<string> {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', 'HEAD'],
      { cwd: vault },
    );
    return stdout.trim();
  }

  /** The HEAD symref a clone would read from `git upload-pack --advertise-refs`. */
  async function advertisedHead(vault: string): Promise<string | null> {
    const { stdout } = await execFileAsync(
      'git',
      ['upload-pack', '--advertise-refs', vault],
      { cwd: vault },
    );
    // protocol v0/v2 advertise `symref=HEAD:refs/heads/<branch>` in the caps.
    const m = stdout.match(/symref=HEAD:refs\/heads\/([^\s\0]+)/);
    return m ? m[1] : null;
  }

  it('pins HEAD back to main after the engine checked out docmost', async () => {
    if (!available) return;
    dir = await mkdtemp(join(tmpdir(), 'docmost-head-'));
    const git = new VaultGit(dir);
    await git.ensureRepo();
    await git.ensureBranch('docmost', 'main');
    await writeFile(join(dir, 'A.md'), 'hello\n', 'utf8');
    await git.stageAll();
    await git.commit('seed', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });
    // Keep docmost reachable as a real branch ref.
    await execFileAsync('git', ['branch', '-f', 'docmost', 'main'], { cwd: dir });

    // Simulate a cycle mid-pull: the engine checks out the read-only mirror.
    await git.checkout('docmost');
    expect(await headSymref(dir)).toBe('docmost');
    expect(await advertisedHead(dir)).toBe('docmost'); // the bug, pre-pin

    // Pin: the advertised default branch must be `main` again.
    await git.pinHeadToMain();
    expect(await headSymref(dir)).toBe('main');
    expect(await advertisedHead(dir)).toBe('main');

    // Idempotent: pinning when already on main is a clean no-op.
    await git.pinHeadToMain();
    expect(await headSymref(dir)).toBe('main');
    expect(await advertisedHead(dir)).toBe('main');
  });
});
