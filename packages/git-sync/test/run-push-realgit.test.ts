import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runPush, LAST_PUSHED_REF } from '../src/engine/push';
import type { PushDeps } from '../src/engine/push';
import { VaultGit } from '../src/engine/git';
import type { Settings } from '../src/engine/settings';
import { serializeDocmostMarkdownBody } from '@docmost/prosemirror-markdown';

const execFileAsync = promisify(execFile);

// runPush `--apply` against a REAL VaultGit in a temp repo (NO Docmost — the
// client is faked). This guards the real-git BINDING contract that the plain-
// object git fakes in run-push.test.ts cannot catch: the applier's git deps
// (`updateRef`/`fastForwardBranch`/`showFileAtRef`) call `this.run`/`this.runRaw`
// internally, so they only work when their `this` receiver is preserved. Passing
// bare method references (`git.updateRef`, …) would throw `this.runRaw is not a
// function` here. Only the LOCAL temp git is mutated; nothing is sent to Docmost.

/** True if a usable `git` binary is on PATH (skip the suite otherwise). */
async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** A minimal valid Settings fixture (only fields runPush reads matter). */
function makeSettings(vaultPath: string): Settings {
  return {
    docmostSpaceId: 'space-1',
    vaultPath,
    pollIntervalMs: 15000,
    debounceMs: 2000,
    logLevel: 'info',
  };
}

/** A recording client fake; createPage returns an assigned id + updatedAt. */
function makeClientFake() {
  return {
    // Empty live tree -> the create takes the normal createPage path (the
    // retry-adopt lookup matches only on a live (parentPageId, title) node).
    listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
    importPageMarkdown: vi.fn(async () => ({
      data: { updatedAt: '2026-06-20T00:00:00.000Z' },
      success: true,
    })),
    createPage: vi.fn(async (title: string) => ({
      data: { id: 'new-id', title, updatedAt: '2026-06-20T00:00:00.000Z' },
      success: true,
    })),
    deletePage: vi.fn(async () => ({ success: true })),
    movePage: vi.fn(async () => ({ success: true })),
    renamePage: vi.fn(async () => ({ success: true })),
  };
}

describe('runPush --apply against a REAL VaultGit (binding contract)', () => {
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

  it('writes through real git: createPage runs, last-pushed advances, no throw', async () => {
    if (!available) return; // skip gracefully when git is unavailable

    // Temp vault repo under the OS tmpdir (mirrors test/git.test.ts setup).
    dir = await mkdtemp(join(tmpdir(), 'docmost-push-realgit-'));
    const vault = dir;
    const git = new VaultGit(vault);
    await git.ensureRepo();
    // The `docmost` mirror branches off `main` at the initial commit; this is
    // also the diff base (last-pushed is unset, so runPush falls back to it).
    await git.ensureBranch('docmost', 'main');

    // A brand-new local file with meta carrying title + spaceId but NO pageId,
    // committed on `main` AHEAD of the base -> computePushActions yields a CREATE.
    const newFile = serializeDocmostMarkdownBody(
      { version: 1, title: 'New', spaceId: 'sp-1' },
      'fresh body',
    );
    await writeFile(join(vault, 'New.md'), newFile, 'utf8');
    await git.stageAll();
    await git.commit('add New.md', {
      authorName: 'Human',
      authorEmail: 'human@local',
    });

    // last-pushed must be UNSET so the run actually advances it for the first time.
    expect(await git.revParse(LAST_PUSHED_REF)).toBeNull();

    const client = makeClientFake();
    const logs: string[] = [];
    const deps: PushDeps = {
      settings: makeSettings(vault),
      // The WHOLE real VaultGit — its methods must keep their `this` binding.
      git,
      makeClient: () => client as any,
      readFile: (path) =>
        import('node:fs/promises').then((fs) =>
          fs.readFile(join(vault, ...path.split('/')), 'utf8'),
        ),
      writeFile: async (path, text) => {
        const fs = await import('node:fs/promises');
        await fs.writeFile(join(vault, ...path.split('/')), text, 'utf8');
      },
      log: (line) => logs.push(line),
    };

    // The run must NOT throw — this is what FAILS before Fix 1 (the bare-method
    // git deps would throw `this.runRaw is not a function` on the real VaultGit).
    const res = await runPush(deps, { dryRun: false });

    expect(res.mode).toBe('apply');
    expect(res.failures).toEqual([]);
    // The FAKE client was actually called (the write path ran).
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(res.applied?.created).toBe(1);
    // The assigned pageId was written back to disk + committed.
    expect(res.applied?.writtenBack).toEqual([{ path: 'New.md', pageId: 'new-id' }]);

    // CRITICALLY: refs/docmost/last-pushed ACTUALLY advanced in the real repo —
    // it now resolves to a real commit (proving updateRef ran with binding).
    const lastPushed = await git.revParse(LAST_PUSHED_REF);
    expect(lastPushed).toMatch(/^[0-9a-f]{40}$/);
    expect(res.divergentDocmost).toBe(false);
  });
});
