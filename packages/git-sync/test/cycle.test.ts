import { describe, it, expect, vi } from "vitest";
import { runCycle, type RunCycleDeps } from "../src/engine/cycle";
import { serializePageFile } from "@docmost/prosemirror-markdown";

// A fake VaultGit recording the staging calls. An EMPTY vault/tree lets the real
// readExisting/computePullActions/applyPullActions/runPush run trivially (no
// files, no pages) so we can assert runCycle's choreography without real git.
function fakeVault(overrides: Record<string, any> = {}) {
  const order: string[] = [];
  const rec =
    (name: string, ret?: any) =>
    async (...args: any[]) => {
      order.push(args.length ? `${name}:${args.join(",")}` : name);
      return ret;
    };
  const vault: any = {
    order,
    assertGitAvailable: rec("assertGitAvailable"),
    ensureRepo: rec("ensureRepo"),
    clearStaleGitLocks: rec("clearStaleGitLocks"),
    ensureMainBranch: rec("ensureMainBranch"),
    isMergeInProgress: vi.fn(async () => false),
    ensureBranch: rec("ensureBranch"),
    checkout: rec("checkout"),
    listTrackedFiles: vi.fn(async () => [] as string[]),
    // push-side git surface (empty diff -> a clean no-op push)
    stageAll: rec("stageAll"),
    commit: rec("commit", { committed: false }),
    merge: rec("merge", { ok: true, conflict: false, output: "" }),
    listUnmergedPaths: vi.fn(async () => [] as string[]),
    commitMerge: rec("commitMerge"),
    abortMerge: rec("abortMerge"),
    resetHardToHead: rec("resetHardToHead"),
    readRef: vi.fn(async () => null),
    revParse: vi.fn(async () => "0000000000000000000000000000000000000000"),
    diffNameStatus: vi.fn(async () => [] as any[]),
    showFileAtRef: vi.fn(async () => ""),
    updateRef: rec("updateRef"),
    fastForwardBranch: rec("fastForwardBranch", { ok: true }),
    ...overrides,
  };
  return vault;
}

