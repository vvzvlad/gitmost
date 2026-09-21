import { describe, expect, it, vi } from 'vitest';
import {
  runPush,
  LAST_PUSHED_REF,
  DOCMOST_BRANCH,
  CONFLICT_MARKERS_FAILURE_REASON,
} from '../src/engine/push';
import type { PushDeps } from '../src/engine/push';
import type { Settings } from '../src/engine/settings';
import { runCycle, type RunCycleDeps } from '../src/engine/cycle';
import { serializePageFile } from '@docmost/prosemirror-markdown';

// Red-team confirmations for PR #119 (git-sync). Each test asserts the DESIRED
// behavior, so it FAILS today iff the bug is real.

function makeSettings(): Settings {
  return {
    docmostSpaceId: 'space-1',
    vaultPath: '/vault',
    pollIntervalMs: 15000,
    debounceMs: 2000,
    logLevel: 'info',
  } as Settings;
}

// ---------------------------------------------------------------------------
// #13 — conflict markers must never reach Docmost (SPEC §9), even when there is
// NO in-progress merge (markers committed on `main` by some other path). The
// behavior is now gated by the per-space `autoMergeConflicts` setting:
//   - DEFAULT (off): a still-conflicted page is NOT pushed — it is recorded as a
//     per-page FAILURE and the refs are NOT advanced, so the user resolves the
//     git conflict first.
//   - ON: the marker lines are stripped and both sides' content is pushed.
// ---------------------------------------------------------------------------
function makePushGit(opts: {
  changes: { status: 'A' | 'M' | 'D' | 'R' | 'C'; path: string; oldPath?: string }[];
  lastPushed?: string | null;
}) {
  const calls = { updateRef: [] as { ref: string; target: string }[] };
  const git: PushDeps['git'] = {
    assertGitAvailable: vi.fn(async () => {}),
    ensureRepo: vi.fn(async () => {}),
    clearStaleGitLocks: vi.fn(async () => {}),
    ensureMainBranch: vi.fn(async () => {}),
    isMergeInProgress: vi.fn(async () => false), // NO merge in progress
    checkout: vi.fn(async () => {}),
    stageAll: vi.fn(async () => {}),
    commit: vi.fn(async () => false),
    readRef: vi.fn(async (ref: string) =>
      ref === LAST_PUSHED_REF ? (opts.lastPushed ?? 'base-sha') : null,
    ),
    revParse: vi.fn(async (ref: string) => {
      if (ref === DOCMOST_BRANCH) return 'doc-sha';
      if (ref === 'main') return 'main-sha';
      return null;
    }),
    diffNameStatus: vi.fn(async () => opts.changes),
    showFileAtRef: vi.fn(async () => null),
    updateRef: vi.fn(async (ref: string, target: string) => {
      calls.updateRef.push({ ref, target });
    }),
    fastForwardBranch: vi.fn(async () => ({ ok: true })),
    listTrackedFiles: vi.fn(async () => [] as string[]),
  };
  return { git, calls };
}

