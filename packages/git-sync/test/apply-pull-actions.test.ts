import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { applyPullActions } from '../src/engine/pull';
import type {
  PullActions,
  ApplyPullActionsDeps,
} from '../src/engine/pull';
import type { DeletionDecision } from '../src/engine/reconcile';

// R-Pull-2 (test-strategy report §5): `applyPullActions` is the THIN IO half of
// the pull cycle. These tests drive it with FAKES that record every call — no
// real git, fs, or network — so the ordering and the ⭐ move-on-success
// data-loss guard are verifiable. SPEC §8 (delete suppression) + SPEC §5 (commit
// subject reflects ACTUAL counts) are asserted here.

const VAULT = '/vault';

/** A getPageJson fake: returns a minimal page whose content stabilizes cheaply. */
function makeClient(opts?: { failFor?: Set<string> }) {
  const calls: string[] = [];
  const client = {
    getPageJson: vi.fn(async (pageId: string) => {
      calls.push(pageId);
      if (opts?.failFor?.has(pageId)) {
        throw new Error(`fetch failed for ${pageId}`);
      }
      return {
        id: pageId,
        slugId: `slug-${pageId}`,
        title: `Title ${pageId}`,
        spaceId: 'space',
        parentPageId: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
        // A trivial doc so stabilizePageFile (the real one) runs fast.
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: pageId }] },
          ],
        },
      };
    }),
  };
  return { client, calls };
}

/** A git fake recording the order of ops; merge result is configurable. */
function makeGit(
  merge: { ok: boolean; conflict: boolean; output?: string } = {
    ok: true,
    conflict: false,
  },
  conflictStages?: {
    unmerged?: string[];
    /** path -> { ours, theirs } blob content for showStage(2|3, path). */
    stages?: Record<string, { ours: string | null; theirs: string | null }>;
  },
) {
  const order: string[] = [];
  let committedSubject: string | undefined;
  const unmerged = conflictStages?.unmerged ?? ['Conflicted.md'];
  // Default stages: genuinely-different ours/theirs (a real same-block conflict).
  const stages = conflictStages?.stages ?? {
    'Conflicted.md': { ours: 'git side\n', theirs: 'docmost side\n' },
  };
  const git = {
    stageAll: vi.fn(async () => {
      order.push('stageAll');
    }),
    commit: vi.fn(async (subject: string) => {
      order.push(`commit:${subject}`);
      committedSubject = subject;
      return true;
    }),
    checkout: vi.fn(async (branch: string) => {
      order.push(`checkout:${branch}`);
    }),
    merge: vi.fn(async () => {
      order.push('merge');
      return { ok: merge.ok, conflict: merge.conflict, output: merge.output ?? '' };
    }),
    listUnmergedPaths: vi.fn(async () => unmerged),
    showStage: vi.fn(async (stage: 1 | 2 | 3, path: string) => {
      const s = stages[path];
      if (!s) return null;
      return stage === 2 ? s.ours : stage === 3 ? s.theirs : null;
    }),
    commitMerge: vi.fn(async (subject: string) => {
      order.push(`commitMerge:${subject}`);
    }),
  };
  return {
    git,
    order,
    get committedSubject() {
      return committedSubject;
    },
  };
}

/** A recording fs fake: writes/mkdirs/rms tracked in arrays. */
function makeFs(opts?: { failWriteFor?: Set<string> }) {
  const writes: { abs: string; text: string }[] = [];
  const mkdirs: string[] = [];
  const rms: string[] = [];
  const fs = {
    writeFile: vi.fn(async (abs: string, text: string) => {
      // Fail a specific destination path if asked (to simulate a write failure).
      if (opts?.failWriteFor?.has(abs)) {
        throw new Error(`write failed for ${abs}`);
      }
      writes.push({ abs, text });
    }),
    mkdir: vi.fn(async (abs: string) => {
      mkdirs.push(abs);
    }),
    rm: vi.fn(async (abs: string) => {
      rms.push(abs);
    }),
  };
  return { fs, writes, mkdirs, rms };
}

// A single injected `log` spy mirrors the push side: applyPullActions now routes
// EVERY cycle diagnostic through `deps.log` (one channel), so tests inspect this
// spy instead of console.warn/console.error. `deps()` creates a fresh spy per
// call and stashes it on `lastLog` for the current test to assert against.
let lastLog: ReturnType<typeof vi.fn>;

