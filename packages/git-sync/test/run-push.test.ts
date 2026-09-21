import { describe, expect, it, vi } from 'vitest';
import { runPush, LAST_PUSHED_REF, DOCMOST_BRANCH } from '../src/engine/push';
import type { PushDeps } from '../src/engine/push';
import type { Settings } from '../src/engine/settings';
import { serializePageFile } from '@docmost/prosemirror-markdown';

/** A native page file: `gitmost_id` frontmatter + clean body (title = filename). */
function fileFor(pageId: string, body = 'body'): string {
  return serializePageFile(pageId, body);
}

// runPush orchestration (SPEC §6 "ФС → Docmost"), DRY-RUN BY DEFAULT. Driven by
// FAKES only — no live Docmost, git, fs, or network. Asserts the SAFE-BY-DEFAULT
// contract: a dry-run builds NO client, makes ZERO Docmost calls, advances NO
// refs; `--apply` is the ONLY path that writes. Also covers the merge-in-progress
// abort, the divergent-`docmost` escalation, and the base selection fallback.

/** A minimal valid Settings fixture (only fields runPush reads matter). */
function makeSettings(): Settings {
  return {
    docmostSpaceId: 'space-1',
    vaultPath: '/vault',
    pollIntervalMs: 15000,
    debounceMs: 2000,
    logLevel: 'info',
  };
}

/**
 * A recording git fake covering exactly the `PushDeps['git']` surface. Options
 * configure the diff rows, which refs resolve, and what the ff returns.
 */
function makeGit(opts?: {
  mergeInProgress?: boolean;
  lastPushed?: string | null;
  docmostSha?: string | null;
  mainSha?: string;
  /** Diff rows returned by diffNameStatus(base, main). */
  changes?: { status: 'A' | 'M' | 'D' | 'R' | 'C'; path: string; oldPath?: string }[];
  /** Pre-image tree at the base ref (path -> text) for showFileAtRef. */
  prevTree?: Record<string, string>;
  ffResult?: { ok: boolean; reason?: string };
  /** When set, commit returns this per call (queue); defaults to always-true. */
  commitResults?: boolean[];
}) {
  const calls = {
    assertGitAvailable: 0,
    ensureRepo: 0,
    checkout: [] as string[],
    stageAll: 0,
    commit: [] as string[],
    updateRef: [] as { ref: string; target: string }[],
    fastForwardBranch: [] as { branch: string; toCommit: string }[],
    diffNameStatus: [] as { from: string; to: string }[],
  };
  const prevTree = opts?.prevTree ?? {};
  const commitQueue = [...(opts?.commitResults ?? [])];
  let mainSha = opts?.mainSha ?? 'main-sha-1';

  const git: PushDeps['git'] = {
    assertGitAvailable: vi.fn(async () => {
      calls.assertGitAvailable++;
    }),
    ensureRepo: vi.fn(async () => {
      calls.ensureRepo++;
    }),
    isMergeInProgress: vi.fn(async () => opts?.mergeInProgress ?? false),
    checkout: vi.fn(async (name: string) => {
      calls.checkout.push(name);
    }),
    stageAll: vi.fn(async () => {
      calls.stageAll++;
    }),
    commit: vi.fn(async (subject: string) => {
      calls.commit.push(subject);
      return commitQueue.length > 0 ? (commitQueue.shift() as boolean) : true;
    }),
    readRef: vi.fn(async (ref: string) =>
      ref === LAST_PUSHED_REF ? (opts?.lastPushed ?? null) : null,
    ),
    revParse: vi.fn(async (ref: string) => {
      if (ref === DOCMOST_BRANCH) return opts?.docmostSha ?? null;
      if (ref === 'main') return mainSha;
      return null;
    }),
    diffNameStatus: vi.fn(async (from: string, to: string) => {
      calls.diffNameStatus.push({ from, to });
      return opts?.changes ?? [];
    }),
    showFileAtRef: vi.fn(async (_ref: string, path: string) =>
      path in prevTree ? prevTree[path] : null,
    ),
    updateRef: vi.fn(async (ref: string, target: string) => {
      calls.updateRef.push({ ref, target });
    }),
    fastForwardBranch: vi.fn(async (branch: string, toCommit: string) => {
      calls.fastForwardBranch.push({ branch, toCommit });
      return opts?.ffResult ?? { ok: true };
    }),
  };
  return {
    git,
    calls,
    /** Advance the fake `main` HEAD (so a write-back commit yields a new sha). */
    setMainSha: (sha: string) => {
      mainSha = sha;
    },
  };
}

