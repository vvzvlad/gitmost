import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCycle } from "../src/engine/cycle";
import type { CycleFs } from "../src/engine/cycle";
import { VaultGit } from "../src/engine/git";
import type { Settings } from "../src/engine/settings";
import { serializeDocmostMarkdownBody } from "@docmost/prosemirror-markdown";

const execFileAsync = promisify(execFile);

// runCycle (full PULL -> PUSH choreography) against a REAL VaultGit in a temp
// repo, with a faked Docmost client. This is the integration guard for the
// extraction of the cycle out of the app orchestrator: it proves runCycle wires
// the real engine pull + push together against real git and delivers a
// git-originated CREATE to the client. (The full two-way data-loss invariant —
// a local main edit surviving a concurrent Docmost edit — is exercised end to
// end against a live server in the git-sync e2e stand.)

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function makeSettings(vaultPath: string): Settings {
  return {
    docmostSpaceId: "space-1",
    vaultPath,
    pollIntervalMs: 15000,
    debounceMs: 2000,
    logLevel: "info",
  } as Settings;
}

/** Node-fs CycleFs rooted nowhere (absolute paths are passed through). */
const nodeFs: CycleFs = {
  readFile: (absPath) => readFile(absPath, "utf8"),
  writeFile: (absPath, text) => writeFile(absPath, text, "utf8"),
  mkdir: async (absDir) => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(absDir, { recursive: true });
  },
  rm: async (absPath) => {
    const fs = await import("node:fs/promises");
    await fs.rm(absPath, { force: true });
  },
  // Real symlink-guard primitives (ENOENT -> null), mirroring the server wiring.
  lstat: async (absPath) => {
    const fs = await import("node:fs/promises");
    try {
      const st = await fs.lstat(absPath);
      return { isSymbolicLink: st.isSymbolicLink() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
  realpath: async (absPath) => {
    const fs = await import("node:fs/promises");
    try {
      return await fs.realpath(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
};

/** A minimal recording client; empty Docmost so the pull is a no-op. */
function makeEmptyClientFake() {
  return {
    listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
    // Default: every candidate id is a real page row (historical behavior).
    pageIdsExist: vi.fn(async (ids: string[]) => ids),
    getPageJson: vi.fn(),
    importPageMarkdown: vi.fn(async () => ({ updatedAt: "2026-06-20T00:00:00.000Z" })),
    createPage: vi.fn(async (title: string) => ({
      data: { id: "new-id", title },
      updatedAt: "2026-06-20T00:00:00.000Z",
    })),
    deletePage: vi.fn(async () => ({})),
    movePage: vi.fn(async () => ({})),
    renamePage: vi.fn(async () => ({})),
    listRecentSince: vi.fn(async () => []),
    listTrash: vi.fn(async () => []),
    restorePage: vi.fn(async () => ({})),
  };
}

describe("runCycle against a REAL VaultGit (integration)", () => {
  let available = false;
  let dir: string;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("runs the full PULL->PUSH and delivers a git-originated CREATE to the client", async () => {
    if (!available) return; // skip gracefully when git is unavailable

    dir = await mkdtemp(join(tmpdir(), "docmost-cycle-realgit-"));
    const git = new VaultGit(dir);
    await git.ensureRepo();
    await git.ensureBranch("docmost", "main");

    // A human committed a brand-new file on `main` (meta has title + spaceId but
    // NO pageId) -> the push side must classify it as a CREATE.
    const newFile = serializeDocmostMarkdownBody(
      { version: 1, title: "From Git", spaceId: "space-1" },
      "a body authored in git",
    );
    await writeFile(join(dir, "From Git.md"), newFile, "utf8");
    await git.stageAll();
    await git.commit("add From Git.md", {
      authorName: "Human",
      authorEmail: "human@local",
    });

    const client = makeEmptyClientFake();
    const res = await runCycle({
      spaceId: "space-1",
      client: client as any,
      vault: git,
      settings: makeSettings(dir),
      fs: nodeFs,
      log: () => undefined,
    });

    expect(res.ran).toBe(true);
    expect(res.push?.failures).toBe(0);
    // The CREATE reached Docmost (the push side ran end to end through runCycle).
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(client.createPage.mock.calls[0][0]).toBe("From Git");

    // The engine wrote the assigned pageId back into the file on disk.
    const onDisk = await readFile(join(dir, "From Git.md"), "utf8");
    expect(onDisk).toContain("new-id");
  });

  it("RECOVERS a vault left mid-merge instead of wedging the whole space", async () => {
    if (!available) return;

    dir = await mkdtemp(join(tmpdir(), "docmost-cycle-merge-"));
    const git = new VaultGit(dir);
    await git.ensureRepo();
    // Force a conflicting state: create divergent commits on main and docmost
    // touching the same file, then attempt a merge so the tree is left mid-merge.
    await writeFile(join(dir, "C.md"), "base\n", "utf8");
    await git.stageAll();
    await git.commit("base", { authorName: "h", authorEmail: "h@l" });
    await git.ensureBranch("docmost", "main");
    await git.checkout("docmost");
    await writeFile(join(dir, "C.md"), "docmost-side\n", "utf8");
    await git.stageAll();
    await git.commit("docmost edit", { authorName: "h", authorEmail: "h@l" });
    await git.checkout("main");
    await writeFile(join(dir, "C.md"), "main-side\n", "utf8");
    await git.stageAll();
    await git.commit("main edit", { authorName: "h", authorEmail: "h@l" });
    // Start a conflicting merge and leave it unresolved (the wedged state).
    await execFileAsync("git", ["-C", dir, "merge", "docmost"]).catch(() => {});
    expect(await git.isMergeInProgress()).toBe(true);

    const client = makeEmptyClientFake();
    const res = await runCycle({
      spaceId: "space-1",
      client: client as any,
      vault: git,
      settings: makeSettings(dir),
      fs: nodeFs,
      log: () => undefined,
    });

    // WEDGE FIX: the cycle does NOT skip forever — it aborts the stale merge and
    // RUNS the full pull/push. The space is no longer frozen.
    expect(res.ran).toBe(true);
    expect(client.listSpaceTree).toHaveBeenCalled();
    // And crucially, the vault is NOT left mid-merge afterward (the re-merge of a
    // genuinely conflicting page is committed-with-markers, not wedged), so the
    // next cycle can run too.
    expect(await git.isMergeInProgress()).toBe(false);

    // A SECOND cycle also runs cleanly (proves the wedge is gone for good).
    const res2 = await runCycle({
      spaceId: "space-1",
      client: client as any,
      vault: git,
      settings: makeSettings(dir),
      fs: nodeFs,
      log: () => undefined,
    });
    expect(res2.ran).toBe(true);
    expect(await git.isMergeInProgress()).toBe(false);
  });
});