function deps(
  client: any,
  git: any,
  fs: ReturnType<typeof makeFs>,
): ApplyPullActionsDeps {
  lastLog = vi.fn();
  return {
    client,
    git,
    writeFile: fs.fs.writeFile,
    mkdir: fs.fs.mkdir,
    rm: fs.fs.rm,
    log: lastLog,
  };
}

const APPLY: DeletionDecision = { apply: true };

function actions(partial: Partial<PullActions>): PullActions {
  return {
    toWrite: [],
    moved: [],
    toDelete: [],
    deletionDecision: APPLY,
    existingCount: 0,
    plannedDeleteCount: 0,
    ...partial,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyPullActions — happy path (write + commit + merge)', () => {
  it('fetches, writes each page, stages, commits, checks out main, merges', async () => {
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [
          { pageId: 'p1', relPath: 'A.md' },
          { pageId: 'p2', relPath: 'Sub/B.md' },
        ],
      }),
      VAULT,
    );

    expect(res.written).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.committed).toBe(true);
    expect(res.merge).toEqual({ ok: true, conflict: false, output: '' });

    // Both pages were fetched and written at their absolute paths.
    expect(client.getPageJson).toHaveBeenCalledTimes(2);
    const writtenPaths = fs.writes.map((w) => w.abs).sort();
    expect(writtenPaths).toEqual(['/vault/A.md', '/vault/Sub/B.md']);

    // Every written file is in the native-Obsidian format: a `gitmost_id`
    // frontmatter at the very top and NO legacy `docmost:meta` envelope. Guards
    // against a regression back to the heavy meta block.
    for (const w of fs.writes) {
      expect(w.text.startsWith('---\ngitmost_id: ')).toBe(true);
      expect(w.text).not.toContain('docmost:meta');
    }

    // The git op order is: stageAll -> commit -> checkout main -> merge.
    expect(g.order).toEqual([
      'stageAll',
      `commit:docmost: sync 2 page(s)`,
      'checkout:main',
      'merge',
    ]);
  });
});

describe('applyPullActions — ordering (write before move/delete before commit)', () => {
  it('does writes, then move-old-path removals, then deletes, then commit/merge', async () => {
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'Old/M.md',
            toRelPath: 'New/M.md',
            removeOldPath: true,
          },
        ],
        toDelete: ['Dead.md'],
        plannedDeleteCount: 1,
        existingCount: 3,
      }),
      VAULT,
    );

    // The write to the new path happened (the page was fetched first).
    expect(fs.writes.map((w) => w.abs)).toEqual(['/vault/New/M.md']);
    // The move old-path removal AND the absence delete both ran, old path first.
    expect(fs.rms).toEqual(['/vault/Old/M.md', '/vault/Dead.md']);
    // git ops happen AFTER all fs work.
    expect(g.order).toEqual([
      'stageAll',
      'commit:docmost: sync 1 page(s), 1 deleted',
      'checkout:main',
      'merge',
    ]);
  });
});

describe('applyPullActions — ⭐ data-loss guard (move-on-success)', () => {
  it('does NOT remove the OLD path when the new-path write FAILS', async () => {
    // The page "m" is being moved Old/M.md -> New/M.md, but its new-path write
    // FAILS. Removing the old path now would erase the only copy of the page.
    // The guard must KEEP the old path.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs({ failWriteFor: new Set(['/vault/New/M.md']) });

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'Old/M.md',
            toRelPath: 'New/M.md',
            removeOldPath: true,
          },
        ],
      }),
      VAULT,
    );

    // The write failed -> recorded as a failure, nothing written.
    expect(res.failed).toBe(1);
    expect(res.written).toBe(0);
    expect(fs.writes).toEqual([]);
    // ⭐ The OLD path was NOT removed: the data-loss guard kept it.
    expect(fs.rms).not.toContain('/vault/Old/M.md');
    expect(fs.rms).toEqual([]);
    expect(res.movedApplied).toBe(0);

    // The commit subject reflects ACTUAL counts: 0 written, 0 deleted.
    expect(g.committedSubject).toBe('docmost: sync 0 page(s)');
  });

  it('DOES remove the old path when the new-path write SUCCEEDS', async () => {
    // Same move, but the write succeeds -> the old path is safely removed. This
    // is the positive control proving the guard is keyed on write success.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs(); // no write failures

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'Old/M.md',
            toRelPath: 'New/M.md',
            removeOldPath: true,
          },
        ],
      }),
      VAULT,
    );

    expect(res.written).toBe(1);
    expect(res.movedApplied).toBe(1);
    expect(fs.rms).toContain('/vault/Old/M.md');
    expect(g.committedSubject).toBe('docmost: sync 1 page(s)');
  });

  it('honours removeOldPath:false (path reused by another live page is kept)', async () => {
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'X.md',
            toRelPath: 'New/M.md',
            removeOldPath: false, // X.md is a live target of another page
          },
        ],
      }),
      VAULT,
    );

    // The reused old path is never removed.
    expect(fs.rms).not.toContain('/vault/X.md');
    expect(fs.rms).toEqual([]);
  });
});