/** A recording client fake; createPage returns a configurable assigned id. */
function makeClientFake(opts?: { createId?: string }) {
  return {
    // Empty live tree by default -> no retry-adopt match, so creates take the
    // normal createPage path (the adopt lookup only fires on a (parent,title) hit).
    listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
    importPageMarkdown: vi.fn(async () => ({ success: true })),
    createPage: vi.fn(async (title: string) => ({
      data: { id: opts?.createId ?? 'assigned-id', title },
      success: true,
    })),
    deletePage: vi.fn(async () => ({ success: true })),
    movePage: vi.fn(async () => ({ success: true })),
    renamePage: vi.fn(async () => ({ success: true })),
  };
}

/** A recording fs fake over a path->text store. */
function makeFs(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  const reads: string[] = [];
  const writes: { path: string; text: string }[] = [];
  return {
    store,
    reads,
    writes,
    readFile: vi.fn(async (path: string) => {
      reads.push(path);
      if (!(path in store)) throw new Error(`no such file: ${path}`);
      return store[path];
    }),
    writeFile: vi.fn(async (path: string, text: string) => {
      store[path] = text;
      writes.push({ path, text });
    }),
  };
}

/** Assemble PushDeps with a recording logger and a makeClient FACTORY spy. */
function makeDeps(
  git: PushDeps['git'],
  fs: ReturnType<typeof makeFs>,
  client?: ReturnType<typeof makeClientFake>,
) {
  const logs: string[] = [];
  const makeClient = vi.fn(() => (client ?? makeClientFake()) as any);
  const deps: PushDeps = {
    settings: makeSettings(),
    git,
    makeClient,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    log: (line) => logs.push(line),
  };
  return { deps, logs, makeClient };
}

describe('runPush — dry-run is the DEFAULT (safe)', () => {
  it('logs a plan, builds NO client, makes ZERO Docmost calls, advances NO refs', async () => {
    const file = fileFor('p-1', 'edited body');
    const { git, calls } = makeGit({
      lastPushed: 'base-sha',
      changes: [{ status: 'M', path: 'Doc.md' }],
    });
    const fs = makeFs({ 'Doc.md': file });
    const { deps, logs, makeClient } = makeDeps(git, fs);

    const res = await runPush(deps, { dryRun: true });

    expect(res.mode).toBe('dry-run');
    expect(res.planned).toEqual({
      creates: 0,
      updates: 1,
      deletes: 0,
      renamesMoves: 0,
      skipped: 0,
    });
    // The client FACTORY was never invoked -> zero Docmost contact.
    expect(makeClient).not.toHaveBeenCalled();
    // No ref advance, no mirror ff.
    expect(calls.updateRef).toEqual([]);
    expect(calls.fastForwardBranch).toEqual([]);
    // A plan WAS logged (counts + the per-item update line).
    expect(logs.join('\n')).toMatch(/DRY-RUN/);
    expect(logs.join('\n')).toMatch(/update: p-1 \(Doc\.md\)/);
    // It still diffs the base against main and works on main.
    expect(calls.diffNameStatus).toEqual([{ from: LAST_PUSHED_REF, to: 'main' }]);
    expect(calls.checkout).toEqual(['main']);
  });

  it('commits the working tree with the local provenance trailer before diffing', async () => {
    const { git, calls } = makeGit({ lastPushed: 'base-sha' });
    const fs = makeFs();
    const { deps } = makeDeps(git, fs);

    await runPush(deps, { dryRun: true });

    // The first commit is the human working-tree commit on main (SPEC §7.3).
    expect(calls.commit[0]).toBe('local: working-tree changes');
    expect(calls.stageAll).toBeGreaterThanOrEqual(1);
    const trailerArg = (git.commit as any).mock.calls[0][1];
    expect(trailerArg.trailers).toEqual(['Docmost-Sync-Source: local']);
  });
});

