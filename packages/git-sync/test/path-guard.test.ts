import { describe, it, expect, vi } from "vitest";
import {
  assertVaultPathSafe,
  isWithinRoot,
  VaultPathUnsafeError,
  type PathGuardIo,
} from "../src/engine/path-guard";

const VAULT = "/srv/git-sync/space-1";

/**
 * Build a fake PathGuardIo from a model of the filesystem:
 *   - `symlinks`: absolute paths that ARE symlinks (lstat -> isSymbolicLink).
 *   - `existing`: absolute paths that EXIST (anything not listed is ENOENT/null).
 *     The vault root is always treated as existing.
 *   - `realpaths`: optional realpath overrides (default: identity for existing).
 */
function fakeIo(model: {
  symlinks?: string[];
  existing?: string[];
  realpaths?: Record<string, string>;
}): PathGuardIo {
  const symlinks = new Set(model.symlinks ?? []);
  const existing = new Set([VAULT, ...(model.existing ?? []), ...symlinks]);
  return {
    lstat: vi.fn(async (p: string) =>
      existing.has(p) ? { isSymbolicLink: symlinks.has(p) } : null,
    ),
    realpath: vi.fn(async (p: string) =>
      existing.has(p) ? (model.realpaths?.[p] ?? p) : null,
    ),
  };
}

describe("isWithinRoot", () => {
  it("accepts the root itself and nested paths", () => {
    expect(isWithinRoot(VAULT, VAULT)).toBe(true);
    expect(isWithinRoot(VAULT, `${VAULT}/a/b.md`)).toBe(true);
  });
  it("rejects siblings, ancestors and `..` traversal", () => {
    expect(isWithinRoot(VAULT, "/srv/git-sync/space-2/x.md")).toBe(false);
    expect(isWithinRoot(VAULT, "/srv/git-sync")).toBe(false);
    expect(isWithinRoot(VAULT, `${VAULT}/../space-2/x.md`)).toBe(false);
    expect(isWithinRoot(VAULT, "/etc/passwd")).toBe(false);
  });
});

describe("assertVaultPathSafe", () => {
  it("allows a normal nested file with no symlinks on its chain", async () => {
    const io = fakeIo({ existing: [`${VAULT}/Folder`, `${VAULT}/Folder/Page.md`] });
    await expect(
      assertVaultPathSafe(io, VAULT, `${VAULT}/Folder/Page.md`),
    ).resolves.toBeUndefined();
  });

  it("allows a NOT-YET-EXISTING leaf (the normal write/mkdir case)", async () => {
    // Folder exists, the .md does not yet — the walk stops at the absent leaf.
    const io = fakeIo({ existing: [`${VAULT}/Folder`] });
    await expect(
      assertVaultPathSafe(io, VAULT, `${VAULT}/Folder/New.md`),
    ).resolves.toBeUndefined();
  });

  it("rejects a TARGET that is itself a symlink (the leak.md -> /etc/passwd attack)", async () => {
    const io = fakeIo({ symlinks: [`${VAULT}/leak.md`] });
    await expect(
      assertVaultPathSafe(io, VAULT, `${VAULT}/leak.md`),
    ).rejects.toBeInstanceOf(VaultPathUnsafeError);
    await expect(
      assertVaultPathSafe(io, VAULT, `${VAULT}/leak.md`),
    ).rejects.toMatchObject({ reason: "symlink" });
  });

  it("rejects a path whose ANCESTOR directory is a symlink (write-outside-vault primitive)", async () => {
    // `escape` is a symlinked dir; writing `escape/x.md` would land outside.
    const io = fakeIo({
      symlinks: [`${VAULT}/escape`],
      existing: [`${VAULT}/escape/x.md`],
    });
    await expect(
      assertVaultPathSafe(io, VAULT, `${VAULT}/escape/x.md`),
    ).rejects.toMatchObject({ reason: "symlink" });
  });

  it("rejects a `..` traversal lexically, before any IO", async () => {
    const io = fakeIo({});
    await expect(
      assertVaultPathSafe(io, VAULT, `${VAULT}/../space-2/steal.md`),
    ).rejects.toMatchObject({ reason: "escape" });
    expect(io.lstat).not.toHaveBeenCalled();
  });

  it("rejects when the deepest existing ancestor's realpath escapes the vault", async () => {
    // No symlink flagged by lstat (e.g. the data dir was relocated under a link
    // the lexical/lstat checks below the root cannot see), but realpath resolves
    // the existing ancestor outside the vault's realpath.
    const io = fakeIo({
      existing: [`${VAULT}/sub`],
      realpaths: { [VAULT]: VAULT, [`${VAULT}/sub`]: "/elsewhere/sub" },
    });
    await expect(
      assertVaultPathSafe(io, VAULT, `${VAULT}/sub/page.md`),
    ).rejects.toMatchObject({ reason: "escape" });
  });

  it("allows the vault root path itself", async () => {
    const io = fakeIo({});
    await expect(assertVaultPathSafe(io, VAULT, VAULT)).resolves.toBeUndefined();
  });
});