describe('applyPullActions — deletion suppression (SPEC §8)', () => {
  it('skips deletions when the decision SUPPRESSES them (toDelete already empty)', async () => {
    // computePullActions empties toDelete when suppressed, but assert the applier
    // ALSO does no removals and the subject omits the deleted count.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'p1', relPath: 'A.md' }],
        // Suppressed: toDelete is empty even though 5 were planned.
        toDelete: [],
        deletionDecision: { apply: false, reason: 'incomplete-fetch' },
        plannedDeleteCount: 5,
        existingCount: 6,
      }),
      VAULT,
    );

    expect(res.deleted).toBe(0);
    expect(fs.rms).toEqual([]);
    // Subject reflects 0 deleted (no ", N deleted" suffix).
    expect(g.committedSubject).toBe('docmost: sync 1 page(s)');
    // The suppression warning was emitted.
    expect(lastLog).toHaveBeenCalledWith(
      expect.stringMatching(/tree fetch incomplete/),
    );
  });

  it('applies deletions present in toDelete when the decision allows them', async () => {
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'p1', relPath: 'A.md' }],
        toDelete: ['Dead1.md', 'Dead2.md'],
        deletionDecision: APPLY,
        plannedDeleteCount: 2,
        existingCount: 5,
      }),
      VAULT,
    );

    expect(res.deleted).toBe(2);
    expect(fs.rms).toEqual(['/vault/Dead1.md', '/vault/Dead2.md']);
    // Subject reflects ACTUAL written + deleted counts.
    expect(g.committedSubject).toBe('docmost: sync 1 page(s), 2 deleted');
  });
});

describe('applyPullActions — commit subject reflects ACTUAL counts', () => {
  it('counts only SUCCESSFUL writes when some page fetches fail', async () => {
    // p2 fetch fails; the subject must say 1 page (only p1 was written), not 2.
    const { client } = makeClient({ failFor: new Set(['p2']) });
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [
          { pageId: 'p1', relPath: 'A.md' },
          { pageId: 'p2', relPath: 'B.md' },
        ],
      }),
      VAULT,
    );

    expect(res.written).toBe(1);
    expect(res.failed).toBe(1);
    expect(g.committedSubject).toBe('docmost: sync 1 page(s)');
  });
});

