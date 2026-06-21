import * as path from 'path';
import { isEntryPathSafe } from './file.utils';

/**
 * Unit tests for isEntryPathSafe: the pure zip-slip / path-traversal guard
 * extracted from extractZipInternal. The contract reproduced from the
 * production inline check is, in order:
 *   1. strip leading slashes from the entry name;
 *   2. reject names that fail yauzl.validateFileName (relative `..` segments,
 *      backslashes, drive letters, etc.);
 *   3. reject `__MACOSX/` metadata entries;
 *   4. resolve the (stripped) entry under the target dir and require it to stay
 *      strictly inside the target via a `targetResolved + path.sep` prefix check.
 *
 * The separator in step 4 is the load-bearing detail: it prevents sibling-dir
 * prefix confusion (e.g. target `/tmp/x` vs `/tmp/x-evil`). The tests below are
 * written so that weakening that check to a bare `startsWith(targetResolved)`
 * makes at least one test fail.
 */
describe('isEntryPathSafe', () => {
  // Use an absolute target; on the test platform path.sep is '/'.
  const target = path.resolve('/tmp/x');

  it('accepts a normal nested entry and resolves it inside the target', () => {
    const result = isEntryPathSafe('a/b/c.png', target);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe(path.join(target, 'a/b/c.png'));
    // Resolved path must live strictly under the target directory.
    expect(result.resolved!.startsWith(target + path.sep)).toBe(true);
  });

  it('strips a single leading slash and then treats the entry as safe', () => {
    const result = isEntryPathSafe('/a/b/c.png', target);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe(path.join(target, 'a/b/c.png'));
  });

  it('strips multiple leading slashes and then treats the entry as safe', () => {
    const result = isEntryPathSafe('///a/b.png', target);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe(path.join(target, 'a/b.png'));
  });

  it('skips (marks unsafe) __MACOSX metadata entries', () => {
    const result = isEntryPathSafe('__MACOSX/foo', target);
    expect(result.safe).toBe(false);
    expect(result.resolved).toBeUndefined();
  });

  it('rejects a relative ../../ traversal entry', () => {
    // yauzl.validateFileName flags this as an "invalid relative path", so it is
    // rejected before the containment check ever runs. Either way: unsafe.
    const result = isEntryPathSafe('../../etc/passwd', target);
    expect(result.safe).toBe(false);
    expect(result.resolved).toBeUndefined();
  });

  it('rejects an entry whose resolved path would land in a sibling directory (prefix confusion)', () => {
    // The classic off-by-one: target `/tmp/x` must NOT contain `/tmp/x-evil`.
    // Such an escape can only be expressed with a `..` segment, which the guard
    // rejects. This asserts the guard holds for the sibling-escape attempt.
    const result = isEntryPathSafe('../x-evil/p', target);
    expect(result.safe).toBe(false);
    expect(result.resolved).toBeUndefined();
  });

  it('rejects an entry that resolves to exactly the target dir (no trailing separator)', () => {
    // `.` resolves to the target itself. The strict `targetResolved + path.sep`
    // prefix check rejects it; a weakened `startsWith(targetResolved)` (without
    // the separator) would WRONGLY accept it. This test is the mutation killer
    // for the separator: if the separator is dropped, this assertion fails.
    const result = isEntryPathSafe('.', target);
    expect(result.safe).toBe(false);
    expect(result.resolved).toBeUndefined();
  });

  it('keeps the target/sibling boundary: a bare-prefix sibling is not inside the target', () => {
    // Direct statement of the invariant the separator protects. The resolved
    // sibling path shares the target's basename as a prefix but is a different
    // directory; only the `+ path.sep` form correctly classifies it as outside.
    const target2 = path.resolve('/tmp/x');
    const siblingResolved = path.resolve(path.join(target2, '..', 'x-evil', 'p'));
    expect(siblingResolved.startsWith(target2)).toBe(true); // weak (buggy) check matches
    expect(siblingResolved.startsWith(target2 + path.sep)).toBe(false); // strict check rejects
  });

  it('rejects an entry containing a backslash via yauzl.validateFileName', () => {
    // Backslashes are flagged by yauzl.validateFileName as invalid characters,
    // so such entries are unsafe regardless of where they would resolve.
    const result = isEntryPathSafe('a\\b.png', target);
    expect(result.safe).toBe(false);
    expect(result.resolved).toBeUndefined();
  });

  it('accepts a stripped absolute path that lands inside the target', () => {
    // Documented ACTUAL behaviour: an entry like `/etc/passwd` has its leading
    // slash stripped to `etc/passwd`, which resolves to <target>/etc/passwd —
    // strictly inside the target, hence safe. (This is the point of the strip:
    // an absolute-looking entry is re-anchored under the target rather than
    // escaping to the filesystem root.)
    const result = isEntryPathSafe('/etc/passwd', target);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe(path.join(target, 'etc/passwd'));
  });
});
