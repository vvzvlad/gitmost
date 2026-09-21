import { describe, expect, it } from 'vitest';
import { readExisting } from '../src/engine/pull';
import { serializePageFile } from '@docmost/prosemirror-markdown';

// R-Pull-1 (test-strategy report §5): `readExisting` now takes injectable IO
// (`listTracked` / `readFile`), so its parsing + skip rules are unit-testable
// without a real git repo or filesystem. These tests pass fakes only — no git,
// no fs, no network. Identity is recovered from the native `gitmost_id`
// frontmatter (no more `docmost:meta`).

/** Build a valid native page file with a `gitmost_id` frontmatter. */
function withId(id: string, body = '# Title\nbody\n'): string {
  return serializePageFile(id, body);
}

/** A fake `readFile` backed by an in-memory map (rejects on a missing key). */
function fakeReadFile(files: Record<string, string>) {
  return async (rel: string): Promise<string> => {
    if (!(rel in files)) {
      throw Object.assign(new Error(`ENOENT: ${rel}`), { code: 'ENOENT' });
    }
    return files[rel];
  };
}

describe('readExisting (R-Pull-1, injected IO)', () => {
  it('recovers { pageId, relPath } for valid tracked files', async () => {
    const files = {
      'Space/A.md': withId('p1'),
      'Space/Sub/B.md': withId('p2'),
    };
    const result = await readExisting({
      listTracked: async () => Object.keys(files),
      readFile: fakeReadFile(files),
    });
    expect(result).toEqual([
      { pageId: 'p1', relPath: 'Space/A.md' },
      { pageId: 'p2', relPath: 'Space/Sub/B.md' },
    ]);
  });

  it('SKIPS a file with no frontmatter (plain hand-written markdown)', async () => {
    const files = {
      'tracked.md': withId('p1'),
      'stray.md': '# Just a hand-written note\n\nNo frontmatter here.\n',
    };
    const result = await readExisting({
      listTracked: async () => Object.keys(files),
      readFile: fakeReadFile(files),
    });
    // Only the engine-tracked file (with a gitmost_id) survives.
    expect(result).toEqual([{ pageId: 'p1', relPath: 'tracked.md' }]);
  });

  it('SKIPS a file whose frontmatter has no gitmost_id key', async () => {
    const files = {
      'has-id.md': withId('keep'),
      // A user's own frontmatter, but no gitmost_id -> not engine-tracked.
      'no-id.md': '---\ntags: [note]\ntitle: untitled\n---\n\nbody\n',
    };
    const result = await readExisting({
      listTracked: async () => Object.keys(files),
      readFile: fakeReadFile(files),
    });
    expect(result).toEqual([{ pageId: 'keep', relPath: 'has-id.md' }]);
  });

  it('SKIPS a file with an EMPTY gitmost_id value, does not throw', async () => {
    const files = {
      'good.md': withId('good'),
      'blank.md': '---\ngitmost_id:\n---\n\nbody\n',
    };
    const result = await readExisting({
      listTracked: async () => Object.keys(files),
      readFile: fakeReadFile(files),
    });
    expect(result).toEqual([{ pageId: 'good', relPath: 'good.md' }]);
  });

  it('does NOT throw when readFile REJECTS (tracked but missing) — treats it as skipped', async () => {
    const files = {
      'present.md': withId('present'),
      // "ghost.md" is listed as tracked but absent from the file map -> reject.
    };
    const result = await readExisting({
      listTracked: async () => ['present.md', 'ghost.md'],
      readFile: fakeReadFile(files),
    });
    // The rejection is swallowed; the present file still comes through.
    expect(result).toEqual([{ pageId: 'present', relPath: 'present.md' }]);
  });

  it('returns an empty list when nothing is tracked', async () => {
    const result = await readExisting({
      listTracked: async () => [],
      readFile: async () => {
        throw new Error('should not be called');
      },
    });
    expect(result).toEqual([]);
  });

  it('combines all skip rules in one listing (only the valid files survive)', async () => {
    const files = {
      'ok1.md': withId('a'),
      'no-meta.md': 'plain\n',
      'no-id.md': '---\ntags: [x]\n---\n\nbody\n',
      'blank.md': '---\ngitmost_id:\n---\n\nbody\n',
      'ok2.md': withId('b'),
      // missing.md rejects on read.
    };
    const result = await readExisting({
      listTracked: async () => [...Object.keys(files), 'missing.md'],
      readFile: fakeReadFile(files),
    });
    expect(result).toEqual([
      { pageId: 'a', relPath: 'ok1.md' },
      { pageId: 'b', relPath: 'ok2.md' },
    ]);
  });
});