describe('applyPullActions — merge result is surfaced, not swallowed', () => {
  it('GENUINE conflict: auto-resolves to OURS (git wins), no markers, surfaces conflictedPaths', async () => {
    // QA #119 round-2: a genuine same-block docmost -> main conflict must NOT be
    // committed with raw markers onto `main` (external clones would see them and
    // the body re-conflicts forever). It is auto-resolved to the git/main side
    // (git wins, SPEC §9), the conflicted page is surfaced in `conflictedPaths`,
    // and the merge is committed CLEAN (no wedge).
    const { client } = makeClient();
    const g = makeGit(
      { ok: false, conflict: true, output: 'CONFLICT' },
      {
        unmerged: ['Conflicted.md'],
        stages: {
          'Conflicted.md': { ours: 'git wins body\n', theirs: 'docmost body\n' },
        },
      },
    );
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({ toWrite: [{ pageId: 'p1', relPath: 'A.md' }] }),
      VAULT,
    );
    // A genuine conflict was detected and auto-resolved (git won): reported as a
    // (now-clean) committed merge with the conflicting page surfaced.
    expect(res.merge.conflict).toBe(true);
    expect(res.merge.ok).toBe(true);
    expect(res.conflictedPaths).toEqual(['Conflicted.md']);
    // The conflicted file was rewritten with OURS (git side) — NO markers.
    const resolved = fs.writes.find((w) => w.abs === '/vault/Conflicted.md');
    expect(resolved?.text).toBe('git wins body\n');
    expect(resolved?.text).not.toContain('<<<<<<<');
    expect(resolved?.text).not.toContain('>>>>>>>');
    // The merge was COMMITTED (vault no longer mid-merge).
    expect(g.git.commitMerge).toHaveBeenCalledTimes(1);
    expect(g.order.some((o) => o.startsWith('commitMerge:'))).toBe(true);
  });

  it('SPURIOUS conflict (trailing-blank only): normalizes clean, NOT reported as a conflict', async () => {
    // Root-cause fix: when the two sides differ ONLY in trailing/empty lines (the
    // normalize-on-write form vs a user's blank-line append), the conflict is
    // spurious — both normalize to the same text. It is resolved to the normalized
    // form (no markers) and NOT counted as a conflict (so /status does not cry wolf).
    const { client } = makeClient();
    const g = makeGit(
      { ok: false, conflict: true, output: 'CONFLICT' },
      {
        unmerged: ['Trailing.md'],
        stages: {
          // Same content; OURS has a double-blank-line append, THEIRS is normalized.
          'Trailing.md': { ours: 'Hello world\n\n\n', theirs: 'Hello world\n' },
        },
      },
    );
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({ toWrite: [{ pageId: 'p1', relPath: 'A.md' }] }),
      VAULT,
    );
    // No GENUINE conflict — reported clean.
    expect(res.merge.conflict).toBe(false);
    expect(res.merge.ok).toBe(true);
    expect(res.conflictedPaths).toEqual([]);
    // The file was rewritten to the canonical normalized form (single trailing \n).
    const resolved = fs.writes.find((w) => w.abs === '/vault/Trailing.md');
    expect(resolved?.text).toBe('Hello world\n');
    // Still committed (clears the merge), but as a clean merge.
    expect(g.git.commitMerge).toHaveBeenCalledTimes(1);
  });

  // NULL-EDGE coverage (round-2 review F1): the genuine-conflict branch resolves
  // to `ours ?? theirs`. The two cases where a stage is ABSENT are the
  // data-preservation core on the published `main` and were previously untested.
  it('NULL-EDGE modify/delete (ours absent): keeps THEIRS so the surviving edit is not dropped', async () => {
    // modify/delete conflict: OUR side (main) deleted the page (stage 2 absent),
    // but THEIR side (docmost) still has a modified body. Losing the `?? theirs`
    // fallback here would silently drop a surviving Docmost edit. The resolution
    // must keep theirs — marker-free — on `main`.
    const { client } = makeClient();
    const g = makeGit(
      { ok: false, conflict: true, output: 'CONFLICT (modify/delete)' },
      {
        unmerged: ['Gone.md'],
        stages: {
          'Gone.md': { ours: null, theirs: 'surviving docmost body\n' },
        },
      },
    );
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({ toWrite: [] }),
      VAULT,
    );

    expect(res.merge.conflict).toBe(true);
    expect(res.merge.ok).toBe(true);
    expect(res.conflictedPaths).toEqual(['Gone.md']);
    // `resolved = ours ?? theirs` fell through to THEIRS (content preserved).
    const w = fs.writes.find((x) => x.abs === '/vault/Gone.md');
    expect(w?.text).toBe('surviving docmost body\n');
    expect(w?.text).not.toContain('<<<<<<<');
    expect(w?.text).not.toContain('>>>>>>>');
    // The merge was committed clean (no wedge).
    expect(g.git.commitMerge).toHaveBeenCalledTimes(1);
  });

  it('NULL-EDGE delete/delete (both absent): writes NOTHING; commitMerge stages the deletion', async () => {
    // delete/delete conflict: BOTH sides removed the path (stage 2 AND 3 absent),
    // so `resolved = ours ?? theirs` is null. The file must NOT be re-created;
    // commitMerge's `git add -A` stages the deletion. A regression that wrongly
    // wrote on the both-null path would resurrect a page both sides deleted.
    const { client } = makeClient();
    const g = makeGit(
      { ok: false, conflict: true, output: 'CONFLICT' },
      {
        unmerged: ['Both.md'],
        stages: {
          'Both.md': { ours: null, theirs: null },
        },
      },
    );
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({ toWrite: [] }),
      VAULT,
    );

    // The path is surfaced as a resolved conflict, the merge committed clean...
    expect(res.merge.conflict).toBe(true);
    expect(res.merge.ok).toBe(true);
    expect(res.conflictedPaths).toEqual(['Both.md']);
    // ...but NOTHING was written for it (resolved === null): no re-creation.
    expect(fs.writes.find((x) => x.abs === '/vault/Both.md')).toBeUndefined();
    expect(fs.writes).toEqual([]);
    expect(g.git.commitMerge).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false conflict:false on a non-conflict merge failure', async () => {
    const { client } = makeClient();
    const g = makeGit({ ok: false, conflict: false, output: 'some error' });
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({ toWrite: [{ pageId: 'p1', relPath: 'A.md' }] }),
      VAULT,
    );
    expect(res.merge.ok).toBe(false);
    expect(res.merge.conflict).toBe(false);
  });
});

