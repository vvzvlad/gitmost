import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializePageFile } from "@docmost/prosemirror-markdown";
import { recoverVault, runCycle } from "../src/engine/cycle";
import { VaultGit } from "../src/engine/git";
import {
  execFileAsync,
  git,
  gitAvailable,
  makeClient,
  makeSettings,
  nodeFs,
  type FakePage,
} from "./cycle-realgit-helpers";

// Crash recovery: a process killed between an engine file write and its commit
// (push write-back on `main`, pull export on `docmost`) leaves a DIRTY working
// tree. Without recovery every later cycle fails on `git checkout docmost` and
// every external push is rejected by receive.denyCurrentBranch=updateInstead.
// These tests leave a REAL vault in that crashed state and run a cycle.

const PAGE_ID = "019f2600-0000-7000-8000-000000000001";
const NEW_ID = "019f2600-0000-7000-8000-000000000002";
const CREATED_ID = "019f2600-0000-7000-8000-000000000003";

describe("runCycle — dirty working tree left by an interrupted cycle", () => {
  let available = false;
  const dirs: string[] = [];

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  async function tempDir(prefix: string): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  /** A vault synced by one clean cycle, servable like the /git host sets it up. */
  async function syncedVault(pages: FakePage[], createdIds: string[] = []) {
    const dir = await tempDir("docmost-dirty-");
    const vault = new VaultGit(dir);
    await vault.ensureRepo();
    await git(dir, "config", "receive.denyCurrentBranch", "updateInstead");
    const client = makeClient(pages, createdIds);
    const cycle = (warn = vi.fn()) =>
      runCycle({
        spaceId: "space-1",
        client: client as any,
        vault,
        settings: makeSettings(dir),
        fs: nodeFs,
        log: () => undefined,
        warn,
      });
    const first = await cycle();
    expect(first.ran).toBe(true);
    return { dir, vault, client, cycle };
  }

  /** Clone the vault, commit a file and push it back to `main`. */
  async function pushFromClone(dir: string, file: string): Promise<void> {
    const clone = await tempDir("docmost-clone-");
    await git(clone, "clone", "--quiet", dir, ".");
    await writeFile(join(clone, file), "pushed from a clone\n", "utf8");
    await git(clone, "add", "-A");
    await git(clone, "commit", "--quiet", "-m", `add ${file}`);
    await git(clone, "push", "--quiet", "origin", "HEAD:main");
  }

  function page(): FakePage {
    return {
      id: PAGE_ID,
      slugId: "page",
      title: "Page",
      parentPageId: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
      text: "original body",
    };
  }

  it("on `main`: commits the dirty tracked + untracked files, completes, loses nothing, and pushes are accepted again", async () => {
    if (!available) return;
    const { dir, vault, client, cycle } = await syncedVault([page()], [CREATED_ID]);

    // A human push added New.md on `main` (main is now ahead of `docmost`)...
    await writeFile(join(dir, "New.md"), "hand-written body\n", "utf8");
    await git(dir, "add", "-A");
    await git(dir, "commit", "--quiet", "-m", "human: add New.md");
    // ...then the push phase wrote New.md's pageId back and the process was
    // killed before the write-back commit. Plus an untracked file on `main`.
    await writeFile(
      join(dir, "New.md"),
      serializePageFile(NEW_ID, "hand-written body"),
      "utf8",
    );
    await writeFile(join(dir, "Untracked.md"), "untracked body\n", "utf8");

    // The crashed state really is the wedge: `checkout docmost` refuses, and an
    // external push is rejected (updateInstead needs a clean tree).
    await expect(
      execFileAsync("git", ["checkout", "docmost"], { cwd: dir }),
    ).rejects.toThrow(/overwritten/);
    await expect(pushFromClone(dir, "Rejected.md")).rejects.toThrow();

    const warn = vi.fn();
    const res = await cycle(warn);

    // The cycle completed instead of failing on the checkout.
    expect(res.ran).toBe(true);
    expect(res.push?.failures).toBe(0);
    // A WARN names the space and what was done.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("space-1");
    expect(warn.mock.calls[0][0]).toContain("committed");

    // Nothing was lost on `main`: both files are committed with their content.
    const newOnMain = await git(dir, "show", "main:New.md");
    expect(newOnMain).toContain(NEW_ID);
    expect(newOnMain).toContain("hand-written body");
    expect(await git(dir, "show", "main:Untracked.md")).toContain(
      "untracked body",
    );
    // ...and reached Docmost through the normal push (update + create).
    expect(client.importPageMarkdown).toHaveBeenCalledWith(
      NEW_ID,
      expect.stringContaining("hand-written body"),
      null,
    );
    expect(client.createPage.mock.calls.map((c) => c[0])).toEqual(["Untracked"]);

    // The tree is clean and on `main`, so an external push is accepted again.
    expect(await git(dir, "status", "--porcelain")).toBe("");
    expect(await vault.currentBranch()).toBe("main");
    await pushFromClone(dir, "Accepted.md");
    expect(await readFile(join(dir, "Accepted.md"), "utf8")).toBe(
      "pushed from a clone\n",
    );
  });

  it("on `docmost`: discards the half-written export + junk, completes, and pushes are accepted", async () => {
    if (!available) return;
    const { dir, vault, client, cycle } = await syncedVault([page()]);

    // The pull was killed mid-export: HEAD left on `docmost` with a modified
    // tracked file and untracked files/dirs never committed.
    await git(dir, "checkout", "--quiet", "docmost");
    await writeFile(
      join(dir, "Page.md"),
      serializePageFile(PAGE_ID, "half-writ"),
      "utf8",
    );
    await writeFile(join(dir, "Junk.md"), "junk\n", "utf8");
    await mkdir(join(dir, "Folder"), { recursive: true });
    await writeFile(join(dir, "Folder", "Child.md"), "junk child\n", "utf8");

    const warn = vi.fn();
    const res = await cycle(warn);

    expect(res.ran).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("space-1");
    expect(warn.mock.calls[0][0]).toContain("discarded");

    // The junk never reached either branch (nor Docmost as a created page)...
    expect(existsSync(join(dir, "Junk.md"))).toBe(false);
    expect(existsSync(join(dir, "Folder"))).toBe(false);
    expect(await git(dir, "ls-tree", "-r", "--name-only", "main")).toBe(
      "Page.md",
    );
    expect(await git(dir, "ls-tree", "-r", "--name-only", "docmost")).toBe(
      "Page.md",
    );
    expect(client.createPage).not.toHaveBeenCalled();
    // ...and `main` carries the page as Docmost has it (the regenerated export).
    expect(await git(dir, "show", "main:Page.md")).toBe(
      serializePageFile(PAGE_ID, "original body").trimEnd(),
    );

    expect(await git(dir, "status", "--porcelain")).toBe("");
    expect(await vault.currentBranch()).toBe("main");
    await pushFromClone(dir, "Accepted.md");
    expect(existsSync(join(dir, "Accepted.md"))).toBe(true);
  });

  // The /git push path runs recoverVault under the lock BEFORE the receive-pack
  // (orchestrator.ingestExternalPush), so a crash's leftovers no longer make
  // receive.denyCurrentBranch=updateInstead refuse the push.
  describe("recoverVault before an external push", () => {
    /** A clone of the vault with one new commit, not pushed yet. */
    async function cloneWithCommit(dir: string, file: string): Promise<string> {
      const clone = await tempDir("docmost-clone-");
      await git(clone, "clone", "--quiet", dir, ".");
      await writeFile(join(clone, file), "pushed from a clone\n", "utf8");
      await git(clone, "add", "-A");
      await git(clone, "commit", "--quiet", "-m", `add ${file}`);
      return clone;
    }

    it("an interrupted pull's leftovers on `main` are discarded: the push is accepted", async () => {
      if (!available) return;
      const { dir, vault } = await syncedVault([page()]);
      const clone = await cloneWithCommit(dir, "Pushed.md");

      // A pull cut off while writing `main` (its marker still set).
      await git(dir, "update-ref", "refs/docmost/pulling", "HEAD");
      await writeFile(
        join(dir, "Page.md"),
        serializePageFile(PAGE_ID, "half-merged"),
        "utf8",
      );
      await writeFile(join(dir, "Page ~git.md"), "half-written copy\n", "utf8");
      await expect(
        git(clone, "push", "--quiet", "origin", "HEAD:main"),
      ).rejects.toThrow(/unstaged changes|denyCurrentBranch|rejected/);

      const warn = vi.fn();
      expect(
        await recoverVault({ spaceId: "space-1", vault, log: () => undefined, warn }),
      ).toBe(true);
      await git(clone, "push", "--quiet", "origin", "HEAD:main");

      expect(await readFile(join(dir, "Pushed.md"), "utf8")).toBe(
        "pushed from a clone\n",
      );
      expect(await git(dir, "status", "--porcelain")).toBe("");
      expect(existsSync(join(dir, "Page ~git.md"))).toBe(false);
      expect(await git(dir, "show", "main:Page.md")).toContain("original body");
      expect(warn.mock.calls[0][0]).toContain("discarded");
    });

    it("an interrupted push's id write-backs are committed: a clone up to date with `main` pushes", async () => {
      if (!available) return;
      const { dir, vault } = await syncedVault([page()]);
      const clone = await cloneWithCommit(dir, "Pushed.md");

      // A push cut off between an id write-back and its commit (no marker).
      await writeFile(join(dir, "New.md"), serializePageFile(NEW_ID, "new body"), "utf8");

      expect(
        await recoverVault({ spaceId: "space-1", vault, log: () => undefined }),
      ).toBe(true);
      // `main` gained the write-back commit, so the clone first takes it, as for
      // any commit it does not have yet; then the push lands.
      await git(clone, "pull", "--quiet", "--rebase", "origin", "main");
      await git(clone, "push", "--quiet", "origin", "HEAD:main");

      expect(await readFile(join(dir, "Pushed.md"), "utf8")).toBe(
        "pushed from a clone\n",
      );
      expect(await git(dir, "show", "main:New.md")).toContain(NEW_ID);
      expect(await git(dir, "status", "--porcelain")).toBe("");
    });
  });
});
