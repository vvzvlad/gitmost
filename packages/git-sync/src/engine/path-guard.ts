/**
 * Vault path guard (security, defense-in-depth).
 *
 * A user with push access to a git-sync space could commit a `.md` entry that is
 * a SYMLINK (e.g. `leak.md -> /etc/passwd` or `-> <server>/.env`). On the next
 * cycle a naive `fs.readFile` would follow the link and PUBLISH the target's
 * contents as a Docmost page (a read primitive that escalates a writer to
 * arbitrary server-file disclosure — including the JWT secret / DB creds in
 * `.env`); a symlinked DIRECTORY gives the inverse write-outside-the-vault
 * primitive on pull. The primary defense is `core.symlinks=false` in each
 * vault's git config (git then materializes a pushed symlink as a PLAIN FILE
 * holding the link text, never a real link). This module is the second layer:
 * before every engine read/write/mkdir we reject a path that IS — or traverses —
 * a symlink, or whose real location escapes the vault root.
 *
 * IO-free by construction: the `lstat`/`realpath` primitives are injected
 * (mirroring the rest of the engine) so the rules are unit-testable with fakes
 * and the engine never imports `node:fs`. Path math uses `node:path`, which is
 * pure.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Why a path was refused. */
export type VaultPathUnsafeReason = "symlink" | "escape";

/**
 * Thrown when a path is refused by the guard. Engine read/write loops already
 * isolate per-file errors (skip + log), so throwing here yields the review's
 * required "skip+log" behavior without a separate control channel.
 */
export class VaultPathUnsafeError extends Error {
  constructor(
    readonly absPath: string,
    readonly reason: VaultPathUnsafeReason,
    readonly vaultRoot: string,
  ) {
    super(
      reason === "symlink"
        ? `git-sync: refusing to access '${absPath}' — it is (or traverses) a ` +
            `symlink under vault '${vaultRoot}' (symlink guard)`
        : `git-sync: refusing to access '${absPath}' — it resolves outside ` +
            `vault '${vaultRoot}' (symlink guard)`,
    );
    this.name = "VaultPathUnsafeError";
  }
}

/**
 * The injected IO the guard needs. Both MUST resolve to `null` on ENOENT (the
 * normal case for a not-yet-created file on a write/mkdir) and reject on any
 * other error.
 */
export interface PathGuardIo {
  /** lstat WITHOUT following the final symlink. `null` when the path is absent. */
  lstat: (absPath: string) => Promise<{ isSymbolicLink: boolean } | null>;
  /** realpath (follows symlinks). `null` when the path is absent. */
  realpath: (absPath: string) => Promise<string | null>;
}

/**
 * Lexical containment: is `target` EQUAL to, or NESTED under, `root`? Catches a
 * `..` traversal baked into a relPath before any IO. Both operands are resolved
 * first so `.`/`..` segments are normalized.
 */
export function isWithinRoot(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (t === r) return true;
  const rel = relative(r, t);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Reject `absPath` (resolving silently when it is safe) if it:
 *   - escapes `vaultRoot` lexically (a `..` traversal), OR
 *   - IS, or traverses, a symlink at any EXISTING segment from the root down
 *     (a symlinked ancestor dir, or the target file/dir itself), OR
 *   - resolves (realpath of its deepest existing ancestor) outside the vault.
 *
 * Absent leaf segments — the normal case when writing/mkdir'ing a NEW file — are
 * safe: the walk stops at the first non-existent segment (nothing to follow).
 */
export async function assertVaultPathSafe(
  io: PathGuardIo,
  vaultRoot: string,
  absPath: string,
): Promise<void> {
  const root = resolve(vaultRoot);
  const target = resolve(absPath);

  // 1. Lexical containment — a `..` in a relPath never even reaches an lstat.
  if (!isWithinRoot(root, target)) {
    throw new VaultPathUnsafeError(absPath, "escape", vaultRoot);
  }

  // 2. lstat-walk: reject a symlink at ANY existing level between the root and
  //    the target (inclusive). A symlinked ancestor or a symlinked target both
  //    let a follow-the-link read/write escape; rejecting the link itself is the
  //    surgical guard.
  if (target !== root) {
    const segments = relative(root, target)
      .split(sep)
      .filter((s) => s.length > 0);
    let cur = root;
    for (const segment of segments) {
      cur = resolve(cur, segment);
      const st = await io.lstat(cur);
      if (st === null) break; // absent from here down — nothing left to follow
      if (st.isSymbolicLink) {
        throw new VaultPathUnsafeError(cur, "symlink", vaultRoot);
      }
    }
  }

  // 3. realpath belt-and-suspenders: the deepest EXISTING ancestor must resolve
  //    inside the vault root's realpath. Catches an ancestor relocated via a
  //    symlink the lexical check would miss (e.g. the data dir itself being a
  //    link farm) and bounds the lstat→use TOCTOU window.
  const realRoot = await io.realpath(root);
  if (realRoot === null) return; // root absent — ensureRepo creates it first
  let probe = target;
  let realProbe = await io.realpath(probe);
  while (realProbe === null && probe !== root) {
    const parent = resolve(probe, "..");
    if (parent === probe) break; // reached the filesystem root
    probe = parent;
    realProbe = await io.realpath(probe);
  }
  if (realProbe !== null && !isWithinRoot(realRoot, realProbe)) {
    throw new VaultPathUnsafeError(absPath, "escape", vaultRoot);
  }
}