// ===========================================================================
// R-Pull-2 coverage gaps (review-driven): the suppression warning FORKS for
// `empty-live` and `mass-delete` reasons (pull.ts 278-290), and the
// fault-tolerant `removePath` catch branch (pull.ts 354-364) where `deps.rm`
// REJECTS. The existing block above only exercises the `incomplete-fetch`
// reason and an rm that always succeeds.
//
// Helper: build a deps object whose `rm` rejects for a chosen set of absolute
// paths and resolves otherwise. We override the recording fs's `rm` (a vi.fn)
// in place so `fs.rms` still records the SUCCESSFUL calls only (a rejecting rm
// throws before pushing), matching the real `node:fs/promises` semantics where
// a thrown rm performed no removal.
function makeFsWithRejectingRm(rejectFor: Set<string>) {
  const base = makeFs();
  base.fs.rm = vi.fn(async (abs: string) => {
    if (rejectFor.has(abs)) {
      throw new Error(`rm failed for ${abs}`);
    }
    base.rms.push(abs);
  });
  return base;
}

describe('applyPullActions — suppression warning forks (empty-live / mass-delete)', () => {
  it('emits the empty-live warning (with existingCount) and performs no removals', async () => {
    // SPEC §8 empty-live fork: live fetch returned 0 pages but files are
    // tracked. Mirrors the incomplete-fetch suppression test, but the message
    // text + its `existingCount` interpolation are a DISTINCT branch.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'p1', relPath: 'A.md' }],
        toDelete: [], // suppressed -> already empty
        deletionDecision: { apply: false, reason: 'empty-live' },
        plannedDeleteCount: 3,
        existingCount: 4,
      }),
      VAULT,
    );

    expect(res.deleted).toBe(0);
    expect(fs.rms).toEqual([]);
    // The empty-live message names the tracked-file count and "deletions
    // suppressed".
    expect(lastLog).toHaveBeenCalledWith(
      expect.stringMatching(/live fetch returned 0 pages but 4 file\(s\) are tracked/),
    );
    expect(lastLog).toHaveBeenCalledWith(
      expect.stringMatching(/deletions suppressed/),
    );
  });

  it('emits the mass-delete guard warning (with planned AND existing counts) and performs no removals', async () => {
    // SPEC §8 mass-delete fork (the final else branch): the message
    // interpolates BOTH plannedDeleteCount and existingCount ("would delete N
    // of M"), distinct from the other two suppression messages.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'p1', relPath: 'A.md' }],
        toDelete: [],
        deletionDecision: { apply: false, reason: 'mass-delete' },
        plannedDeleteCount: 5,
        existingCount: 6,
      }),
      VAULT,
    );

    expect(res.deleted).toBe(0);
    expect(fs.rms).toEqual([]);
    expect(lastLog).toHaveBeenCalledWith(
      expect.stringMatching(/plan would delete 5 of 6 tracked file\(s\) \(mass-delete guard\)/),
    );
    expect(lastLog).toHaveBeenCalledWith(
      expect.stringMatching(/deletions suppressed/),
    );
  });
});