describe('#13 conflict markers reach Docmost', () => {
  const conflictBody =
    '<<<<<<< HEAD\nmy line\n=======\ntheir line\n>>>>>>> feature\n';

  function makeConflictDeps(settings: Settings) {
    const file = serializePageFile('p-1', conflictBody);
    const { git, calls } = makePushGit({
      changes: [{ status: 'M', path: 'Doc.md' }],
    });

    const importPageMarkdown = vi.fn(async () => ({ success: true }));
    const client = {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      importPageMarkdown,
      createPage: vi.fn(),
      deletePage: vi.fn(),
      movePage: vi.fn(),
      renamePage: vi.fn(),
    };

    const deps: PushDeps = {
      settings,
      git,
      makeClient: () => client as any,
      readFile: vi.fn(async (path: string) => {
        if (path === 'Doc.md') return file;
        throw new Error(`no such file: ${path}`);
      }),
      writeFile: vi.fn(async () => {}),
      log: () => {},
    };
    return { deps, importPageMarkdown, calls };
  }

  it('DEFAULT (autoMergeConflicts off): does NOT push a conflicted page; records a failure and holds the refs', async () => {
    // makeSettings() leaves autoMergeConflicts undefined -> the SAFE default.
    const { deps, importPageMarkdown, calls } = makeConflictDeps(makeSettings());

    const res = await runPush(deps, { dryRun: false });
    expect(res.mode).toBe('apply');

    // The conflicted page is NOT pushed to Docmost at all.
    expect(importPageMarkdown).not.toHaveBeenCalled();

    // It is recorded as a per-page failure (so the user resolves the git conflict
    // first), and because there is a failure the last-pushed ref is NOT advanced.
    expect(res.applied?.failures).toEqual([
      expect.objectContaining({
        kind: 'update',
        pageId: 'p-1',
        path: 'Doc.md',
      }),
    ]);
    expect(res.applied?.failures[0].error).toMatch(/conflict markers/i);
    expect(res.applied?.lastPushedAdvanced).toBe(false);
    expect(calls.updateRef).toHaveLength(0);
  });

  it('autoMergeConflicts on: strips the markers and pushes a clean body', async () => {
    const { deps, importPageMarkdown } = makeConflictDeps({
      ...makeSettings(),
      autoMergeConflicts: true,
    });

    const res = await runPush(deps, { dryRun: false });
    expect(res.mode).toBe('apply');

    // The body actually sent to Docmost (2nd positional arg is the markdown body).
    expect(importPageMarkdown).toHaveBeenCalledTimes(1);
    const pushedBody: string = importPageMarkdown.mock.calls[0][1] as any;

    // The marker SYNTAX is stripped; both sides' content survives.
    expect(pushedBody).not.toContain('<<<<<<<');
    expect(pushedBody).not.toContain('=======');
    expect(pushedBody).not.toContain('>>>>>>>');
    expect(pushedBody).toContain('my line');
    expect(pushedBody).toContain('their line');
  });

  it('autoMergeConflicts on: rewrites the vault file with the CLEAN body so raw markers do not stay in the published vault (bug #2 marker-leak)', async () => {
    // Previously the UPDATE path stripped markers for the body SENT to Docmost but
    // left the file on `main` carrying raw `<<<<<<<`/`>>>>>>>` forever — the
    // published vault external clients clone kept the markers and the page
    // re-conflicted every cycle. The fix writes the cleaned body back + records it
    // in writtenBack so runPush commits it on `main`.
    const { deps, importPageMarkdown } = makeConflictDeps({
      ...makeSettings(),
      autoMergeConflicts: true,
    });

    const res = await runPush(deps, { dryRun: false });
    expect(res.mode).toBe('apply');

    // The clean body was imported into Docmost (no markers).
    const pushedBody: string = importPageMarkdown.mock.calls[0][1] as any;
    expect(pushedBody).not.toMatch(/[<>=]{7}/);

    // The vault file was rewritten with the cleaned content (no raw markers).
    const writeCalls = (deps.writeFile as any).mock.calls as [string, string][];
    const docWrite = writeCalls.find(([p]) => p === 'Doc.md');
    expect(docWrite).toBeDefined();
    expect(docWrite![1]).not.toMatch(/[<>=]{7}/);
    expect(docWrite![1]).toContain('my line');
    expect(docWrite![1]).toContain('their line');

    // It is recorded for the follow-up commit so `main` converges to clean bytes.
    expect(res.applied?.writtenBack).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Doc.md', pageId: 'p-1' }),
      ]),
    );
  });

  it('autoMergeConflicts on: strips diff3-style |||||||  base markers + base content (defense-in-depth)', async () => {
    // A vault created before `merge.conflictStyle=merge` was pinned (or content a
    // human committed in diff3 style) can carry a `||||||| base` section. The
    // scrub must drop the `|||||||` marker AND the stale base region, keeping only
    // the two live sides — otherwise `|||||||` + obsolete base lines leak into the
    // Docmost page.
    const diff3Body =
      '<<<<<<< HEAD\nmy line\n||||||| base\nold base line\n=======\ntheir line\n>>>>>>> feature\n';
    const file = serializePageFile('p-1', diff3Body);
    const { git } = makePushGit({ changes: [{ status: 'M', path: 'Doc.md' }] });
    const importPageMarkdown = vi.fn(async () => ({ success: true }));
    const client = {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      importPageMarkdown,
      createPage: vi.fn(),
      deletePage: vi.fn(),
      movePage: vi.fn(),
      renamePage: vi.fn(),
    };
    const deps: PushDeps = {
      settings: { ...makeSettings(), autoMergeConflicts: true },
      git,
      makeClient: () => client as any,
      readFile: vi.fn(async (p: string) => {
        if (p === 'Doc.md') return file;
        throw new Error(`no such file: ${p}`);
      }),
      writeFile: vi.fn(async () => {}),
      log: () => {},
    };

    await runPush(deps, { dryRun: false });
    const pushedBody: string = importPageMarkdown.mock.calls[0][1] as any;
    expect(pushedBody).not.toContain('|||||||');
    expect(pushedBody).not.toContain('old base line'); // stale base dropped
    expect(pushedBody).toContain('my line');
    expect(pushedBody).toContain('their line');
  });

  it('CREATE branch (autoMergeConflicts off): does NOT create a page from a conflicted NEW file; records a create failure', async () => {
    // The conflict-markers guard is DUPLICATED on the CREATE path (a brand-new
    // .md with NO gitmost_id, status 'A') and was previously untested — only the
    // UPDATE branch had coverage. Without this, a regression would SILENTLY push
    // `<<<<<<<`/`>>>>>>>` into a freshly-created page. Assert the create path
    // isolates it exactly like update: no createPage, a kind:'create' failure
    // with the conflict reason, and the refs held.
    const { git, calls } = makePushGit({
      changes: [{ status: 'A', path: 'New.md' }],
    });
    const createPage = vi.fn(async () => ({ data: { id: 'new-1' } }));
    const client = {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      importPageMarkdown: vi.fn(),
      createPage,
      deletePage: vi.fn(),
      movePage: vi.fn(),
      renamePage: vi.fn(),
    };
    const deps: PushDeps = {
      // makeSettings() leaves autoMergeConflicts undefined -> the SAFE default.
      settings: makeSettings(),
      git,
      makeClient: () => client as any,
      // Raw conflict body with NO gitmost_id frontmatter -> classified as CREATE.
      readFile: vi.fn(async (path: string) => {
        if (path === 'New.md') return conflictBody;
        throw new Error(`no such file: ${path}`);
      }),
      writeFile: vi.fn(async () => {}),
      log: () => {},
    };

    const res = await runPush(deps, { dryRun: false });
    expect(res.mode).toBe('apply');

    // No page was created from the conflicted content.
    expect(createPage).not.toHaveBeenCalled();

    // Recorded as a CREATE failure with the conflict-markers reason.
    expect(res.applied?.failures).toEqual([
      expect.objectContaining({
        kind: 'create',
        path: 'New.md',
        error: CONFLICT_MARKERS_FAILURE_REASON,
      }),
    ]);

    // A failure prevents advancing the last-pushed ref.
    expect(res.applied?.lastPushedAdvanced).toBe(false);
    expect(calls.updateRef).toHaveLength(0);
  });

  it('CREATE branch (autoMergeConflicts on): strips the markers and createPage gets a CLEAN body; the vault file is rewritten clean', async () => {
    // The CREATE path strips conflict markers (stripConflictMarkers(rawBody)) and
    // passes the CLEANED body to createPage — but only the OFF-case (no createPage)
    // and the UPDATE-ON case were covered. A regression passing the RAW body to
    // createPage would publish `<<<<<<<`/`=======`/`>>>>>>>` into a brand-new page
    // with NO test catching it. Pin: createPage IS called with a marker-free body
    // that preserves BOTH sides, and the file on disk is rewritten with that body.
    const { git } = makePushGit({
      changes: [{ status: 'A', path: 'New.md' }],
    });
    const createPage = vi.fn(async () => ({ data: { id: 'new-1' } }));
    const client = {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      importPageMarkdown: vi.fn(),
      createPage,
      deletePage: vi.fn(),
      movePage: vi.fn(),
      renamePage: vi.fn(),
    };
    const deps: PushDeps = {
      settings: { ...makeSettings(), autoMergeConflicts: true },
      git,
      makeClient: () => client as any,
      // Raw conflict body with NO gitmost_id frontmatter -> classified as CREATE.
      readFile: vi.fn(async (path: string) => {
        if (path === 'New.md') return conflictBody;
        throw new Error(`no such file: ${path}`);
      }),
      writeFile: vi.fn(async () => {}),
      log: () => {},
    };

    const res = await runPush(deps, { dryRun: false });
    expect(res.mode).toBe('apply');

    // The page WAS created. The body (2nd positional arg) is marker-free but keeps
    // both sides' content.
    expect(createPage).toHaveBeenCalledTimes(1);
    const createdBody: string = createPage.mock.calls[0][1] as any;
    expect(createdBody).not.toContain('<<<<<<<');
    expect(createdBody).not.toContain('=======');
    expect(createdBody).not.toContain('>>>>>>>');
    expect(createdBody).toContain('my line');
    expect(createdBody).toContain('their line');

    // The file on disk is rewritten with the CLEAN body (no raw markers) so the
    // published vault never carries the conflict syntax.
    const writeCalls = (deps.writeFile as any).mock.calls as [string, string][];
    const newWrite = writeCalls.find(([p]) => p === 'New.md');
    expect(newWrite).toBeDefined();
    expect(newWrite![1]).not.toMatch(/[<>=]{7}/);
    expect(newWrite![1]).toContain('my line');
    expect(newWrite![1]).toContain('their line');
  });
});

