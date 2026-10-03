/**
 * Shared fixtures for the runCycle tests that drive a REAL VaultGit in a temp
 * repo (crash recovery + export-key change detection): a node-fs `CycleFs`, the
 * engine `Settings`, a git-availability probe, a mutable fake Docmost client and
 * small git shell helpers.
 */
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { vi } from "vitest";
import type { CycleFs } from "../src/engine/cycle";
import type { Settings } from "../src/engine/settings";

export const execFileAsync = promisify(execFile);

export async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Run git in `cwd` with a fixed identity; returns trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=Human", "-c", "user.email=human@local", ...args],
    { cwd },
  );
  return stdout.trim();
}

export function makeSettings(vaultPath: string): Settings {
  return {
    docmostSpaceId: "space-1",
    vaultPath,
    pollIntervalMs: 15000,
    debounceMs: 2000,
    logLevel: "info",
  } as Settings;
}

/** Absolute-path node-fs primitives, mirroring the server wiring. */
export const nodeFs: CycleFs = {
  readFile: (absPath) => readFile(absPath, "utf8"),
  writeFile: (absPath, text) => writeFile(absPath, text, "utf8"),
  mkdir: async (absDir) => {
    await mkdir(absDir, { recursive: true });
  },
  rm: (absPath) => rm(absPath, { force: true }),
  lstat: async (absPath) => {
    try {
      const st = await lstat(absPath);
      return { isSymbolicLink: st.isSymbolicLink() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
  realpath: async (absPath) => {
    try {
      return await realpath(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  },
};

/** One page of the fake Docmost space. Tests mutate these in place. */
export interface FakePage {
  id: string;
  slugId: string;
  title: string;
  parentPageId: string | null;
  updatedAt: string;
  /** The page body: one paragraph per "\n\n"-separated chunk; `null` = no content. */
  text: string | null;
}

/**
 * A fake Docmost client over a MUTABLE page list: `listSpaceTree` and
 * `getPageJson` always reflect the current `pages` array, writes are recorded
 * no-ops (`createPage` returns the next id from `createdIds`).
 */
export function makeClient(pages: FakePage[], createdIds: string[] = []) {
  const doc = (text: string | null) =>
    text === null
      ? null
      : {
          type: "doc",
          content: text.split("\n\n").map((t) => ({
            type: "paragraph",
            content: [{ type: "text", text: t }],
          })),
        };
  return {
    listSpaceTree: vi.fn(async () => ({
      pages: pages.map((p) => ({
        id: p.id,
        slugId: p.slugId,
        title: p.title,
        parentPageId: p.parentPageId,
        hasChildren: pages.some((c) => c.parentPageId === p.id),
        updatedAt: p.updatedAt,
      })),
      complete: true,
    })),
    pageIdsExist: vi.fn(async (ids: string[]) => ids),
    getPageJson: vi.fn(async (pageId: string) => {
      const p = pages.find((x) => x.id === pageId);
      if (!p) throw new Error(`Page ${pageId} not found`);
      return {
        id: p.id,
        slugId: p.slugId,
        title: p.title,
        parentPageId: p.parentPageId,
        spaceId: "space-1",
        updatedAt: p.updatedAt,
        content: doc(p.text),
      };
    }),
    importPageMarkdown: vi.fn(async () => ({})),
    createPage: vi.fn(async () => ({
      data: { id: createdIds.shift() ?? "00000000-0000-4000-8000-0000000000ff" },
    })),
    deletePage: vi.fn(async () => ({})),
    movePage: vi.fn(async () => ({})),
    renamePage: vi.fn(async () => ({})),
    listRecentSince: vi.fn(async () => []),
    listTrash: vi.fn(async () => []),
    restorePage: vi.fn(async () => ({})),
  };
}