describe('applyPullActions — removePath fault tolerance (rm REJECTS)', () => {
  it('does NOT reject, logs the failure, and does not count the failed removal', async () => {
    // pull.ts removePath catch: when `deps.rm` throws, it logs via the injected
    // `log` and returns false; the run continues. Existing delete tests use an rm
    // that always succeeds, leaving this catch branch uncovered.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFsWithRejectingRm(new Set(['/vault/Dead.md']));

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [],
        toDelete: ['Dead.md'],
        deletionDecision: APPLY,
        plannedDeleteCount: 1,
        existingCount: 1,
      }),
      VAULT,
    );

    // Resolved (not rejected) — the pull is fault-tolerant.
    expect(res.deleted).toBe(0);
    // removePath's catch logs "pull: failed to delete Dead.md: ...".
    expect(lastLog).toHaveBeenCalledWith(
      expect.stringMatching(/failed to .* Dead\.md/),
    );
    // The (would-be) removal never succeeded, so nothing was recorded.
    expect(fs.rms).toEqual([]);
  });

  it('counts ONLY successful removals on a partial-failure delete batch (1 reject of 3)', async () => {
    // pull.ts 388-391 increments `deleted` only when removePath returns true.
    // Here Dead1/Dead3 succeed and Dead2 rejects -> deleted === 2, and the
    // deleted>0 subject branch (399-400) fires with written=0.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFsWithRejectingRm(new Set(['/vault/Dead2.md']));

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [],
        moved: [],
        toDelete: ['Dead1.md', 'Dead2.md', 'Dead3.md'],
        deletionDecision: APPLY,
        plannedDeleteCount: 3,
        existingCount: 5,
      }),
      VAULT,
    );

    expect(res.deleted).toBe(2);
    expect(fs.rms).toEqual(['/vault/Dead1.md', '/vault/Dead3.md']);
    expect(g.committedSubject).toBe('docmost: sync 0 page(s), 2 deleted');
    // Exactly one rejection was logged (Dead2.md). Other diagnostics share the
    // `log` channel, so count ONLY the "failed to ..." failure lines.
    const failLines = lastLog.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m: string) => /failed to /.test(m));
    expect(failLines.length).toBe(1);
    expect(failLines[0]).toMatch(/failed to .* Dead2\.md/);
    // The run still reached commit + checkout + merge.
    expect(g.order).toEqual([
      'stageAll',
      'commit:docmost: sync 0 page(s), 2 deleted',
      'checkout:main',
      'merge',
    ]);
  });
});

describe('applyPullActions — move old-path removal rejects vs move-write fails', () => {
  it('a move old-path rm REJECTION does not increment movedApplied but an independent delete still succeeds', async () => {
    // pull.ts 383 increments movedApplied only when removePath of the old path
    // succeeds. Here the new-path write SUCCEEDS (so the page is not in
    // failedPageIds and the move loop proceeds to rm) but the old-path rm
    // REJECTS — distinct from the move-write-failure guard at 376. An absence
    // delete in the same run must still succeed independently.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFsWithRejectingRm(new Set(['/vault/Old/M.md']));

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'Old/M.md',
            toRelPath: 'New/M.md',
            removeOldPath: true,
          },
        ],
        toDelete: ['Dead.md'],
        deletionDecision: APPLY,
        plannedDeleteCount: 1,
        existingCount: 3,
      }),
      VAULT,
    );

    expect(res.written).toBe(1);
    expect(res.movedApplied).toBe(0); // old-path rm failed -> not counted
    expect(res.deleted).toBe(1); // independent absence delete still succeeded
    expect(fs.rms).toEqual(['/vault/Dead.md']); // Old/M.md rm threw, not recorded
    expect(g.committedSubject).toBe('docmost: sync 1 page(s), 1 deleted');
    // The failure log named the moved old path.
    expect(lastLog).toHaveBeenCalledWith(
      expect.stringMatching(/failed to .* Old\/M\.md/),
    );
  });

  it('a move-write FAILURE keeps the old path: rm is never attempted for it (data-loss guard, 374-383)', async () => {
    // Distinct branch from the move-old-path rm rejection above: here the
    // new-path WRITE itself fails, so `m` enters failedPageIds and the move
    // loop short-circuits BEFORE calling rm — emitting a warning via the
    // injected `log` and PRESERVING the old path (the only copy).
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs({ failWriteFor: new Set(['/vault/New/M.md']) });

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'Old/M.md',
            toRelPath: 'New/M.md',
            removeOldPath: true,
          },
        ],
        toDelete: [],
        deletionDecision: APPLY,
        plannedDeleteCount: 0,
        existingCount: 1,
      }),
      VAULT,
    );

    expect(res.written).toBe(0);
    expect(res.movedApplied).toBe(0);
    // The old path was NEVER removed (rm not even attempted for it).
    expect(fs.fs.rm).not.toHaveBeenCalledWith('/vault/Old/M.md');
    expect(fs.rms).toEqual([]);
    // The "keeping old path" warning fired exactly once for `m`.
    const warnCalls = lastLog.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m: string) => m.includes('move write for m failed'));
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toContain('keeping old path Old/M.md');
    // deleted === 0 -> no ", N deleted" suffix.
    expect(g.committedSubject).toBe('docmost: sync 0 page(s)');
  });
});