// ---------------------------------------------------------------------------
// #15 — a divergent `docmost` mirror (fastForwardBranch refuses) is escalated by
// runPush (`divergentDocmost: true`), but runCycle forwards only {mode, failures}
// — the divergence is DROPPED from RunCycleResult. DESIRED: the cycle result
// surfaces the divergence so the caller can act on it.
// ---------------------------------------------------------------------------
function fakeVault(overrides: Record<string, any> = {}) {
  const order: string[] = [];
  const rec =
    (name: string, ret?: any) =>
    async (...args: any[]) => {
      order.push(args.length ? `${name}:${args.join(',')}` : name);
      return ret;
    };
  const vault: any = {
    order,
    assertGitAvailable: rec('assertGitAvailable'),
    ensureRepo: rec('ensureRepo'),
    clearStaleGitLocks: rec('clearStaleGitLocks'),
    ensureMainBranch: rec('ensureMainBranch'),
    isMergeInProgress: vi.fn(async () => false),
    ensureBranch: rec('ensureBranch'),
    checkout: rec('checkout'),
    listTrackedFiles: vi.fn(async () => [] as string[]),
    stageAll: rec('stageAll'),
    commit: rec('commit', false),
    merge: rec('merge', { ok: true, conflict: false, output: '' }),
    readRef: vi.fn(async () => null),
    revParse: vi.fn(async () => 'main-commit-sha'),
    diffNameStatus: vi.fn(async () => [] as any[]),
    showFileAtRef: vi.fn(async () => ''),
    updateRef: rec('updateRef'),
    // The mirror diverged: the ff is REFUSED. runPush escalates this as
    // divergentDocmost; the question is whether runCycle surfaces it.
    fastForwardBranch: rec('fastForwardBranch', {
      ok: false,
      reason: 'not-fast-forward',
    }),
    ...overrides,
  };
  return vault;
}

