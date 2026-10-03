import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCycle } from "../src/engine/cycle";
import { VaultGit } from "../src/engine/git";
import {
  LAST_PUSHED_REF,
  MAX_GIT_COPY_CREATES,
  RECORD_REF,
} from "../src/engine/push";
import { git, gitAvailable, makeSettings, nodeFs } from "./cycle-realgit-helpers";

// A push where some pages fail must still advance the merge base over the pages
// that DID reach Docmost: the pull moves that base every cycle, so a page left
// in the diff is re-sent from a stale base (reverting newer Docmost edits) and a
// created page meets its own export as an add/add (a `~git` duplicate per cycle).
// Driven against a REAL vault and a fake Docmost that applies every write.

const P = "019f2800-0000-7000-8000-0000000000a1";
const BAD = "019f2800-0000-7000-8000-0000000000b1";

interface Page {
  id: string;
  slugId: string;
  title: string;
  parentPageId: string | null;
  updatedAt: string;
  text: string;
}

/** A block-level 3-way: a block git changed wins, others keep the live text. */
function merge3(base: string | null, target: string, live: string): string {
  if (base === null) return target.trim();
  const b = base.trim().split("\n\n");
  const t = target.trim().split("\n\n");
  const l = live.trim().split("\n\n");
  if (b.length !== t.length || t.length !== l.length) return target.trim();
  return t.map((block, i) => (block !== b[i] ? block : l[i])).join("\n\n");
}

let tick = 1;
const ts = () => new Date(Date.UTC(2026, 9, 1, 0, 0, tick++)).toISOString();

