import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VaultGit } from "../src/engine/git";
import { execFileAsync, git, gitAvailable } from "./cycle-realgit-helpers";

// A push whose ref advertisement predates a cycle's commit on `main` must be
// refused before receive-pack (updateInstead) checks it out into the working
// tree; otherwise the tree holds the rejected push and the next cycle commits
// it over the cycle's work. Driven against a REAL receive-pack.

// A receive-pack whose repo gets a commit on `main` right after the ref
// advertisement went out (the first byte the client sends back), as when a
// cycle commits between a push's GET info/refs and its POST.
const RACING_RECEIVE_PACK = `#!/bin/sh
repo="$1"
fifo="$repo/../rp.fifo"
mkfifo "$fifo"
git receive-pack "$repo" < "$fifo" &
exec 3> "$fifo"
dd bs=1 count=1 of="$repo/../rp.first" 2>/dev/null
(cd "$repo" && echo "docmost edit" > B.md && git add B.md &&
  git -c user.name=t -c user.email=t@t commit -q -m "cycle export")
cat "$repo/../rp.first" >&3
cat >&3
exec 3>&-
wait
`;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("PUSH_GUARD_HOOK — a push racing a cycle", () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A servable vault (as the server configures it) and a clone with one new commit. */
  async function setup() {
    dir = await mkdtemp(join(tmpdir(), "docmost-push-guard-"));
    const srv = join(dir, "srv");
    const cli = join(dir, "cli");
    const vault = new VaultGit(srv);
    await vault.ensureRepo();
    await git(srv, "config", "receive.denyCurrentBranch", "updateInstead");
    await vault.installPushGuard();
    await git(dir, "clone", "-q", srv, cli);
    await writeFile(join(cli, "C.md"), "pushed\n", "utf8");
    await git(cli, "add", "C.md");
    await git(cli, "commit", "-q", "-m", "user push");
    return { root: dir, srv, cli };
  }

  it("refuses the push: the working tree and the cycle's commit stay as they were", async () => {
    if (!available) return;
    const { root, srv, cli } = await setup();
    const wrapper = join(root, "rp.sh");
    await writeFile(wrapper, RACING_RECEIVE_PACK, { mode: 0o755 });

    const push = execFileAsync(
      "git",
      ["push", `--receive-pack=${wrapper}`, "origin", "main"],
      { cwd: cli },
    );

    await expect(push).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "'main' changed on the server since your last fetch",
      ),
    });
    expect(await git(srv, "status", "--porcelain")).toBe("");
    expect(await git(srv, "log", "-1", "--format=%s", "main")).toBe(
      "cycle export",
    );
    expect(await exists(join(srv, "B.md"))).toBe(true);
    expect(await exists(join(srv, "C.md"))).toBe(false);
  });

  it("refuses a push to the engine's own refs: they do not move", async () => {
    if (!available) return;
    const { srv, cli } = await setup();
    const before = await git(srv, "for-each-ref", "refs/heads/docmost", "refs/docmost");

    for (const ref of ["refs/heads/docmost", "refs/docmost/recording"]) {
      await expect(
        execFileAsync("git", ["push", "origin", `HEAD:${ref}`], { cwd: cli }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          `'${ref}' is managed by git-sync and cannot be pushed.`,
        ),
      });
    }

    expect(
      await git(srv, "for-each-ref", "refs/heads/docmost", "refs/docmost"),
    ).toBe(before);
  });

  it("lets a push from an up-to-date clone through", async () => {
    if (!available) return;
    const { srv, cli } = await setup();

    await git(cli, "push", "-q", "origin", "main");

    expect(await git(srv, "rev-parse", "main")).toBe(
      await git(cli, "rev-parse", "HEAD"),
    );
    expect(await git(srv, "status", "--porcelain")).toBe("");
    expect(await exists(join(srv, "C.md"))).toBe(true);
  });
});