function baseDeps(vault: any, over: Partial<RunCycleDeps> = {}): RunCycleDeps {
  return {
    spaceId: 'space-1',
    client: {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      getPageJson: vi.fn(),
      importPageMarkdown: vi.fn(),
      createPage: vi.fn(),
      deletePage: vi.fn(),
      movePage: vi.fn(),
      renamePage: vi.fn(),
      listRecentSince: vi.fn(),
      listTrash: vi.fn(),
      restorePage: vi.fn(),
    } as any,
    vault,
    settings: { vaultPath: '/vault' } as any,
    fs: {
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    },
    log: vi.fn(),
    ...over,
  };
}

describe('#15 divergence dropped by runCycle', () => {
  it('surfaces the divergent `docmost` mirror in RunCycleResult', async () => {
    const vault = fakeVault();
    const deps = baseDeps(vault);

    const res = await runCycle(deps);
    expect(res.ran).toBe(true);

    // The push DID refuse to fast-forward the divergent mirror.
    expect(vault.order).toContain(
      'fastForwardBranch:docmost,main-commit-sha',
    );

    // DESIRED: the cycle result surfaces the divergence (some warning/flag), so a
    // caller driving runCycle can see the §5 invariant breach without scraping
    // logs. Today RunCycleResult.push is only {mode, failures}.
    const divergence =
      (res as any).divergentDocmost ??
      (res.push as any)?.divergentDocmost ??
      (res as any).warning;
    expect(divergence).toBeTruthy();
  });
});