describe("runCycle — a push with failures advances the base per page", () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function setup(
    texts: { id: string; title: string; text: string }[],
  ) {
    dir = await mkdtemp(join(tmpdir(), "docmost-partial-push-"));
    const root = dir;
    const pages: Page[] = texts.map((t, i) => ({
      id: t.id,
      slugId: `s${i}`,
      title: t.title,
      parentPageId: null,
      updatedAt: ts(),
      text: t.text,
    }));
    /** Every import of these pages throws. */
    const failing = new Set<string>();
    /** The next `<op>:<pageId>` call throws, once. */
    const failOnce = new Set<string>();
    const fail = (op: string, id: string) => {
      if (failOnce.delete(`${op}:${id}`)) {
        throw new Error(`injected ${op} failure for ${id}`);
      }
    };
    const calls: string[][] = [];
    let nextId = 0x100;
    const client = {
      listSpaceTree: async () => ({
        pages: pages.map((p) => ({
          id: p.id,
          slugId: p.slugId,
          title: p.title,
          parentPageId: p.parentPageId,
          hasChildren: pages.some((c) => c.parentPageId === p.id),
          updatedAt: p.updatedAt,
        })),
        complete: true,
      }),
      pageIdsExist: async (ids: string[]) =>
        ids.filter((id) => pages.some((p) => p.id === id)),
      getPageJson: async (id: string) => {
        const p = pages.find((x) => x.id === id);
        if (!p) throw new Error(`Page ${id} not found`);
        return {
          id: p.id,
          slugId: p.slugId,
          title: p.title,
          parentPageId: p.parentPageId,
          spaceId: "space-1",
          updatedAt: p.updatedAt,
          content: {
            type: "doc",
            content: p.text.split("\n\n").map((t) => ({
              type: "paragraph",
              content: [{ type: "text", text: t }],
            })),
          },
          lastUpdatedSource: "user",
        };
      },
      importPageMarkdown: async (id: string, md: string, base: string | null) => {
        calls.push(["import", id]);
        if (failing.has(id)) throw new Error(`injected failure for ${id}`);
        fail("import", id);
        const p = pages.find((x) => x.id === id);
        if (p) {
          p.text = merge3(base, md, p.text);
          p.updatedAt = ts();
        }
        return {};
      },
      createPage: async (title: string, content: string) => {
        const id = `019f2800-0000-7000-8000-000000000${(nextId++).toString(16)}`;
        calls.push(["create", title]);
        pages.push({
          id,
          slugId: `n${nextId}`,
          title,
          parentPageId: null,
          updatedAt: ts(),
          text: content.trim(),
        });
        return { data: { id } };
      },
      deletePage: async (id: string) => {
        calls.push(["delete", id]);
        fail("delete", id);
        const i = pages.findIndex((x) => x.id === id);
        if (i >= 0) pages.splice(i, 1);
        return {};
      },
      movePage: async (id: string, parentPageId: string | null) => {
        calls.push(["move", id]);
        fail("move", id);
        const p = pages.find((x) => x.id === id);
        if (p) p.parentPageId = parentPageId;
        return {};
      },
      renamePage: async (id: string, title: string) => {
        calls.push(["rename", id]);
        fail("rename", id);
        const p = pages.find((x) => x.id === id);
        if (p) {
          p.title = title;
          p.updatedAt = ts();
        }
        return {};
      },
      listRecentSince: async () => [],
      listTrash: async () => [],
      restorePage: async () => ({}),
    };
    const vault = new VaultGit(root);
    const exportKeys = new Map<string, string>();
    const cycle = (v: VaultGit = vault) => {
      calls.length = 0;
      return runCycle({
        spaceId: "space-1",
        client: client as any,
        vault: v,
        settings: makeSettings(root),
        fs: nodeFs,
        log: () => undefined,
        warn: () => undefined,
        exportKeys,
      });
    };
    /** Change the vault on `main` and commit everything, as a human. */
    const human = async (change: (root: string) => Promise<void>) => {
      await change(root);
      await git(root, "add", "-A");
      await git(root, "commit", "-m", "human change");
    };
    const edit = (file: string, from: string, to: string) => async () => {
      const abs = join(root, file);
      await writeFile(abs, (await readFile(abs, "utf8")).replace(from, to), "utf8");
    };
    const mainFiles = async () =>
      (await git(root, "ls-tree", "-r", "--name-only", "main"))
        .split("\n")
        .filter(Boolean);
    const heads = () => git(root, "rev-parse", "main", "docmost");
    /** `vault`, except that updating `ref` throws: a crash right before it. */
    const crashingBefore = (ref: string): VaultGit => {
      const v = Object.create(vault) as VaultGit;
      v.updateRef = async (r: string, target: string, expected?: string) => {
        if (r === ref) throw new Error(`crash before updating ${r}`);
        return vault.updateRef(r, target, expected);
      };
      return v;
    };
    return {
      root,
      pages,
      failing,
      failOnce,
      calls,
      cycle,
      human,
      edit,
      mainFiles,
      heads,
      crashingBefore,
    };
  }

  // A new page in non-canonical markdown: Docmost's export of it differs.
  const NEW_MD = "* item one\n* item two\n\n__bold__ text\n";

  it("a page that keeps failing does not hold back a pushed page: a later Docmost edit of it is kept, it is not re-imported, and the failing page is retried alone", async () => {
    if (!available) return;
    const h = await setup([
      { id: P, title: "Page", text: "alpha\n\nbeta" },
      { id: BAD, title: "Bad", text: "bad" },
    ]);
    h.failing.add(BAD);
    await h.cycle();
    await h.human(async () => {
      await h.edit("Bad.md", "bad", "bad GIT")();
      await h.edit("Page.md", "beta", "__beta2__")();
    });
    await h.cycle();
    await h.cycle();
    const page = h.pages.find((p) => p.id === P)!;
    expect(page.text).toBe("alpha\n\n__beta2__");

    // A Docmost user edits the block git changed.
    page.text = "alpha\n\ngamma (docmost edit)";
    page.updatedAt = ts();
    const perCycle: string[][][] = [];
    let settled = "";
    for (let i = 0; i < 4; i++) {
      const res = await h.cycle();
      expect(res.push?.failures).toBe(1);
      perCycle.push(h.calls.map((c) => [...c]));
      if (i === 2) settled = await h.heads();
    }

    expect(page.text).toBe("alpha\n\ngamma (docmost edit)");
    // Only the failing page is retried, once per cycle; Page is never re-sent.
    for (const calls of perCycle) expect(calls).toEqual([["import", BAD]]);
    expect(await git(h.root, "show", "main:Bad.md")).toContain("bad GIT");
    expect(await git(h.root, "show", "main:Page.md")).toContain(
      "gamma (docmost edit)",
    );
    // A page that keeps failing adds no commits.
    expect(await h.heads()).toBe(settled);
  });

  it("a new page pushed alongside a page that keeps failing is created once: no '~git' copies", async () => {
    if (!available) return;
    const h = await setup([
      { id: P, title: "Page", text: "pa" },
      { id: BAD, title: "Bad", text: "bad" },
    ]);
    h.failing.add(BAD);
    await h.cycle();
    await h.human(async (root) => {
      await h.edit("Bad.md", "bad", "bad GIT")();
      await writeFile(join(root, "New.md"), NEW_MD, "utf8");
    });

    const creates: string[][] = [];
    for (let i = 0; i < 4; i++) {
      await h.cycle();
      creates.push(...h.calls.filter((c) => c[0] === "create"));
      expect(h.calls.filter((c) => c[0] === "import")).toEqual([["import", BAD]]);
    }

    expect(creates).toEqual([["create", "New"]]);
    expect((await h.mainFiles()).sort()).toEqual(["Bad.md", "New.md", "Page.md"]);
    expect(h.pages.map((p) => p.title).sort()).toEqual(["Bad", "New", "Page"]);
    expect(await git(h.root, "show", "main:Bad.md")).toContain("bad GIT");
  });

  it("a single transient failure in a create's cycle leaves no duplicate, and the failed page's edit lands on retry", async () => {
    if (!available) return;
    const h = await setup([
      { id: P, title: "Page", text: "pa" },
      { id: BAD, title: "Bad", text: "bad" },
    ]);
    await h.cycle();
    h.failOnce.add(`import:${BAD}`);
    await h.human(async (root) => {
      await h.edit("Bad.md", "bad", "bad GIT")();
      await writeFile(join(root, "New.md"), NEW_MD, "utf8");
    });

    const creates: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await h.cycle();
      creates.push(...h.calls.filter((c) => c[0] === "create"));
    }

    expect(creates).toEqual([["create", "New"]]);
    expect((await h.mainFiles()).sort()).toEqual(["Bad.md", "New.md", "Page.md"]);
    expect(h.pages.map((p) => p.title).sort()).toEqual(["Bad", "New", "Page"]);
    expect(h.pages.find((p) => p.id === BAD)?.text).toBe("bad GIT");
  });

  it.each([
    ["after 'docmost' moved, before 'main' merged the record", "refs/heads/main"],
    ["after the record was named, before 'docmost' moved", "refs/heads/docmost"],
  ])(
    "a push record cut off %s is finished by the next cycle: no loss, no duplicate",
    async (_when, ref) => {
      if (!available) return;
      const h = await setup([
        { id: P, title: "Page", text: "pa" },
        { id: BAD, title: "Bad", text: "bad" },
      ]);
      await h.cycle();
      h.failOnce.add(`import:${BAD}`);
      await h.human(async (root) => {
        await h.edit("Bad.md", "bad", "bad GIT")();
        await writeFile(join(root, "New.md"), NEW_MD, "utf8");
      });

      await expect(h.cycle(h.crashingBefore(ref))).rejects.toThrow(/crash before/);
      expect(await git(h.root, "rev-parse", "--verify", RECORD_REF)).toMatch(
        /^[0-9a-f]{40}$/,
      );
      expect(h.calls.filter((c) => c[0] === "create")).toEqual([["create", "New"]]);

      const creates: string[][] = [];
      for (let i = 0; i < 3; i++) {
        await h.cycle();
        creates.push(...h.calls.filter((c) => c[0] === "create"));
      }

      expect(creates).toEqual([]);
      expect((await h.mainFiles()).sort()).toEqual(["Bad.md", "New.md", "Page.md"]);
      expect(h.pages.map((p) => p.title).sort()).toEqual(["Bad", "New", "Page"]);
      expect(h.pages.find((p) => p.id === BAD)?.text).toBe("bad GIT");
      expect(await git(h.root, "show", "main:New.md")).toContain("item two");
      await expect(
        git(h.root, "rev-parse", "--verify", "--quiet", RECORD_REF),
      ).rejects.toThrow();
    },
  );

  it("a delete that failed is retried, not dropped: git's deletion is not reverted", async () => {
    if (!available) return;
    const h = await setup([
      { id: P, title: "Page", text: "alpha" },
      { id: BAD, title: "Bad", text: "bad" },
    ]);
    await h.cycle();
    h.failOnce.add(`delete:${BAD}`);
    await h.human(async (root) => {
      await unlink(join(root, "Bad.md"));
      await h.edit("Page.md", "alpha", "alpha GIT")();
    });

    const deletes: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await h.cycle();
      deletes.push(...h.calls.filter((c) => c[0] === "delete"));
    }

    expect(deletes).toEqual([
      ["delete", BAD],
      ["delete", BAD],
    ]);
    expect(h.pages.map((p) => p.title)).toEqual(["Page"]);
    expect(await h.mainFiles()).toEqual(["Page.md"]);
    expect(h.pages[0].text).toBe("alpha GIT");
  });

  it("a rename that failed is retried at both paths: no copy of the page", async () => {
    if (!available) return;
    const h = await setup([
      { id: P, title: "Page", text: "alpha" },
      { id: BAD, title: "Bad", text: "bad" },
    ]);
    await h.cycle();
    h.failOnce.add(`rename:${BAD}`);
    await h.human(async (root) => {
      await git(root, "mv", "Bad.md", "Renamed.md");
      await h.edit("Page.md", "alpha", "alpha GIT")();
    });

    const ops: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await h.cycle();
      ops.push(...h.calls.filter((c) => c[0] !== "import"));
    }

    expect(ops).toEqual([
      ["rename", BAD],
      ["rename", BAD],
    ]);
    expect(h.pages.map((p) => p.title).sort()).toEqual(["Page", "Renamed"]);
    expect((await h.mainFiles()).sort()).toEqual(["Page.md", "Renamed.md"]);
  });

  it("a renamed page whose body update failed is retried at both paths: no copy of the page", async () => {
    if (!available) return;
    const h = await setup([
      { id: P, title: "Page", text: "alpha" },
      { id: BAD, title: "Bad", text: "bad" },
    ]);
    await h.cycle();
    h.failOnce.add(`import:${BAD}`);
    await h.human(async (root) => {
      await git(root, "mv", "Bad.md", "Renamed.md");
      await h.edit("Renamed.md", "bad", "bad GIT")();
    });

    const creates: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await h.cycle();
      creates.push(...h.calls.filter((c) => c[0] === "create"));
    }

    expect(creates).toEqual([]);
    expect(h.pages.map((p) => [p.title, p.text]).sort()).toEqual([
      ["Page", "alpha"],
      ["Renamed", "bad GIT"],
    ]);
    expect((await h.mainFiles()).sort()).toEqual(["Page.md", "Renamed.md"]);
  });

  it("a push without failures fast-forwards 'docmost' to 'main' as before: no record, no merge", async () => {
    if (!available) return;
    const h = await setup([{ id: P, title: "Page", text: "alpha" }]);
    await h.cycle();
    await h.human(h.edit("Page.md", "alpha", "alpha GIT"));
    const edited = await git(h.root, "rev-parse", "main");

    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.calls).toEqual([["import", P]]);
    expect(await git(h.root, "rev-parse", "main", "docmost", LAST_PUSHED_REF)).toBe(
      [edited, edited, edited].join("\n"),
    );
    await expect(
      git(h.root, "rev-parse", "--verify", "--quiet", RECORD_REF),
    ).rejects.toThrow();
  });

  it(`refuses to create more than ${MAX_GIT_COPY_CREATES} '~git' copy pages in one cycle`, async () => {
    if (!available) return;
    const h = await setup([{ id: P, title: "Page", text: "alpha" }]);
    await h.cycle();
    await h.human(async (root) => {
      for (let i = 1; i <= MAX_GIT_COPY_CREATES + 1; i++) {
        await writeFile(join(root, `Copy ${i} ~git.md`), `copy ${i}\n`, "utf8");
      }
    });

    await expect(h.cycle()).rejects.toThrow(
      new RegExp(
        `create ${MAX_GIT_COPY_CREATES + 1} '~git' copy pages in one cycle ` +
          `\\(limit ${MAX_GIT_COPY_CREATES}\\)`,
      ),
    );
    expect(h.calls.filter((c) => c[0] === "create")).toEqual([]);

    // At the limit the push goes through.
    await h.human((root) => unlink(join(root, "Copy 1 ~git.md")));
    await h.cycle();
    expect(h.calls.filter((c) => c[0] === "create")).toHaveLength(
      MAX_GIT_COPY_CREATES,
    );
  });
});
