import { describe, expect, it } from 'vitest';
import { classifyRenameMoves } from '../src/engine/push';
import type {
  ClassifyRenameMovesDeps,
  MetaSide,
  RenameMoveAction,
} from '../src/engine/push';
import type { DocmostMdMeta } from '@docmost/prosemirror-markdown';

// FS→Docmost push #3 (SPEC §5/§6/§16). `classifyRenameMoves` is the PURE half of
// the move/rename apply: it resolves each `{pageId, oldPath, newPath}` into the
// Docmost op(s) it needs, with NO IO (both resolvers are injected). The key
// design (SPEC §5) is that the file PATH is the source of truth for tree
// position — the NEW parent comes from the new path, the OLD parent from the old
// path — and the title comes from the meta. An op is emitted ONLY when something
// really changed; a path-only rename (same parent + same title) is a noop and
// NEVER calls Docmost.

/** Build `metaAt` from a `path|side -> meta` table. */
function metaTable(
  table: Record<string, DocmostMdMeta | null>,
): (path: string, side: MetaSide) => DocmostMdMeta | null {
  return (path, side) => {
    const key = `${path}|${side}`;
    return key in table ? table[key] : null;
  };
}

/** Build `resolveParentPageId` from a `path|side -> parentPageId|null` table. */
function parentTable(
  table: Record<string, string | null>,
): (path: string, side: MetaSide) => string | null {
  return (path, side) => {
    const key = `${path}|${side}`;
    return key in table ? table[key] : null;
  };
}

function deps(
  metas: Record<string, DocmostMdMeta | null>,
  parents: Record<string, string | null>,
): ClassifyRenameMovesDeps {
  return {
    metaAt: metaTable(metas),
    resolveParentPageId: parentTable(parents),
  };
}

function meta(partial: Partial<DocmostMdMeta>): DocmostMdMeta {
  return { version: 1, ...partial };
}

describe('classifyRenameMoves — move-only (parent changed, title same)', () => {
  it('emits move (new parent) and NO rename', () => {
    const rms: RenameMoveAction[] = [
      { pageId: 'p1', oldPath: 'Doc.md', newPath: 'Parent/Doc.md' },
    ];
    const out = classifyRenameMoves(
      rms,
      deps(
        {
          // Same title on both sides.
          'Parent/Doc.md|current': meta({ title: 'Doc' }),
          'Doc.md|prev': meta({ title: 'Doc' }),
        },
        {
          // Parent changed: root (null) -> 'parent-id'.
          'Parent/Doc.md|current': 'parent-id',
          'Doc.md|prev': null,
        },
      ),
    );
    expect(out).toEqual([
      {
        pageId: 'p1',
        oldPath: 'Doc.md',
        newPath: 'Parent/Doc.md',
        move: { parentPageId: 'parent-id' },
      },
    ]);
    expect(out[0].rename).toBeUndefined();
    expect(out[0].noop).toBeUndefined();
  });
});

describe('classifyRenameMoves — rename-only (same parent, title changed)', () => {
  it('emits rename (new title) and NO move', () => {
    const rms: RenameMoveAction[] = [
      { pageId: 'p2', oldPath: 'Folder/Old.md', newPath: 'Folder/New.md' },
    ];
    const out = classifyRenameMoves(
      rms,
      deps(
        {
          'Folder/New.md|current': meta({ title: 'New Title' }),
          'Folder/Old.md|prev': meta({ title: 'Old Title' }),
        },
        {
          // Same parent on both sides.
          'Folder/New.md|current': 'folder-id',
          'Folder/Old.md|prev': 'folder-id',
        },
      ),
    );
    expect(out).toEqual([
      {
        pageId: 'p2',
        oldPath: 'Folder/Old.md',
        newPath: 'Folder/New.md',
        rename: { title: 'New Title' },
      },
    ]);
    expect(out[0].move).toBeUndefined();
    expect(out[0].noop).toBeUndefined();
  });
});