describe('runPush — --apply is the ONLY write path', () => {
  it('builds the client, calls applyPushActions, records created pageIds, advances last-pushed', async () => {
    // A brand-new local file: meta has title + spaceId but NO pageId yet.
    // A brand-new hand-written file with NO frontmatter (title = filename `New`).
    const newFile = 'fresh body\n';
    const { git, calls, setMainSha } = makeGit({
      lastPushed: 'base-sha',
      mainSha: 'main-1',
      changes: [{ status: 'A', path: 'New.md' }],
    });
    const fs = makeFs({ 'New.md': newFile });
    const client = makeClientFake({ createId: 'page-new' });
    const { deps, makeClient } = makeDeps(git, fs, client);
    // After the write-back commit, `main` moves to a new commit.
    (git.commit as any).mockImplementation(async (subject: string) => {
      calls.commit.push(subject);
      if (subject === 'local: record created pageIds') setMainSha('main-2');
      return true;
    });

    const res = await runPush(deps, { dryRun: false });

    expect(res.mode).toBe('apply');
    // The client factory WAS used and createPage ran (the write path).
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(res.applied?.created).toBe(1);
    // The assigned pageId was written back into the file on disk.
    expect(res.applied?.writtenBack).toEqual([{ path: 'New.md', pageId: 'page-new' }]);
    expect(fs.store['New.md']).toMatch(/page-new/);
    // A "record created pageIds" commit persisted the write-back.
    expect(calls.commit).toContain('local: record created pageIds');
    // last-pushed was advanced — first by the applier (main-1), then re-advanced
    // to the write-back commit (main-2).
    const lastPushedAdvances = calls.updateRef.filter(
      (u) => u.ref === LAST_PUSHED_REF,
    );
    expect(lastPushedAdvances.map((u) => u.target)).toEqual(['main-1', 'main-2']);
    expect(res.divergentDocmost).toBe(false);
    expect(res.failures).toEqual([]);
  });

  it('ESCALATES a divergent docmost mirror in the write-back branch too (SPEC §5, symmetric)', async () => {
    // A create -> the pageId is written back and a "record created pageIds"
    // commit is made, which triggers the write-back-branch ff. Here the applier's
    // MAIN push ff succeeds (ok) but the WRITE-BACK ff diverges — the write-back
    // branch must escalate identically to the main branch (set divergentDocmost,
    // log the same prominent WARNING), so main() exits 1.
    // A brand-new hand-written file with NO frontmatter (title = filename `New`).
    const newFile = 'fresh body\n';
    const { git, calls, setMainSha } = makeGit({
      lastPushed: 'base-sha',
      mainSha: 'main-1',
      changes: [{ status: 'A', path: 'New.md' }],
    });
    const fs = makeFs({ 'New.md': newFile });
    const client = makeClientFake({ createId: 'page-new' });
    const { deps, logs } = makeDeps(git, fs, client);
    (git.commit as any).mockImplementation(async (subject: string) => {
      calls.commit.push(subject);
      if (subject === 'local: record created pageIds') setMainSha('main-2');
      return true;
    });
    // First ff (applier 7b, main push) is OK; second ff (write-back) DIVERGES.
    let ffCall = 0;
    (git.fastForwardBranch as any).mockImplementation(
      async (branch: string, toCommit: string) => {
        calls.fastForwardBranch.push({ branch, toCommit });
        ffCall++;
        return ffCall === 1
          ? { ok: true }
          : { ok: false, reason: 'not-fast-forward' };
      },
    );

    const res = await runPush(deps, { dryRun: false });

    // The apply still happened, but the write-back divergence is escalated.
    expect(res.applied?.created).toBe(1);
    expect(res.divergentDocmost).toBe(true);
    // The SAME prominent WARNING (DIVERGED + §5) — not a soft warning.
    expect(logs.join('\n')).toMatch(/WARNING/);
    expect(logs.join('\n')).toMatch(/DIVERGED/);
    expect(logs.join('\n')).toMatch(/write-back/);
  });

  it('an update goes through importPageMarkdown (collab path)', async () => {
    const file = fileFor('p-9', 'body');
    const { git } = makeGit({
      lastPushed: 'base-sha',
      changes: [{ status: 'M', path: 'Doc.md' }],
    });
    const fs = makeFs({ 'Doc.md': file });
    const client = makeClientFake();
    const { deps } = makeDeps(git, fs, client);

    const res = await runPush(deps, { dryRun: false });

    // The pushed content is the STRIPPED body (no gitmost_id frontmatter).
    expect(client.importPageMarkdown).toHaveBeenCalledWith('p-9', 'body', null);
    expect(res.applied?.updated).toBe(1);
  });
});