function baseDeps(vault: any, over: Partial<RunCycleDeps> = {}): RunCycleDeps {
  return {
    spaceId: "space-1",
    client: {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      // Default: every candidate id is a real page row (historical behavior).
      pageIdsExist: vi.fn(async (ids: string[]) => ids),
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
    settings: { vaultPath: "/vault" } as any,
    fs: {
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
      // Default: nothing is a symlink and everything resolves in place (no
      // escape). The symlink-guard tests below override these.
      lstat: vi.fn(async () => ({ isSymbolicLink: false })),
      realpath: vi.fn(async (p: string) => p),
    },
    log: vi.fn(),
    ...over,
  };
}

describe("runCycle (composition)", () => {
  it("RECOVERS from a vault left mid-merge: aborts the stale merge and continues (no wedge)", async () => {
    // Regression for the WEDGE bug (QA #119): a vault left mid-merge by a prior
    // cycle used to skip the WHOLE space forever. Now the cycle aborts the stale
    // merge and proceeds so the space self-heals.
    let midMerge = true;
    const vault = fakeVault({
      // mid-merge until `abortMerge` clears it (then the cycle continues).
      isMergeInProgress: vi.fn(async () => midMerge),
      abortMerge: vi.fn(async () => {
        midMerge = false;
      }),
    });
    const deps = baseDeps(vault);

    const res = await runCycle(deps);

    // The stale merge was aborted and the cycle RAN (no permanent wedge).
    expect(vault.abortMerge).toHaveBeenCalledTimes(1);
    expect(res.ran).toBe(true);
    expect(deps.client.listSpaceTree).toHaveBeenCalledTimes(1);
    expect(vault.order).toContain("checkout:docmost");
  });

  it("hard-resets when 'merge --abort' cannot clear a stray unmerged index", async () => {
    // abortMerge does NOT clear it (no MERGE_HEAD but stray unmerged entries);
    // the cycle falls back to a hard reset, then proceeds.
    let midMerge = true;
    const vault = fakeVault({
      isMergeInProgress: vi.fn(async () => midMerge),
      abortMerge: vi.fn(async () => undefined), // leaves it mid-merge
      resetHardToHead: vi.fn(async () => {
        midMerge = false;
      }),
    });
    const deps = baseDeps(vault);

    const res = await runCycle(deps);

    expect(vault.abortMerge).toHaveBeenCalledTimes(1);
    expect(vault.resetHardToHead).toHaveBeenCalledTimes(1);
    expect(res.ran).toBe(true);
  });

  it("stages ensureRepo -> ensureBranch(docmost,main) -> checkout(docmost) BEFORE pulling", async () => {
    const vault = fakeVault();
    const deps = baseDeps(vault);

    const res = await runCycle(deps);

    expect(res.ran).toBe(true);
    const ensureRepoIdx = vault.order.indexOf("ensureRepo");
    const ensureBranchIdx = vault.order.indexOf("ensureBranch:docmost,main");
    const checkoutIdx = vault.order.indexOf("checkout:docmost");
    expect(ensureRepoIdx).toBeGreaterThanOrEqual(0);
    expect(ensureBranchIdx).toBeGreaterThan(ensureRepoIdx);
    expect(checkoutIdx).toBeGreaterThan(ensureBranchIdx);
    expect(deps.client.listSpaceTree).toHaveBeenCalledTimes(1);
  });

  it("runs the self-heal preflight in a SAFE order: ensureRepo -> clearStaleGitLocks -> ensureMainBranch -> ensureBranch (bugs D3-N3/D3-N1)", async () => {
    // The order is load-bearing for safety: clearStaleGitLocks MUST run AFTER
    // ensureRepo (else it would delete ensureRepo's own transient lock) and
    // BEFORE the checkout/diff; ensureMainBranch MUST run before the
    // ensureBranch("docmost","main") + checkout that would otherwise throw on a
    // missing `main`.
    const vault = fakeVault();
    const deps = baseDeps(vault);

    const res = await runCycle(deps);
    expect(res.ran).toBe(true);

    const ensureRepoIdx = vault.order.indexOf("ensureRepo");
    const clearStaleGitLocksIdx = vault.order.indexOf("clearStaleGitLocks");
    const ensureMainBranchIdx = vault.order.indexOf("ensureMainBranch");
    const ensureBranchIdx = vault.order.indexOf("ensureBranch:docmost,main");

    expect(ensureRepoIdx).toBeGreaterThanOrEqual(0);
    expect(clearStaleGitLocksIdx).toBeGreaterThanOrEqual(0);
    expect(ensureMainBranchIdx).toBeGreaterThanOrEqual(0);
    expect(ensureBranchIdx).toBeGreaterThanOrEqual(0);

    expect(ensureRepoIdx).toBeLessThan(clearStaleGitLocksIdx);
    expect(clearStaleGitLocksIdx).toBeLessThan(ensureMainBranchIdx);
    expect(ensureMainBranchIdx).toBeLessThan(ensureBranchIdx);
  });

  it("runs a SINGLE push planning pass (no dry-run; the delete-cap hook is gone)", async () => {
    const vault = fakeVault();
    const deps = baseDeps(vault);

    const res = await runCycle(deps);
    expect(res.ran).toBe(true);
    // There is exactly one runPush (the apply) — no separate dry-run pass.
    // diffNameStatus is read once per runPush; assert a single planning pass.
    expect(vault.diffNameStatus).toHaveBeenCalledTimes(1);
  });

  it("throws on a PRE-aborted signal BEFORE applying the pull (first destructive phase)", async () => {
    const vault = fakeVault();
    const controller = new AbortController();
    controller.abort();
    const deps = baseDeps(vault, { signal: controller.signal });

    await expect(runCycle(deps)).rejects.toThrow();

    // The signal is checked AFTER planning but BEFORE the first write phase:
    // the tree was listed (planning) but neither destructive phase advanced —
    // no pull merge and no push diff.
    expect(deps.client.listSpaceTree).toHaveBeenCalledTimes(1);
    expect(vault.order).not.toContain("merge:main");
    expect(vault.diffNameStatus).not.toHaveBeenCalled();
  });

  it("SYMLINK GUARD: never reads a tracked .md that is a symlink (no .env/passwd disclosure)", async () => {
    // Security regression (PR #119 review): a writer who pushes `leak.md` as a
    // SYMLINK to a server file (e.g. `.env`) must NOT have its target read and
    // published. readExisting reads each tracked .md to recover its gitmost_id;
    // the guard refuses the symlink BEFORE the raw read, so the target's bytes
    // are never touched and the cycle keeps running for the rest of the space.
    const vault = fakeVault({
      listTrackedFiles: vi.fn(async () => ["leak.md"]),
    });
    const deps = baseDeps(vault);
    const rawReadFile = vi.fn(async () => "GIT_SYNC_SECRET=topsecret");
    deps.fs.readFile = rawReadFile as any;
    // `/vault/leak.md` is reported as a symlink by lstat.
    deps.fs.lstat = vi.fn(async (p: string) =>
      p === "/vault/leak.md"
        ? { isSymbolicLink: true }
        : { isSymbolicLink: false },
    ) as any;

    const res = await runCycle(deps);

    expect(res.ran).toBe(true);
    // The poisoned symlink's target was NEVER read (the guard short-circuited).
    expect(rawReadFile).not.toHaveBeenCalled();
  });

  it("throws BEFORE the push apply when the signal aborts during the pull phase", async () => {
    // Abort mid-cycle: the signal fires while listSpaceTree (the pull read)
    // runs, so the SECOND checkpoint (before runPush) trips and the push apply
    // never starts.
    const controller = new AbortController();
    const vault = fakeVault();
    const deps = baseDeps(vault, {
      signal: controller.signal,
      client: {
        ...baseDeps(vault).client,
        listSpaceTree: vi.fn(async () => {
          controller.abort();
          return { pages: [], complete: true };
        }),
      } as any,
    });

    await expect(runCycle(deps)).rejects.toThrow();
    // Pull planning ran but the push never did (aborted at a checkpoint).
    expect(deps.client.listSpaceTree).toHaveBeenCalledTimes(1);
    expect(vault.diffNameStatus).not.toHaveBeenCalled();
  });

  // D-P3-1 ghost guard, end-to-end through runCycle: a tracked file whose id is
  // absent from live AND is NOT returned by `pageIdsExist` (a ghost — never a
  // page) must SURVIVE the whole cycle (no rm), while a sibling id that IS
  // returned (a genuinely deleted page row) is absence-deleted. This proves the
  // guard flows from pageIdsExist -> computePullActions -> applyPullActions,
  // not just at the pure `planReconciliation` unit.
  it("GHOST GUARD (e2e): a ghost tracked file SURVIVES runCycle; a real deleted-page file is removed", async () => {
    const ghostId = "019f2500-dead-7000-8000-000000000009"; // never a page
    const deletedId = "019f2500-0000-7000-8000-000000000001"; // a real (deleted) row
    const liveId = "019f2500-0000-7000-8000-0000000000aa"; // keeps empty-live from firing

    // Two tracked files, both ABSENT from the live tree (deletion candidates).
    const vault = fakeVault({
      listTrackedFiles: vi.fn(async () => ["Ghost.md", "Deleted.md"]),
    });

    // The datasource reports ONLY the deleted page as a real row; the ghost has
    // no row (a PROPER SUBSET of the probed ids, not the identity shim).
    const pageIdsExist = vi.fn(async (ids: string[]) =>
      ids.filter((id) => id === deletedId),
    );
    const rm = vi.fn(async () => undefined);

    const deps = baseDeps(vault, {
      fs: {
        readFile: vi.fn(async (absPath: string) => {
          if (absPath.includes("Ghost.md"))
            return serializePageFile(ghostId, "a body authored in git");
          if (absPath.includes("Deleted.md"))
            return serializePageFile(deletedId, "a deleted page body");
          return "";
        }),
        writeFile: vi.fn(async () => undefined),
        mkdir: vi.fn(async () => undefined),
        rm,
        lstat: vi.fn(async () => ({ isSymbolicLink: false })),
        realpath: vi.fn(async (p: string) => p),
      },
      client: {
        ...baseDeps(vault).client,
        // A single live page so the empty-live suppression does NOT fire (which
        // would mask the guard by suppressing every delete this cycle).
        listSpaceTree: vi.fn(async () => ({
          pages: [
            {
              id: liveId,
              slugId: "live",
              title: "Live",
              parentPageId: null,
              position: "a0",
              hasChildren: false,
            },
          ],
          complete: true,
        })),
        pageIdsExist,
        getPageJson: vi.fn(async (pageId: string) => ({
          id: pageId,
          slugId: "live",
          title: "Live",
          parentPageId: null,
          spaceId: "space-1",
          updatedAt: "2026-06-20T00:00:00.000Z",
          content: { type: "doc", content: [] },
        })),
      } as any,
    });

    const res = await runCycle(deps);
    expect(res.ran).toBe(true);

    // The guard probed the datasource for EXACTLY the absent candidate ids.
    expect(pageIdsExist).toHaveBeenCalledTimes(1);
    expect(new Set(pageIdsExist.mock.calls[0][0])).toEqual(
      new Set([ghostId, deletedId]),
    );

    // The real deleted-page file is removed; the ghost file is PRESERVED.
    const rmPaths = rm.mock.calls.map((c) => c[0] as string);
    expect(rmPaths.some((p) => p.includes("Deleted.md"))).toBe(true);
    expect(rmPaths.some((p) => p.includes("Ghost.md"))).toBe(false);
    expect(res.pull?.deleted).toBe(1);
  });
});
