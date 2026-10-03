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
const N1 = "019f2800-0000-7000-8000-0000000000c1";
const N2 = "019f2800-0000-7000-8000-0000000000c2";
const Q = "019f2800-0000-7000-8000-0000000000c3";
const C = "019f2800-0000-7000-8000-0000000000c4";
const P = "019f2800-0000-7000-8000-0000000000c5";
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
    return setupPages([
      { id: A, slugId: "a", title: "Page", parentPageId: null, updatedAt: T0, text },
    ]);
  }

  async function setupPages(pages: FakePage[]) {
    dir = await mkdtemp(join(tmpdir(), "docmost-no-echo-"));
    const root = dir;
    const vault = new VaultGit(root);
    const client = makeClient(pages);
    const exportKeys = new Map<string, string>();
    const cycle = (fs = nodeFs, v = vault) =>
      runCycle({
        spaceId: "space-1",
        client: client as any,
        vault: v,
        settings: makeSettings(root),
        fs,
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
    /** Change the vault on `main` and commit everything, as a human. */
    const humanCommit = async (change: (root: string) => Promise<void>) => {
      await change(root);
      await git(root, "add", "-A");
      await git(root, "commit", "-m", "human change");
    };
    /** The `main` tree as path -> content. */
    const mainFiles = async () => {
      const out: Record<string, string> = {};
      for (const f of (await git(root, "ls-tree", "-r", "--name-only", "main"))
        .split("\n")
        .filter(Boolean)) {
        out[f] = await git(root, "show", `main:${f}`);
      }
      return out;
    };
    // The live page text follows each write through the block-level 3-way.
    client.importPageMarkdown.mockImplementation(
      async (pageId: string, markdown: string, base: string | null) => {
        const p = pages.find((x) => x.id === pageId);
        if (p) p.text = merge3(base, markdown, p.text ?? "");
        return {};
      },
    );
    return {
      root,
      page: pages[0],
      pages,
      client,
      cycle,
      humanEdit,
      humanCommit,
      mainFiles,
    };
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

  // Page identity is the gitmost_id, not the path: a path can hold a different
  // page on each side of the pull merge.
  const twoNotes = (one: string, two: string): FakePage[] => [
    { id: N1, slugId: "a1", title: "Notes", parentPageId: null, updatedAt: T0, text: one },
    { id: N2, slugId: "b2", title: "Notes", parentPageId: null, updatedAt: T0, text: two },
  ];

  it.each([
    [
      "conflicting",
      "agenda one\n\nalpha\n\nbeta",
      "agenda two\n\ngamma\n\ndelta",
      ["agenda one", "agenda one GIT"],
    ],
    [
      "cleanly merging",
      "same body\n\nline two\n\nline three",
      "same body\n\nline two\n\nline three",
      ["line three", "line three GIT"],
    ],
  ])(
    "a git edit of a page whose bare path Docmost gave to its same-title sibling stays with that page (%s bodies)",
    async (_name, one, two, [from, to]) => {
      if (!available) return;
      const { pages, cycle, humanCommit, mainFiles } = await setupPages(
        twoNotes(one, two),
      );
      expect(Object.keys(await mainFiles()).sort()).toEqual([
        "Notes ~b2.md",
        "Notes.md",
      ]);

      // Docmost retitles N1, so N2 takes the bare Notes.md; git edits Notes.md (N1).
      pages[0].title = "Notes 2023";
      pages[0].updatedAt = T1;
      await humanCommit(async (root) => {
        const file = join(root, "Notes.md");
        const text = await readFile(file, "utf8");
        await writeFile(file, text.replace(from, to), "utf8");
      });
      const res = await cycle();

      // One page per path on both sides: a clean merge, no conflict.
      expect(res.pull.conflict).toBe(false);
      expect(res.push.failures).toBe(0);
      expect(pages[0].text).toBe(one.replace(from, to));
      expect(pages[1].text).toBe(two);
      const main = await mainFiles();
      expect(Object.keys(main).sort()).toEqual(["Notes 2023.md", "Notes.md"]);
      expect(main["Notes 2023.md"]).toContain(`gitmost_id: ${N1}`);
      expect(main["Notes 2023.md"]).toContain(to);
      expect(main["Notes.md"]).toContain(`gitmost_id: ${N2}`);
      expect(main["Notes.md"]).not.toContain(to);
    },
  );

  it("Docmost removes a page and its same-title sibling takes the bare path while git edits the sibling: the removed page stays removed", async () => {
    if (!available) return;
    const { pages, client, cycle, humanCommit, mainFiles } = await setupPages(
      twoNotes("agenda one\n\nalpha\n\nbeta", "agenda two\n\ngamma\n\ndelta"),
    );

    pages.splice(0, 1); // N1 goes to the trash; N2 takes Notes.md
    await humanCommit(async (root) => {
      const file = join(root, "Notes ~b2.md");
      await writeFile(file, (await readFile(file, "utf8")).replace("agenda two", "agenda two GIT"), "utf8");
    });
    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(pages[0].text).toBe("agenda two GIT\n\ngamma\n\ndelta");
    expect(client.importPageMarkdown).not.toHaveBeenCalledWith(
      N1,
      expect.anything(),
      expect.anything(),
    );
    expect(client.createPage).not.toHaveBeenCalled();
    const main = await mainFiles();
    expect(Object.keys(main)).toEqual(["Notes.md"]);
    expect(main["Notes.md"]).toContain(`gitmost_id: ${N2}`);
  });

  it("Docmost renames a page and creates another under the old title while git edits the old path: each page keeps its own text", async () => {
    if (!available) return;
    const { pages, client, cycle, humanCommit, mainFiles } = await setupPages([
      { id: A, slugId: "a", title: "Old", parentPageId: null, updatedAt: T0, text: "p1\n\np2\n\np3" },
    ]);

    pages[0].title = "New";
    pages[0].updatedAt = T1;
    pages.push({ id: Q, slugId: "q", title: "Old", parentPageId: null, updatedAt: T1, text: "q1\n\nq2\n\nq3" });
    await humanCommit(async (root) => {
      const file = join(root, "Old.md");
      await writeFile(file, (await readFile(file, "utf8")).replace("p1", "p1 GIT"), "utf8");
    });
    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(pages[0].text).toBe("p1 GIT\n\np2\n\np3");
    expect(pages[1].text).toBe("q1\n\nq2\n\nq3");
    expect(client.deletePage).not.toHaveBeenCalled();
    const main = await mainFiles();
    expect(Object.keys(main).sort()).toEqual(["New.md", "Old.md"]);
    expect(main["New.md"]).toContain(`gitmost_id: ${A}`);
    expect(main["New.md"]).toContain("p1 GIT");
    expect(main["Old.md"]).toContain(`gitmost_id: ${Q}`);
  });

  it("Docmost renames and edits a page while git edits it at the old path and adds an unrelated file at the new path: both edits land, git's file becomes its own page", async () => {
    if (!available) return;
    const { pages, client, cycle, humanCommit, mainFiles } = await setupPages([
      { id: A, slugId: "a", title: "Old", parentPageId: null, updatedAt: T0, text: "p1\n\np2\n\np3" },
    ]);

    const p3Doc = `p3 ${"DOC ".repeat(80).trim()}`;
    pages[0].title = "New";
    pages[0].text = `p1\n\np2\n\n${p3Doc}`;
    pages[0].updatedAt = T1;
    await humanCommit(async (root) => {
      const file = join(root, "Old.md");
      await writeFile(file, (await readFile(file, "utf8")).replace("p1", "p1 GIT"), "utf8");
      await writeFile(join(root, "New.md"), "an unrelated git page\n", "utf8");
    });
    const res = await cycle();

    expect(res.pull.conflict).toBe(false);
    expect(res.push.failures).toBe(0);
    expect(pages[0].text).toBe(`p1 GIT\n\np2\n\n${p3Doc}`);
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(client.createPage).toHaveBeenCalledWith(
      "New ~git",
      "an unrelated git page",
      "space-1",
      undefined,
    );
    const main = await mainFiles();
    expect(Object.keys(main).sort()).toEqual(["New ~git.md", "New.md"]);
    expect(main["New.md"]).toContain(`gitmost_id: ${A}`);
    expect(main["New ~git.md"]).toContain("an unrelated git page");
  });

  it.each([
    ["untouched in Docmost", "omega"],
    ["edited in Docmost", "omega DOC"],
  ])(
    "a git rename (with an edit) of a page %s renames the page and keeps both edits",
    async (_name, omega) => {
      if (!available) return;
      const { page, client, cycle, humanCommit, mainFiles } = await setup(
        "alpha\n\nmiddle\n\nomega",
      );
      client.renamePage.mockImplementation(async (id: string, title: string) => {
        if (id === A) page.title = title;
        return {};
      });

      page.text = `alpha\n\nmiddle\n\n${omega}`;
      page.updatedAt = T1;
      await humanCommit(async (root) => {
        const text = await readFile(join(root, "Page.md"), "utf8");
        await rm(join(root, "Page.md"));
        await writeFile(join(root, "Mine.md"), text.replace("alpha", "alpha GIT"), "utf8");
      });
      const res = await cycle();

      expect(res.push.failures).toBe(0);
      expect(client.renamePage).toHaveBeenCalledWith(A, "Mine");
      expect(client.deletePage).not.toHaveBeenCalled();
      expect(client.createPage).not.toHaveBeenCalled();
      expect(page.text).toBe(`alpha GIT\n\nmiddle\n\n${omega}`);
      expect(Object.keys(await mainFiles())).toEqual(["Mine.md"]);

      // It stays that way.
      await cycle();
      await cycle();
      expect(Object.keys(await mainFiles())).toEqual(["Mine.md"]);
      expect(client.createPage).not.toHaveBeenCalled();
      expect(page.text).toBe(`alpha GIT\n\nmiddle\n\n${omega}`);
    },
  );

  it("a copy of a page file (same gitmost_id) edited in git becomes a new page; the original stays as it was", async () => {
    if (!available) return;
    const { page, pages, client, cycle, humanCommit, mainFiles } = await setup(
      "alpha\n\nmiddle\n\nomega",
    );
    client.createPage.mockImplementation(async (title: string, content: string) => {
      pages.push({ id: C, slugId: "c", title, parentPageId: null, updatedAt: T1, text: content });
      return { data: { id: C } };
    });

    await humanCommit(async (root) => {
      const text = await readFile(join(root, "Page.md"), "utf8");
      await writeFile(join(root, "Page copy.md"), text.replace("middle", "middle COPY"), "utf8");
    });
    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(client.createPage).toHaveBeenCalledWith(
      "Page copy",
      "alpha\n\nmiddle COPY\n\nomega",
      "space-1",
      undefined,
    );
    expect(client.importPageMarkdown).not.toHaveBeenCalled();
    expect(page.text).toBe("alpha\n\nmiddle\n\nomega");
    const main = await mainFiles();
    expect(Object.keys(main).sort()).toEqual(["Page copy.md", "Page.md"]);
    expect(main["Page.md"]).toContain(`gitmost_id: ${A}`);
    expect(main["Page copy.md"]).toContain(`gitmost_id: ${C}`);

    // Both files survive the next cycles, each its own page.
    await cycle();
    await cycle();
    expect(Object.keys(await mainFiles()).sort()).toEqual(["Page copy.md", "Page.md"]);
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(client.importPageMarkdown).not.toHaveBeenCalled();
    expect(client.deletePage).not.toHaveBeenCalled();
  });

  it.each([["edited in Docmost", "omega DOC"], ["untouched in Docmost", "omega"]])(
    "a git rename plus an editor copy of the renamed file, page %s: the renamed file stays the page, the copy becomes a new page",
    async (_name, omega) => {
      if (!available) return;
      const { page, pages, client, cycle, humanCommit, mainFiles } = await setup(
        "alpha\n\nmiddle\n\nomega",
      );
      client.renamePage.mockImplementation(async (id: string, title: string) => {
        if (id === A) page.title = title;
        return {};
      });
      client.createPage.mockImplementation(async (title: string, content: string) => {
        pages.push({ id: C, slugId: "c", title, parentPageId: null, updatedAt: T1, text: content });
        return { data: { id: C } };
      });

      page.text = `alpha\n\nmiddle\n\n${omega}`;
      page.updatedAt = T1;
      // Obsidian names a copy "<name> 1.md", which sorts before "<name>.md".
      await humanCommit(async (root) => {
        const text = await readFile(join(root, "Page.md"), "utf8");
        await rm(join(root, "Page.md"));
        const renamed = text.replace("alpha", "alpha GIT");
        await writeFile(join(root, "Meeting.md"), renamed, "utf8");
        await writeFile(join(root, "Meeting 1.md"), renamed.replace("middle", "middle NEXT"), "utf8");
      });
      const res = await cycle();

      expect(res.push.failures).toBe(0);
      expect(client.renamePage).toHaveBeenCalledWith(A, "Meeting");
      expect(page.text).toBe(`alpha GIT\n\nmiddle\n\n${omega}`);
      for (const [, , base] of client.importPageMarkdown.mock.calls) {
        expect(base).not.toBeNull();
      }
      expect(client.createPage).toHaveBeenCalledTimes(1);
      expect(client.createPage).toHaveBeenCalledWith(
        "Meeting 1",
        "alpha GIT\n\nmiddle NEXT\n\nomega",
        "space-1",
        undefined,
      );
      const main = await mainFiles();
      expect(Object.keys(main).sort()).toEqual(["Meeting 1.md", "Meeting.md"]);
      expect(main["Meeting.md"]).toContain(`gitmost_id: ${A}`);
      expect(main["Meeting 1.md"]).toContain(`gitmost_id: ${C}`);

      await cycle();
      expect(Object.keys(await mainFiles()).sort()).toEqual(["Meeting 1.md", "Meeting.md"]);
      expect(client.createPage).toHaveBeenCalledTimes(1);
    },
  );

  // A path alignment can target a directory `main` does not have yet.
  const parentAndChild = (): FakePage[] => [
    { id: P, slugId: "p", title: "P", parentPageId: null, updatedAt: T0, text: "pa\n\npb" },
    { id: C, slugId: "c", title: "Child", parentPageId: P, updatedAt: T0, text: "ca\n\ncb" },
  ];

  it("Docmost gives a page its first child while git edits the page: both edits survive", async () => {
    if (!available) return;
    const { pages, cycle, humanCommit, mainFiles } = await setupPages([
      { id: P, slugId: "p", title: "P", parentPageId: null, updatedAt: T0, text: "pa\n\npb" },
    ]);

    pages.push({ id: C, slugId: "c", title: "Child", parentPageId: P, updatedAt: T1, text: "child" });
    pages[0].text = "pa\n\npb DOC";
    pages[0].updatedAt = T1;
    await humanCommit(async (root) => {
      const file = join(root, "P.md");
      await writeFile(file, (await readFile(file, "utf8")).replace("pa", "pa GIT"), "utf8");
    });
    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(pages[0].text).toBe("pa GIT\n\npb DOC");
    expect(Object.keys(await mainFiles()).sort()).toEqual(["P/Child.md", "P/P.md"]);
  });

  it("Docmost renames a folder page while git edits a child in it: both edits survive", async () => {
    if (!available) return;
    const { pages, cycle, humanCommit, mainFiles } = await setupPages(parentAndChild());

    pages[0].title = "R";
    pages[0].updatedAt = T1;
    pages[1].text = "ca\n\ncb DOC";
    pages[1].updatedAt = T1;
    await humanCommit(async (root) => {
      const file = join(root, "P", "Child.md");
      await writeFile(file, (await readFile(file, "utf8")).replace("ca", "ca GIT"), "utf8");
    });
    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(pages[1].text).toBe("ca GIT\n\ncb DOC");
    expect(Object.keys(await mainFiles()).sort()).toEqual(["R/Child.md", "R/R.md"]);
  });

  it("an alignment cut off between its file writes and its commit is redone, never committed as user work", async () => {
    if (!available) return;
    const { root, pages, client, cycle, humanCommit, mainFiles } = await setupPages(
      parentAndChild(),
    );

    pages[0].title = "R";
    pages[0].updatedAt = T1;
    await humanCommit(async (root) => {
      const file = join(root, "P", "Child.md");
      await writeFile(file, (await readFile(file, "utf8")).replace("ca", "ca GIT"), "utf8");
    });
    // The pull exports R/R.md on `docmost` first; the alignment's write of it
    // on `main` (the second) fails after R/Child.md was already written.
    let writesOfRR = 0;
    const failing = {
      ...nodeFs,
      writeFile: async (abs: string, text: string) => {
        if (abs.endsWith("/R/R.md") && ++writesOfRR === 2) {
          throw new Error("disk full");
        }
        return nodeFs.writeFile(abs, text);
      },
    };
    await expect(cycle(failing)).rejects.toThrow("disk full");

    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(pages[1].text).toBe("ca GIT\n\ncb");
    expect(client.createPage).not.toHaveBeenCalled();
    expect(Object.keys(await mainFiles()).sort()).toEqual(["R/Child.md", "R/R.md"]);
    expect(await git(root, "log", "--format=%s", "main")).not.toContain(
      "working-tree changes",
    );
  });

  it("a pull cut off while keeping a page at git's path after a clean merge is redone, never left half-applied", async () => {
    if (!available) return;
    const { page, client, cycle, humanCommit, mainFiles } = await setup(
      "alpha\n\nmiddle\n\nomega",
    );
    client.renamePage.mockImplementation(async (id: string, title: string) => {
      if (id === A) page.title = title;
      return {};
    });

    // Both sides rename the page (a clean path-based merge); git also edits it.
    page.title = "New";
    page.text = "alpha\n\nmiddle\n\nomega DOC";
    page.updatedAt = T1;
    await humanCommit(async (root) => {
      const text = await readFile(join(root, "Page.md"), "utf8");
      await rm(join(root, "Page.md"));
      await writeFile(join(root, "Mine.md"), text.replace("alpha", "alpha GIT"), "utf8");
    });
    const failing = {
      ...nodeFs,
      writeFile: async (abs: string, text: string) => {
        if (abs.endsWith("/Mine.md")) throw new Error("disk full");
        return nodeFs.writeFile(abs, text);
      },
    };
    await expect(cycle(failing)).rejects.toThrow("disk full");

    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(client.renamePage).toHaveBeenCalledWith(A, "Mine");
    expect(client.createPage).not.toHaveBeenCalled();
    expect(page.text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");
    expect(Object.keys(await mainFiles())).toEqual(["Mine.md"]);
  });

  it("an export cut off before its commit is not committed on main as user work", async () => {
    if (!available) return;
    const { root, page, cycle } = await setup("alpha\n\nmiddle\n\nomega");

    // The export's commit on `docmost` fails; the cycle then returns to `main`
    // with the exported file still uncommitted.
    page.text = "alpha DOC1\n\nmiddle\n\nomega";
    page.updatedAt = T1;
    const flaky = new VaultGit(root);
    flaky.commit = async () => {
      throw new Error("disk full");
    };
    await expect(cycle(nodeFs, flaky)).rejects.toThrow("disk full");

    page.text = "alpha DOC2\n\nmiddle\n\nomega";
    page.updatedAt = "2026-10-03T00:00:00.000Z";
    const res = await cycle();

    expect(res.push.failures).toBe(0);
    expect(page.text).toBe("alpha DOC2\n\nmiddle\n\nomega");
    expect(await git(root, "log", "--format=%s", "main")).not.toContain(
      "working-tree changes",
    );
  });
});
