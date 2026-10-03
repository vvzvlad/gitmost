import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCycle } from "../src/engine/cycle";
import { VaultGit } from "../src/engine/git";
import {
  git,
  gitAvailable,
  makeClient,
  makeSettings,
  nodeFs,
  type FakePage,
} from "./cycle-realgit-helpers";

// Change detection: the pull re-reads (getPageJson) and re-converts only live
// pages whose export key (updatedAt + relPath + tree fields) changed since their
// last successful export. Driven against a REAL vault so the skip is proven on
// the observable property — the number of page reads — across real cycles.

const P = "019f2700-0000-7000-8000-00000000000a"; // parent (has children)
const C1 = "019f2700-0000-7000-8000-00000000000b";
const C2 = "019f2700-0000-7000-8000-00000000000c";
const R = "019f2700-0000-7000-8000-00000000000d"; // unrelated root page
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

function fixturePages(): FakePage[] {
  return [
    { id: P, slugId: "p", title: "Parent", parentPageId: null, updatedAt: T0, text: "parent body" },
    { id: C1, slugId: "c1", title: "Child One", parentPageId: P, updatedAt: T0, text: "child one" },
    { id: C2, slugId: "c2", title: "Child Two", parentPageId: P, updatedAt: T0, text: "child two" },
    { id: R, slugId: "r", title: "Root", parentPageId: null, updatedAt: T0, text: "root body" },
  ];
}

describe("runCycle — export-key change detection", () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), "docmost-export-keys-"));
    const vault = new VaultGit(dir);
    const pages = fixturePages();
    const client = makeClient(pages);
    const exportKeys = new Map<string, string>();
    const root = dir;
    const cycle = (signal?: AbortSignal) =>
      runCycle({
        spaceId: "space-1",
        client: client as any,
        vault,
        settings: makeSettings(root),
        fs: nodeFs,
        log: () => undefined,
        warn: () => undefined,
        exportKeys,
        signal,
      });
    /** Page ids read via getPageJson since the last call (then resets). */
    const reads = (): string[] => {
      const ids = client.getPageJson.mock.calls.map((c) => c[0] as string);
      client.getPageJson.mockClear();
      return ids.sort();
    };
    // Initial full export.
    expect((await cycle()).ran).toBe(true);
    expect(reads()).toEqual([P, C1, C2, R].sort());
    expect(exportKeys.size).toBe(4);
    return { dir: root, pages, client, exportKeys, cycle, reads };
  }

  it("a second cycle with nothing changed reads ZERO pages", async () => {
    if (!available) return;
    const { cycle, reads, exportKeys } = await setup();

    const res = await cycle();

    expect(res.ran).toBe(true);
    expect(reads()).toEqual([]);
    expect(exportKeys.size).toBe(4);
  });

  it("bumping one page's updatedAt re-exports exactly that page", async () => {
    if (!available) return;
    const { dir, pages, cycle, reads } = await setup();

    const r = pages.find((p) => p.id === R)!;
    r.updatedAt = T1;
    r.text = "root body edited";
    await cycle();

    expect(reads()).toEqual([R]);
    expect(await git(dir, "show", "main:Root.md")).toContain("root body edited");
  });

  it("renaming a parent re-exports the parent AND the children whose relPath changed, nothing else", async () => {
    if (!available) return;
    const { dir, pages, cycle, reads } = await setup();

    // Only the parent row changes (its title + updatedAt); the children's rows
    // are untouched, but their folder (relPath) follows the parent's name.
    const parent = pages.find((p) => p.id === P)!;
    parent.title = "Renamed";
    parent.updatedAt = T1;
    await cycle();

    expect(reads()).toEqual([P, C1, C2].sort());
    const tree = (await git(dir, "ls-tree", "-r", "--name-only", "main")).split("\n");
    expect(tree.sort()).toEqual(
      [
        "Renamed/Renamed.md",
        "Renamed/Child One.md",
        "Renamed/Child Two.md",
        "Root.md",
      ].sort(),
    );
  });

  it("a preflight recovery (stale git lock removed) clears the keys: the cycle is a full pass", async () => {
    if (!available) return;
    const { dir, cycle, reads } = await setup();

    const lock = join(dir, ".git", "index.lock");
    await writeFile(lock, "");
    const anHourAgo = Date.now() / 1000 - 3600;
    await utimes(lock, anHourAgo, anHourAgo);
    await cycle();

    expect(reads()).toEqual([P, C1, C2, R].sort());
  });

  it("a failed cycle clears the keys: the next cycle is a full pass", async () => {
    if (!available) return;
    const { cycle, reads, exportKeys } = await setup();

    const aborted = new AbortController();
    aborted.abort();
    await expect(cycle(aborted.signal)).rejects.toThrow();
    expect(exportKeys.size).toBe(0);

    await cycle();
    expect(reads()).toEqual([P, C1, C2, R].sort());
  });

  it("a page whose export failed is not recorded and is read again next cycle", async () => {
    if (!available) return;
    const { client, cycle, reads, exportKeys, pages } = await setup();

    const r = pages.find((p) => p.id === R)!;
    r.updatedAt = T1;
    client.getPageJson.mockRejectedValueOnce(new Error("db hiccup"));
    await cycle();
    expect(reads()).toEqual([R]);
    expect(exportKeys.has(R)).toBe(false);

    await cycle();
    expect(reads()).toEqual([R]);
    expect(exportKeys.has(R)).toBe(true);
  });
});
