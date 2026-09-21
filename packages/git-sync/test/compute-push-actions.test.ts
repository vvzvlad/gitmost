import { describe, expect, it } from 'vitest';
import { computePushActions } from '../src/engine/push';
import type { DiffEntry, MetaSide } from '../src/engine/push';
import type { DocmostMdMeta } from '@docmost/prosemirror-markdown';

// FS→Docmost push, FIRST increment (SPEC §6). `computePushActions` is the PURE
// half: it classifies each `git diff --name-status` row into a Docmost action by
// `pageId` identity (SPEC §4/§8), with NO IO — the `metaAt` resolver is injected.
// These tests cover every classification incl. edges.

/** Build a `metaAt` resolver from a `path|side -> meta` table. */
function metaTable(
  table: Record<string, DocmostMdMeta | null>,
): (path: string, side: MetaSide) => DocmostMdMeta | null {
  return (path, side) => {
    const key = `${path}|${side}`;
    return key in table ? table[key] : null;
  };
}

function meta(partial: Partial<DocmostMdMeta>): DocmostMdMeta {
  return { version: 1, ...partial };
}

describe('computePushActions — A (added)', () => {
  it('added file with NO pageId -> create', () => {
    const changes: DiffEntry[] = [{ status: 'A', path: 'New.md' }];
    const metaAt = metaTable({
      'New.md|current': meta({ title: 'New', spaceId: 'sp1' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.creates).toEqual([{ path: 'New.md' }]);
    expect(actions.updates).toEqual([]);
    expect(actions.deletes).toEqual([]);
    expect(actions.renamesMoves).toEqual([]);
    expect(actions.skipped).toEqual([]);
  });

  it('added file with NO meta at all -> skipped (a create needs a spaceId)', () => {
    // No meta -> no spaceId -> cannot create (Docmost create_page requires it).
    const changes: DiffEntry[] = [{ status: 'A', path: 'Plain.md' }];
    const actions = computePushActions({ changes, metaAt: metaTable({}) });
    expect(actions.creates).toEqual([]);
    expect(actions.skipped).toEqual([
      { path: 'Plain.md', status: 'A', reason: 'create-without-spaceId' },
    ]);
  });

  it('added file with meta but NO spaceId -> skipped (create-without-spaceId)', () => {
    // Partial human meta (title only, no spaceId) -> refuse to create.
    const changes: DiffEntry[] = [{ status: 'A', path: 'Partial.md' }];
    const metaAt = metaTable({
      'Partial.md|current': meta({ title: 'Partial' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.creates).toEqual([]);
    expect(actions.skipped).toEqual([
      { path: 'Partial.md', status: 'A', reason: 'create-without-spaceId' },
    ]);
  });

  it('added file with an EMPTY-string spaceId -> skipped (create-without-spaceId)', () => {
    // An empty spaceId is not a usable target either.
    const changes: DiffEntry[] = [{ status: 'A', path: 'Empty.md' }];
    const metaAt = metaTable({
      'Empty.md|current': meta({ title: 'E', spaceId: '' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.creates).toEqual([]);
    expect(actions.skipped).toEqual([
      { path: 'Empty.md', status: 'A', reason: 'create-without-spaceId' },
    ]);
  });

  it('added file WITH a pageId (restored/copied) -> update (page exists)', () => {
    const changes: DiffEntry[] = [{ status: 'A', path: 'Restored.md' }];
    const metaAt = metaTable({
      'Restored.md|current': meta({ pageId: 'p-restored', title: 'R' }),
    });
    const actions = computePushActions({ changes, metaAt });
    // The page already exists -> push content as an UPDATE, never a duplicate.
    expect(actions.updates).toEqual([
      { pageId: 'p-restored', path: 'Restored.md' },
    ]);
    expect(actions.creates).toEqual([]);
  });
});

describe('computePushActions — M (modified)', () => {
  it('modified file with a pageId -> update content', () => {
    const changes: DiffEntry[] = [{ status: 'M', path: 'Doc.md' }];
    const metaAt = metaTable({
      'Doc.md|current': meta({ pageId: 'p-doc' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.updates).toEqual([{ pageId: 'p-doc', path: 'Doc.md' }]);
    expect(actions.skipped).toEqual([]);
  });

  it('modified file with NO pageId in current OR pre-image -> skipped', () => {
    const changes: DiffEntry[] = [{ status: 'M', path: 'Untracked.md' }];
    const actions = computePushActions({ changes, metaAt: metaTable({}) });
    expect(actions.updates).toEqual([]);
    expect(actions.skipped).toEqual([
      {
        path: 'Untracked.md',
        status: 'M',
        reason: 'modified file has no pageId in meta (nor in pre-image)',
      },
    ]);
  });

  it('modified file that DROPPED its pageId recovers it from the pre-image -> update (bug C10-D1)', () => {
    // The current file lost its `gitmost_id` frontmatter (a tool rewrote the whole
    // file), but the last-pushed version at this path still had it. Recover the id
    // and apply the body edit instead of silently skipping+reverting it.
    const changes: DiffEntry[] = [{ status: 'M', path: 'Doc.md' }];
    const metaAt = metaTable({
      // current side has no pageId; prev (pre-image) side does.
      'Doc.md|prev': meta({ pageId: 'p-doc' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.updates).toEqual([{ pageId: 'p-doc', path: 'Doc.md' }]);
    expect(actions.skipped).toEqual([]);
  });
});

describe('computePushActions — D (deleted)', () => {
  it('deleted file recovers pageId from the PRE-IMAGE meta -> delete', () => {
    const changes: DiffEntry[] = [{ status: 'D', path: 'Gone.md' }];
    // The file is gone from `current`; its pageId lives in the `prev` pre-image.
    const metaAt = metaTable({
      'Gone.md|prev': meta({ pageId: 'p-gone' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([{ pageId: 'p-gone' }]);
    expect(actions.skipped).toEqual([]);
  });

  it('deleted file with NO recoverable pageId -> skipped (untracked guard §8)', () => {
    const changes: DiffEntry[] = [{ status: 'D', path: 'Stray.md' }];
    // No pre-image pageId -> the untracked-file guard skips it (never deletes a
    // page that was never tracked, SPEC §8).
    const actions = computePushActions({ changes, metaAt: metaTable({}) });
    expect(actions.deletes).toEqual([]);
    expect(actions.skipped).toEqual([
      {
        path: 'Stray.md',
        status: 'D',
        reason: 'deleted file has no recoverable pageId (pre-image meta)',
      },
    ]);
  });

  it('uses the PREV side, not current, to recover the deleted pageId', () => {
    const changes: DiffEntry[] = [{ status: 'D', path: 'Gone.md' }];
    // A stale `current` meta must NOT be used; only the pre-image counts.
    const metaAt = metaTable({
      'Gone.md|current': meta({ pageId: 'WRONG' }),
      'Gone.md|prev': meta({ pageId: 'p-correct' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([{ pageId: 'p-correct' }]);
  });
});

describe('computePushActions — R/C (renamed/moved)', () => {
  it('renamed file -> renamesMoves (record only; resolution deferred)', () => {
    const changes: DiffEntry[] = [
      { status: 'R', path: 'New/Path.md', oldPath: 'Old/Path.md', score: 100 },
    ];
    const metaAt = metaTable({
      'New/Path.md|current': meta({ pageId: 'p-moved' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p-moved', oldPath: 'Old/Path.md', newPath: 'New/Path.md' },
    ]);
    // It is ALSO recorded as an UPDATE for the new path (F4) so a body edit
    // riding along the rename in the same diff is pushed, not lost. The update
    // carries `basePath = oldPath` so the 3-way merge base is resolved from where
    // the file lived at last-pushed (the OLD path), not the new path (which would
    // return null and degrade to a 2-way clobber). Never a create/delete though.
    expect(actions.creates).toEqual([]);
    expect(actions.updates).toEqual([
      { pageId: 'p-moved', path: 'New/Path.md', basePath: 'Old/Path.md' },
    ]);
    expect(actions.deletes).toEqual([]);
  });

  it('rename + body edit in one diff -> emits BOTH a rename/move action AND a body update (F4)', () => {
    // git `-M` reports a rename WITH a body edit as a single `R` row. The
    // move/rename ops never carry page content, so the body edit must ALSO be
    // emitted as an UPDATE targeting the NEW path + same pageId — otherwise it is
    // silently and permanently lost (F4, the critical data-loss bug).
    const changes: DiffEntry[] = [
      { status: 'R', path: 'New/Path.md', oldPath: 'Old/Path.md', score: 75 },
    ];
    const metaAt = metaTable({
      'New/Path.md|current': meta({ pageId: 'p-edited' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p-edited', oldPath: 'Old/Path.md', newPath: 'New/Path.md' },
    ]);
    // The body update carries the NEW path so importPageMarkdown reads the moved
    // file and targets the moved page by its (stable) pageId; `basePath` is the OLD
    // path so the merge base is the pre-rename file (honest 3-way merge).
    expect(actions.updates).toEqual([
      { pageId: 'p-edited', path: 'New/Path.md', basePath: 'Old/Path.md' },
    ]);
    expect(actions.creates).toEqual([]);
    expect(actions.deletes).toEqual([]);
    expect(actions.skipped).toEqual([]);
  });

  it('copy (C) is recorded like a rename for the deferred apply', () => {
    const changes: DiffEntry[] = [
      { status: 'C', path: 'Copy.md', oldPath: 'Src.md', score: 90 },
    ];
    const metaAt = metaTable({
      'Copy.md|current': meta({ pageId: 'p-copy' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p-copy', oldPath: 'Src.md', newPath: 'Copy.md' },
    ]);
    // The body also rides along as an UPDATE for the new path (F4). For a COPY the
    // `basePath` is the SOURCE path (`Src.md`): the source still exists in the
    // last-pushed tree, so the copy's body 3-way-merges against its source's
    // last-synced text — a real common ancestor, not a null 2-way base.
    expect(actions.updates).toEqual([
      { pageId: 'p-copy', path: 'Copy.md', basePath: 'Src.md' },
    ]);
  });

  it('renamed file with NO pageId -> skipped', () => {
    const changes: DiffEntry[] = [
      { status: 'R', path: 'New.md', oldPath: 'Old.md', score: 100 },
    ];
    const actions = computePushActions({ changes, metaAt: metaTable({}) });
    expect(actions.renamesMoves).toEqual([]);
    expect(actions.skipped).toEqual([
      { path: 'New.md', status: 'R', reason: 'renamed/moved file has no pageId in meta' },
    ]);
  });
});

describe('computePushActions — mixed batch', () => {
  it('classifies a realistic mixed diff in one pass', () => {
    const changes: DiffEntry[] = [
      { status: 'A', path: 'Fresh.md' }, // create
      { status: 'A', path: 'Restored.md' }, // update (has pageId)
      { status: 'M', path: 'Edited.md' }, // update
      { status: 'D', path: 'Removed.md' }, // delete
      { status: 'R', path: 'Dst.md', oldPath: 'Srcc.md', score: 100 }, // move
    ];
    const metaAt = metaTable({
      'Fresh.md|current': meta({ title: 'Fresh', spaceId: 'sp' }),
      'Restored.md|current': meta({ pageId: 'p-rest' }),
      'Edited.md|current': meta({ pageId: 'p-edit' }),
      'Removed.md|prev': meta({ pageId: 'p-rm' }),
      'Dst.md|current': meta({ pageId: 'p-mv' }),
    });
    const actions = computePushActions({ changes, metaAt });

    expect(actions.creates).toEqual([{ path: 'Fresh.md' }]);
    // The R row contributes BOTH a rename/move AND a body update for the new path
    // (F4), so `p-mv` appears in updates too — in diff-row order, last.
    expect(actions.updates).toEqual([
      { pageId: 'p-rest', path: 'Restored.md' },
      { pageId: 'p-edit', path: 'Edited.md' },
      // The rename-derived body update carries basePath = the OLD path (`Srcc.md`)
      // for an honest 3-way merge; the plain A/M updates carry no basePath.
      { pageId: 'p-mv', path: 'Dst.md', basePath: 'Srcc.md' },
    ]);
    expect(actions.deletes).toEqual([{ pageId: 'p-rm' }]);
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p-mv', oldPath: 'Srcc.md', newPath: 'Dst.md' },
    ]);
    expect(actions.skipped).toEqual([]);
  });
});

describe('computePushActions — ghost-move coalescing (data-loss guard)', () => {
  // git's `-M` rename detection misses a move when the files are too dissimilar
  // (tiny meta-only files after a layout reshuffle of `_`-fallback names). git
  // then reports the move as a DELETE of the old path + an ADD of the new one.
  // Taken literally this soft-deletes a page that merely MOVED. The classifier
  // must recognize the shared pageId and emit a rename/move, never a delete.
  it('D(old)+A(new) of the SAME pageId -> rename/move, NOT a delete', () => {
    const changes: DiffEntry[] = [
      { status: 'D', path: '_ ~slug.md' },
      { status: 'A', path: '_.md' },
    ];
    const metaAt = metaTable({
      '_ ~slug.md|prev': meta({ pageId: 'p1', title: '', spaceId: 'sp1' }),
      '_.md|current': meta({ pageId: 'p1', title: '', spaceId: 'sp1' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([]); // the page is NEVER trashed
    // The coalesced move ALSO carries a body update for the new path (F4): a body
    // edit accompanying the relocation must be pushed, not lost. `basePath` is the
    // OLD (deleted) path so the 3-way merge base is the pre-move file, not null.
    expect(actions.updates).toEqual([
      { pageId: 'p1', path: '_.md', basePath: '_ ~slug.md' },
    ]);
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p1', oldPath: '_ ~slug.md', newPath: '_.md' },
    ]);
    // The suppressed delete is recorded as a skip with a clear reason.
    expect(actions.skipped).toEqual([
      {
        path: '_ ~slug.md',
        status: 'D',
        reason: 'ghost-move (re-added at a new path) — not a deletion',
      },
    ]);
  });

  it('D(old)+M(new) of the SAME pageId -> rename/move, NOT a delete (M-side reshuffle)', () => {
    // A reshuffle: an ALREADY-existing path (`New.md`) takes on a new pageId while
    // the old path (`Old.md`) is deleted — git reports the surviving side as `M`
    // (the path was occupied), not `A`. Same pageId on both sides, so it is one
    // page that relocated: the M-side ghost-move coalescing path.
    const changes: DiffEntry[] = [
      { status: 'D', path: 'Old.md' },
      { status: 'M', path: 'New.md' },
    ];
    const metaAt = metaTable({
      'Old.md|prev': meta({ pageId: 'p1', title: 'Old', spaceId: 'sp1' }),
      'New.md|current': meta({ pageId: 'p1', title: 'New', spaceId: 'sp1' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([]); // the page is NEVER trashed
    // The coalesced move ALSO carries a body update for the new path (F4); the
    // merge base resolves from the OLD path, not null and not the new path.
    expect(actions.updates).toEqual([
      { pageId: 'p1', path: 'New.md', basePath: 'Old.md' },
    ]);
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p1', oldPath: 'Old.md', newPath: 'New.md' },
    ]);
  });

  it('a real delete (no matching add) is STILL a delete', () => {
    const changes: DiffEntry[] = [{ status: 'D', path: 'Gone.md' }];
    const metaAt = metaTable({
      'Gone.md|prev': meta({ pageId: 'p9', title: 'Gone', spaceId: 'sp1' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([{ pageId: 'p9' }]);
    expect(actions.renamesMoves).toEqual([]);
  });

  it('an unrelated D + A (different pageIds) are a real delete + a real update', () => {
    const changes: DiffEntry[] = [
      { status: 'D', path: 'A.md' },
      { status: 'A', path: 'B.md' },
    ];
    const metaAt = metaTable({
      'A.md|prev': meta({ pageId: 'pa', title: 'A', spaceId: 'sp1' }),
      'B.md|current': meta({ pageId: 'pb', title: 'B', spaceId: 'sp1' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([{ pageId: 'pa' }]);
    expect(actions.updates).toEqual([{ pageId: 'pb', path: 'B.md' }]);
    expect(actions.renamesMoves).toEqual([]);
  });
});

describe('computePushActions — currentPageIds guard (cross-cycle move)', () => {
  it('a D whose pageId still exists in the tree (no matching A in THIS diff) is NOT deleted', () => {
    // The move happened across cycles: the new file landed earlier, so this diff
    // only has the old path D. The pageId still lives in the tree -> not a delete.
    const changes: DiffEntry[] = [{ status: 'D', path: '_ ~old.md' }];
    const metaAt = metaTable({
      '_ ~old.md|prev': meta({ pageId: 'pX', title: '', spaceId: 'sp1' }),
    });
    const actions = computePushActions({
      changes,
      metaAt,
      currentPageIds: new Set(['pX']), // pX is still tracked somewhere on main
    });
    expect(actions.deletes).toEqual([]);
    expect(actions.skipped).toEqual([
      {
        path: '_ ~old.md',
        status: 'D',
        reason: 'pageId still present in the tree (moved) — not a deletion',
      },
    ]);
  });

  it('a D whose pageId is GONE from the tree is a real delete', () => {
    const changes: DiffEntry[] = [{ status: 'D', path: 'Removed.md' }];
    const metaAt = metaTable({
      'Removed.md|prev': meta({ pageId: 'pY', title: 'Removed', spaceId: 'sp1' }),
    });
    const actions = computePushActions({
      changes,
      metaAt,
      currentPageIds: new Set(['pOther']), // pY is NOT present -> genuinely deleted
    });
    expect(actions.deletes).toEqual([{ pageId: 'pY' }]);
    expect(actions.skipped).toEqual([]);
  });
});

describe('computePushActions — page-file filter (non-page files ignored)', () => {
  it('IGNORES added/modified/deleted non-page files (.obsidian, dotfiles, non-.md)', () => {
    // A vault commits `.obsidian/*`, attachments, dotfiles (no .gitignore), so
    // they show up in the diff — but they are NEVER Docmost pages. Even though a
    // synthetic metaAt would hand back a spaceId (the vault's), none of these may
    // become a CREATE/UPDATE/DELETE. This pins the data-corruption guard: an
    // added `.obsidian/workspace.json` must NOT create a page nor get a gitmost_id.
    const changes: DiffEntry[] = [
      { status: 'A', path: '.obsidian/workspace.json' },
      { status: 'M', path: '.obsidian/app.json' },
      { status: 'A', path: 'attachments/diagram.png' },
      { status: 'A', path: '.hidden.md' }, // dotfile, even with .md
      { status: 'A', path: 'Notes/.config/x.md' }, // dot-segment mid-path
      { status: 'D', path: '.obsidian/old.json' },
    ];
    // Every path resolves to a spaceId-bearing meta (the vault's space) — proving
    // the filter, not a missing spaceId, is what screens them out.
    const metaAt = (path: string): DocmostMdMeta =>
      ({ version: 1, title: 'x', spaceId: 'sp-vault' }) as DocmostMdMeta;
    const actions = computePushActions({ changes, metaAt });
    expect(actions.creates).toEqual([]);
    expect(actions.updates).toEqual([]);
    expect(actions.deletes).toEqual([]);
    expect(actions.renamesMoves).toEqual([]);
    expect(actions.skipped).toEqual([]); // not even recorded as skipped — ignored
  });

  it('still processes a normal .md page alongside ignored non-page files', () => {
    const changes: DiffEntry[] = [
      { status: 'A', path: '.obsidian/workspace.json' },
      { status: 'A', path: 'Real Page.md' },
      { status: 'A', path: 'Folder/Note.md' },
    ];
    const metaAt = (path: string): DocmostMdMeta =>
      ({ version: 1, title: 'x', spaceId: 'sp-vault' }) as DocmostMdMeta;
    const actions = computePushActions({ changes, metaAt });
    // Only the two real .md pages become creates; the .obsidian file is ignored.
    expect(actions.creates).toEqual([
      { path: 'Real Page.md' },
      { path: 'Folder/Note.md' },
    ]);
  });
});