describe('classifyRenameMoves — both (parent AND title changed)', () => {
  it('emits BOTH move and rename', () => {
    const rms: RenameMoveAction[] = [
      { pageId: 'p3', oldPath: 'Old.md', newPath: 'NewParent/New.md' },
    ];
    const out = classifyRenameMoves(
      rms,
      deps(
        {
          'NewParent/New.md|current': meta({ title: 'New' }),
          'Old.md|prev': meta({ title: 'Old' }),
        },
        {
          'NewParent/New.md|current': 'np-id',
          'Old.md|prev': null,
        },
      ),
    );
    expect(out).toEqual([
      {
        pageId: 'p3',
        oldPath: 'Old.md',
        newPath: 'NewParent/New.md',
        move: { parentPageId: 'np-id' },
        rename: { title: 'New' },
      },
    ]);
    expect(out[0].noop).toBeUndefined();
  });
});

describe('classifyRenameMoves — noop (path-only rename, same parent + title)', () => {
  it('emits noop and NEITHER move NOR rename (SPEC §5: page is its pageId)', () => {
    const rms: RenameMoveAction[] = [
      { pageId: 'p4', oldPath: 'Folder/A.md', newPath: 'Folder/B.md' },
    ];
    const out = classifyRenameMoves(
      rms,
      deps(
        {
          'Folder/B.md|current': meta({ title: 'Same' }),
          'Folder/A.md|prev': meta({ title: 'Same' }),
        },
        {
          'Folder/B.md|current': 'folder-id',
          'Folder/A.md|prev': 'folder-id',
        },
      ),
    );
    expect(out).toEqual([
      {
        pageId: 'p4',
        oldPath: 'Folder/A.md',
        newPath: 'Folder/B.md',
        noop: true,
      },
    ]);
    expect(out[0].move).toBeUndefined();
    expect(out[0].rename).toBeUndefined();
  });
});

describe('classifyRenameMoves — move-to-root (newParent null)', () => {
  it('emits move with parentPageId null when the file lands at the space root', () => {
    const rms: RenameMoveAction[] = [
      { pageId: 'p5', oldPath: 'Parent/Doc.md', newPath: 'Doc.md' },
    ];
    const out = classifyRenameMoves(
      rms,
      deps(
        {
          'Doc.md|current': meta({ title: 'Doc' }),
          'Parent/Doc.md|prev': meta({ title: 'Doc' }),
        },
        {
          // New parent is ROOT (null), old parent was 'parent-id'.
          'Doc.md|current': null,
          'Parent/Doc.md|prev': 'parent-id',
        },
      ),
    );
    expect(out).toEqual([
      {
        pageId: 'p5',
        oldPath: 'Parent/Doc.md',
        newPath: 'Doc.md',
        move: { parentPageId: null },
      },
    ]);
    expect(out[0].rename).toBeUndefined();
    expect(out[0].noop).toBeUndefined();
  });
});

describe('classifyRenameMoves — title guards', () => {
  it('an EMPTY new title is NOT a rename (even if it differs from old)', () => {
    const rms: RenameMoveAction[] = [
      { pageId: 'p6', oldPath: 'Folder/A.md', newPath: 'Folder/B.md' },
    ];
    const out = classifyRenameMoves(
      rms,
      deps(
        {
          // New title is empty -> never a rename; same parent -> overall noop.
          'Folder/B.md|current': meta({ title: '' }),
          'Folder/A.md|prev': meta({ title: 'Had A Title' }),
        },
        {
          'Folder/B.md|current': 'folder-id',
          'Folder/A.md|prev': 'folder-id',
        },
      ),
    );
    expect(out[0].rename).toBeUndefined();
    expect(out[0].move).toBeUndefined();
    expect(out[0].noop).toBe(true);
  });

  it('a missing new meta is NOT a rename; a parent change still yields a move', () => {
    const rms: RenameMoveAction[] = [
      { pageId: 'p7', oldPath: 'Doc.md', newPath: 'Parent/Doc.md' },
    ];
    const out = classifyRenameMoves(
      rms,
      deps(
        {
          // No current meta entry at all (resolver returns null).
          'Doc.md|prev': meta({ title: 'Doc' }),
        },
        {
          'Parent/Doc.md|current': 'parent-id',
          'Doc.md|prev': null,
        },
      ),
    );
    expect(out[0].move).toEqual({ parentPageId: 'parent-id' });
    expect(out[0].rename).toBeUndefined();
    expect(out[0].noop).toBeUndefined();
  });
});

describe('classifyRenameMoves — empty input', () => {
  it('returns an empty array for no rename/move entries', () => {
    expect(classifyRenameMoves([], deps({}, {}))).toEqual([]);
  });
});