describe('runPush — merge-in-progress aborts (SPEC §9/§12)', () => {
  it('stops with a clear message, no diff, no client, no apply', async () => {
    const { git, calls } = makeGit({ mergeInProgress: true });
    const fs = makeFs();
    const { deps, logs, makeClient } = makeDeps(git, fs);

    const res = await runPush(deps, { dryRun: false });

    expect(res.aborted).toBe('merge-in-progress');
    // Never diffed, never built a client, never checked out / committed.
    expect(calls.diffNameStatus).toEqual([]);
    expect(makeClient).not.toHaveBeenCalled();
    expect(calls.checkout).toEqual([]);
    expect(logs.join('\n')).toMatch(/unresolved merge/);
    expect(logs.join('\n')).toMatch(/SPEC §9/);
  });
});

describe('runPush — divergent docmost escalation (SPEC §5)', () => {
  it('sets the escalation flag and logs a WARNING, but the apply still happened', async () => {
    const file = fileFor('p-1', 'body');
    const { git } = makeGit({
      lastPushed: 'base-sha',
      changes: [{ status: 'M', path: 'Doc.md' }],
      // The applier refuses to clobber a divergent mirror.
      ffResult: { ok: false, reason: 'not-fast-forward' },
    });
    const fs = makeFs({ 'Doc.md': file });
    const client = makeClientFake();
    const { deps, logs } = makeDeps(git, fs, client);

    const res = await runPush(deps, { dryRun: false });

    // The apply STILL happened (the page was updated)...
    expect(res.applied?.updated).toBe(1);
    expect(client.importPageMarkdown).toHaveBeenCalledTimes(1);
    // ...but the divergence is escalated, not silent.
    expect(res.divergentDocmost).toBe(true);
    expect(logs.join('\n')).toMatch(/WARNING/);
    expect(logs.join('\n')).toMatch(/DIVERGED/);
  });
});

describe('runPush — base selection (last-pushed else docmost)', () => {
  it('uses refs/docmost/last-pushed when it resolves', async () => {
    const { git, calls } = makeGit({ lastPushed: 'lp-sha' });
    const fs = makeFs();
    const { deps } = makeDeps(git, fs);

    const res = await runPush(deps, { dryRun: true });

    expect(res.base).toEqual({
      ref: LAST_PUSHED_REF,
      source: 'last-pushed',
      sha: 'lp-sha',
    });
    expect(calls.diffNameStatus[0].from).toBe(LAST_PUSHED_REF);
  });

  it('falls back to the docmost branch when last-pushed is missing', async () => {
    const { git, calls } = makeGit({
      lastPushed: null, // last-pushed does not resolve -> fall back.
      docmostSha: 'doc-sha',
    });
    const fs = makeFs();
    const { deps } = makeDeps(git, fs);

    const res = await runPush(deps, { dryRun: true });

    expect(res.base).toEqual({
      ref: DOCMOST_BRANCH,
      source: 'docmost',
      sha: 'doc-sha',
    });
    // The diff is taken against the docmost mirror branch.
    expect(calls.diffNameStatus[0].from).toBe(DOCMOST_BRANCH);
  });
});

