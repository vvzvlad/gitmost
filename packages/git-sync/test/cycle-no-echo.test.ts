import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// The push half of a cycle must carry only what `main` has and Docmost lacks.
// The pull merges its own `docmost` export into `main`; pushing that back would
// merge a stale DB body into the live document (text typed meanwhile is lost).
// Driven against a REAL vault so the observable property is the set of
// `importPageMarkdown` calls across real cycles.

const A = "019f2800-0000-7000-8000-00000000000a";
const N = "019f2800-0000-7000-8000-00000000000b";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

/**
 * A block-level stand-in for the server's 3-way body merge: a block git
 * changed (target differs from base) wins, every other block keeps the live
 * text. No base means the target replaces the page.
 */
function merge3(base: string | null, target: string, live: string): string {
  if (base === null) return target.trim();
  const b = base.trim().split("\n\n");
  const t = target.trim().split("\n\n");
  const l = live.trim().split("\n\n");
  if (b.length !== t.length || t.length !== l.length) {
    throw new Error("merge3 fake: block counts differ");
  }
  return t.map((block, i) => (block !== b[i] ? block : l[i])).join("\n\n");
}

describe("runCycle — the push never echoes the pull's export", () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function setup(text: string) {
    dir = await mkdtemp(join(tmpdir(), "docmost-no-echo-"));
    const root = dir;
    const vault = new VaultGit(root);
    const pages: FakePage[] = [
      { id: A, slugId: "a", title: "Page", parentPageId: null, updatedAt: T0, text },
    ];
    const client = makeClient(pages);
    const exportKeys = new Map<string, string>();
    const cycle = () =>
      runCycle({
        spaceId: "space-1",
        client: client as any,
        vault,
        settings: makeSettings(root),
        fs: nodeFs,
        log: () => undefined,
        warn: () => undefined,
        exportKeys,
      });
    // Cycle 1: the initial export.
    const first = await cycle();
    expect(first.ran).toBe(true);
    expect(client.importPageMarkdown).not.toHaveBeenCalled();
    /** Edit `Page.md` on `main` and commit it, as a human pushing to the vault. */
    const humanEdit = async (from: string, to: string) => {
      const file = join(root, "Page.md");
      const before = await readFile(file, "utf8");
      expect(before).toContain(from);
      await writeFile(file, before.replace(from, to), "utf8");
      await git(root, "commit", "-am", "human edit");
    };
    return { root, page: pages[0], pages, client, cycle, humanEdit };
  }

  it("a Docmost edit exported in cycle 2 is not written back to Docmost", async () => {
    if (!available) return;
    const { root, page, client, cycle } = await setup("C1");

    page.text = "C2";
    page.updatedAt = T1;
    const res = await cycle();

    expect(await git(root, "show", "main:Page.md")).toContain("C2");
    expect(res.push.failures).toBe(0);
    expect(client.importPageMarkdown).not.toHaveBeenCalled();
  });

  it("a new Docmost page with null content is exported but never written back", async () => {
    if (!available) return;
    const { root, pages, client, cycle } = await setup("C1");

    pages.push({
      id: N,
      slugId: "n",
      title: "Empty",
      parentPageId: null,
      updatedAt: T1,
      text: null,
    });
    const res = await cycle();

    expect(await git(root, "ls-tree", "--name-only", "main")).toContain("Empty.md");
    expect(res.push.failures).toBe(0);
    expect(client.importPageMarkdown).not.toHaveBeenCalled();
  });

  it("a git edit is pushed with the docmost copy as its 3-way base", async () => {
    if (!available) return;
    const { page, client, cycle, humanEdit } = await setup("C1");

    // Both sides change the same block: the pull resolves to git, and the push
    // must merge against what Docmost holds now (C2), not the older C1.
    page.text = "C2";
    page.updatedAt = T1;
    await humanEdit("C1", "git edit");
    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(client.importPageMarkdown).toHaveBeenCalledTimes(1);
    expect(client.importPageMarkdown).toHaveBeenCalledWith(A, "git edit", "C2");
  });

  it("a git edit and a concurrent Docmost edit of another block both survive", async () => {
    if (!available) return;
    const { page, client, cycle, humanEdit } = await setup(
      "alpha\n\nmiddle\n\nomega",
    );

    page.text = "alpha\n\nmiddle\n\nomega DOCMOST";
    page.updatedAt = T1;
    await humanEdit("alpha", "alpha GIT");
    // The Docmost user keeps typing in the same block after the pull exported it.
    const exportPage = client.getPageJson.getMockImplementation()!;
    client.getPageJson.mockImplementation(async (pageId: string) => {
      const exported = await exportPage(pageId);
      if (pageId === A) page.text = "alpha\n\nmiddle\n\nomega DOCMOST more";
      return exported;
    });
    client.importPageMarkdown.mockImplementation(
      async (_pageId: string, markdown: string, base: string | null) => {
        page.text = merge3(base, markdown, page.text!);
        return {};
      },
    );
    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(client.importPageMarkdown).toHaveBeenCalledTimes(1);
    expect(page.text).toBe("alpha GIT\n\nmiddle\n\nomega DOCMOST more");
  });

  it("a pull conflict resolves per hunk: git wins block 1, Docmost's block 3 edit survives on main and in the live doc", async () => {
    if (!available) return;
    const { root, page, client, cycle, humanEdit } = await setup(
      "alpha\n\nmiddle\n\nomega",
    );

    // Docmost edits blocks 1 and 3; git edits block 1 only -> a real conflict.
    page.text = "alpha DOC\n\nmiddle\n\nomega DOC";
    page.updatedAt = T1;
    await humanEdit("alpha", "alpha GIT");
    client.importPageMarkdown.mockImplementation(
      async (_pageId: string, markdown: string, base: string | null) => {
        page.text = merge3(base, markdown, page.text!);
        return {};
      },
    );
    const res = await cycle();

    expect(res.pull.conflict).toBe(true);
    expect(res.push.failures).toBe(0);
    expect(page.text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");
    const onMain = await git(root, "show", "main:Page.md");
    expect(onMain).toContain("alpha GIT");
    expect(onMain).toContain("omega DOC");
    expect(onMain).not.toContain("alpha DOC");
    // Docmost's losing block-1 text stays in the vault history.
    expect(await git(root, "log", "--all", "--format=%H", "-S", "alpha DOC")).not.toBe("");
  });

  it("Docmost renames a page and edits block 3 while git edits block 1 at the old path: both edits land, Docmost's title and path stay", async () => {
    if (!available) return;
    const { root, page, client, cycle, humanEdit } = await setup(
      "alpha\n\nmiddle\n\nomega",
    );

    // A long block-3 edit, so git does not pair the old and new file as a rename.
    const omegaDoc = `omega ${"DOC ".repeat(80).trim()}`;
    page.title = "Renamed";
    page.text = `alpha\n\nmiddle\n\n${omegaDoc}`;
    page.updatedAt = T1;
    await humanEdit("alpha", "alpha GIT");
    client.importPageMarkdown.mockImplementation(
      async (_pageId: string, markdown: string, base: string | null) => {
        page.text = merge3(base, markdown, page.text!);
        return {};
      },
    );
    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(page.text).toBe(`alpha GIT\n\nmiddle\n\n${omegaDoc}`);
    expect(client.renamePage).not.toHaveBeenCalled();
    expect(client.movePage).not.toHaveBeenCalled();
    expect(await git(root, "ls-tree", "--name-only", "main")).toBe("Renamed.md");
    const onMain = await git(root, "show", "main:Renamed.md");
    expect(onMain).toContain("alpha GIT");
    expect(onMain).toContain(omegaDoc);
  });

  it("an add/add conflict keeps the Docmost page and git's version as a new page", async () => {
    if (!available) return;
    const { root, pages, client, cycle } = await setup("C1");

    // Docmost creates "New" while a git user adds a different New.md (carrying
    // the id of another page, which must not travel with git's copy).
    pages.push({
      id: N,
      slugId: "n",
      title: "New",
      parentPageId: null,
      updatedAt: T1,
      text: "docmost text",
    });
    await writeFile(
      join(root, "New.md"),
      `---\ngitmost_id: ${A}\n---\n\ngit text\n`,
      "utf8",
    );
    await git(root, "add", "New.md");
    await git(root, "commit", "-m", "human add");
    const res = await cycle();

    expect(res.pull.conflict).toBe(true);
    expect(res.push.failures).toBe(0);
    expect(client.importPageMarkdown).not.toHaveBeenCalled();
    const onMain = await git(root, "show", "main:New.md");
    expect(onMain).toContain("docmost text");
    expect(onMain).toContain(`gitmost_id: ${N}`);
    // git's version became its own page, created from the disambiguated file.
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(client.createPage).toHaveBeenCalledWith(
      "New ~git",
      "git text",
      "space-1",
      undefined,
    );
    const copy = await git(root, "show", "main:New ~git.md");
    expect(copy).toContain("git text");
    expect(copy).not.toContain(A);
  });

  it.each([
    ["drops the final newline", (t: string) => t.replace(/\n+$/, "")],
    ["adds trailing blank lines", (t: string) => `${t}\n\n`],
  ])(
    "a git commit that %s does not revert Docmost's last-block edit in a conflict",
    async (_name, retail) => {
      if (!available) return;
      const { root, page, client, cycle } = await setup(
        "alpha\n\nmiddle\n\nomega",
      );

      // Docmost edits blocks 1 and 3; git edits block 1 and changes the file's tail.
      page.text = "alpha DOC\n\nmiddle\n\nomega DOC";
      page.updatedAt = T1;
      const file = join(root, "Page.md");
      const before = await readFile(file, "utf8");
      await writeFile(file, retail(before.replace("alpha", "alpha GIT")), "utf8");
      await git(root, "commit", "-am", "human edit");
      client.importPageMarkdown.mockImplementation(
        async (_pageId: string, markdown: string, base: string | null) => {
          page.text = merge3(base, markdown, page.text!);
          return {};
        },
      );
      const res = await cycle();

      expect(res.pull.conflict).toBe(true);
      expect(res.push.failures).toBe(0);
      expect(await git(root, "show", "main:Page.md")).toContain("omega DOC");
      expect(page.text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");
    },
  );
});