// Coverage for two narrow, otherwise-untested branches in `applyPushActions`
// (driven end-to-end via `runPush --apply`, the only write path):
//   1. `errMessage` (push.ts line 762-763) NON-Error branch — `String(err)`.
//   2. `createPage` partial-meta fallbacks (push.ts line 583-584) — `?? ''`.
describe('runPush --apply — applyPushActions edge branches', () => {
  it('records a thrown NON-Error (a string) via String(err), not "undefined"', async () => {
    // One UPDATE (file carries a pageId), whose collab write throws the raw
    // STRING 'boom'. Every other failure test throws an Error, so the
    // `String(err)` fallback in errMessage (push.ts:763) is otherwise uncovered.
    const file = fileFor('p-7', 'body');
    const { git, calls } = makeGit({
      lastPushed: 'base-sha',
      changes: [{ status: 'M', path: 'Doc.md' }],
    });
    const fs = makeFs({ 'Doc.md': file });
    const client = makeClientFake();
    // Throw a bare string (NON-Error) from the update path.
    (client.importPageMarkdown as any).mockImplementation(async () => {
      throw 'boom';
    });
    const { deps } = makeDeps(git, fs, client);

    // runPush must COMPLETE (the failure is isolated), not reject.
    const res = await runPush(deps, { dryRun: false });

    expect(res.mode).toBe('apply');
    expect(res.applied?.updated).toBe(0);
    expect(res.failures).toHaveLength(1);
    const failure = res.failures![0];
    expect(failure.kind).toBe('update');
    expect(failure.pageId).toBe('p-7');
    expect(failure.path).toBe('Doc.md');
    // String(err) of the thrown string 'boom' — NOT 'undefined' and NOT
    // '[object Object]'. This is the load-bearing assertion for line 763.
    expect(failure.error).toBe('boom');
    // A failure means the refs are NOT advanced (partial push, SPEC §12).
    expect(calls.updateRef).toEqual([]);
    expect(calls.fastForwardBranch).toEqual([]);
  });

  it('records a thrown NON-Error OBJECT via String(err) too (no implicit message)', async () => {
    // A thrown object literal -> String({}) === '[object Object]'. Pins down that
    // errMessage stringifies (not reads a .message) for non-Error throwables.
    const file = fileFor('p-8', 'body');
    const { git } = makeGit({
      lastPushed: 'base-sha',
      changes: [{ status: 'M', path: 'Doc.md' }],
    });
    const fs = makeFs({ 'Doc.md': file });
    const client = makeClientFake();
    (client.importPageMarkdown as any).mockImplementation(async () => {
      throw { code: 500 };
    });
    const { deps } = makeDeps(git, fs, client);

    const res = await runPush(deps, { dryRun: false });

    expect(res.failures).toHaveLength(1);
    // String({ code: 500 }) — the object's default stringification.
    expect(res.failures![0].error).toBe('[object Object]');
  });

  it('createPage derives title from the FILENAME, space from the run, parent from path', async () => {
    // A brand-new hand-written file at the space ROOT (no enclosing folder). In
    // the native-Obsidian format nothing is stored in the file: title comes from
    // the FILENAME (`New`), spaceId from the RUN (the vault's space `space-1`),
    // and parentPageId from the PATH (root -> undefined).
    const newFile = 'fresh body\n';
    const { git } = makeGit({
      lastPushed: 'base-sha',
      mainSha: 'main-1',
      changes: [{ status: 'A', path: 'New.md' }],
    });
    const fs = makeFs({ 'New.md': newFile });
    const client = makeClientFake({ createId: 'page-new' });
    const { deps } = makeDeps(git, fs, client);

    const res = await runPush(deps, { dryRun: false });

    expect(res.mode).toBe('apply');
    expect(res.applied?.created).toBe(1);
    expect(client.createPage).toHaveBeenCalledTimes(1);
    const [title, content, spaceId, parentPageId] = (client.createPage as any).mock
      .calls[0];
    expect(title).toBe('New'); // from the filename
    expect(content).toBe('fresh body'); // the stripped body
    expect(spaceId).toBe('space-1'); // from the run (makeSettings)
    expect(parentPageId).toBe(undefined); // root path -> no parent
  });

  it('an added file with NO frontmatter is CREATED (space from the run), never skipped', async () => {
    // Native: every file in the vault belongs to the vault's space, supplied by
    // the RUN — so a brand-new hand-written file (no gitmost_id) is always a
    // CREATE, never skipped for a "missing spaceId" (that legacy skip is gone).
    const file = 'just some text\n';
    const { git } = makeGit({
      lastPushed: 'base-sha',
      changes: [{ status: 'A', path: 'Orphan.md' }],
    });
    const fs = makeFs({ 'Orphan.md': file });
    const client = makeClientFake({ createId: 'orphan-id' });
    const { deps } = makeDeps(git, fs, client);

    const res = await runPush(deps, { dryRun: false });

    expect(res.planned).toEqual({
      creates: 1,
      updates: 0,
      deletes: 0,
      renamesMoves: 0,
      skipped: 0,
    });
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect((client.createPage as any).mock.calls[0][0]).toBe('Orphan'); // title=filename
    expect(res.applied?.created).toBe(1);
  });
});
