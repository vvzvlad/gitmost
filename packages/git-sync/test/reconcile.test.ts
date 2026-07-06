import { describe, expect, it } from 'vitest';
import {
  planReconciliation,
  decideAbsenceDeletions,
  type ExistingEntry,
  type LiveEntry,
} from '../src/engine/reconcile.js';

describe('planReconciliation', () => {
  it('ADD: a new live page (not tracked) is written, nothing deleted', () => {
    const live: LiveEntry[] = [{ pageId: 'p1', relPath: 'Space/New.md' }];
    const existing: ExistingEntry[] = [];
    const plan = planReconciliation(live, existing);
    expect(plan.toWrite).toEqual([{ pageId: 'p1', relPath: 'Space/New.md' }]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.moved).toEqual([]);
  });

  it('CONTENT-UPDATE: tracked page at the SAME path is rewritten, not moved/deleted', () => {
    const live: LiveEntry[] = [{ pageId: 'p1', relPath: 'Space/Doc.md' }];
    const existing: ExistingEntry[] = [{ pageId: 'p1', relPath: 'Space/Doc.md' }];
    const plan = planReconciliation(live, existing);
    // Still written (re-emitted; identical bytes => git no-op), no move/delete.
    expect(plan.toWrite).toEqual([{ pageId: 'p1', relPath: 'Space/Doc.md' }]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.moved).toEqual([]);
  });

  it('MOVE: same pageId, new path -> write new + recorded as moved (NOT in toDelete)', () => {
    const live: LiveEntry[] = [{ pageId: 'p1', relPath: 'Space/NewParent/Doc.md' }];
    const existing: ExistingEntry[] = [
      { pageId: 'p1', relPath: 'Space/OldParent/Doc.md' },
    ];
    const plan = planReconciliation(live, existing);
    expect(plan.toWrite).toEqual([
      { pageId: 'p1', relPath: 'Space/NewParent/Doc.md' },
    ]);
    // The old path is a MOVE removal, NOT an absence delete -> not in toDelete.
    expect(plan.toDelete).toEqual([]);
    expect(plan.moved).toEqual([
      {
        pageId: 'p1',
        fromRelPath: 'Space/OldParent/Doc.md',
        toRelPath: 'Space/NewParent/Doc.md',
        removeOldPath: true,
      },
    ]);
  });

  it('DELETE: a tracked pageId gone from live -> its file is deleted', () => {
    const live: LiveEntry[] = [{ pageId: 'p1', relPath: 'Space/Keep.md' }];
    const existing: ExistingEntry[] = [
      { pageId: 'p1', relPath: 'Space/Keep.md' },
      { pageId: 'p2', relPath: 'Space/Gone.md' },
    ];
    const plan = planReconciliation(live, existing);
    expect(plan.toWrite).toEqual([{ pageId: 'p1', relPath: 'Space/Keep.md' }]);
    expect(plan.toDelete).toEqual(['Space/Gone.md']);
    expect(plan.moved).toEqual([]);
  });

  // D-P3-1 ghost guard: when `deletableIds` is supplied, an absence-delete fires
  // ONLY for an id that is a REAL page row. A tracked file whose id was NEVER a
  // page (a hand-authored git file with an unknown id) is absent from `live` AND
  // absent from `deletableIds` -> it MUST be preserved, not silently deleted.
  it('GHOST GUARD: an absent id NOT in deletableIds is PRESERVED (not deleted)', () => {
    const live: LiveEntry[] = [{ pageId: 'p1', relPath: 'Space/Keep.md' }];
    const existing: ExistingEntry[] = [
      { pageId: 'p1', relPath: 'Space/Keep.md' },
      // A ghost: its id is not live and not a real page row.
      { pageId: 'ghost', relPath: 'Space/Ghost.md' },
      // A genuinely deleted page: absent from live but IS a real row.
      { pageId: 'gone', relPath: 'Space/Gone.md' },
    ];
    // Only the real page row ('gone') is deletable; 'ghost' has no row.
    const deletableIds = new Set(['gone']);
    const plan = planReconciliation(live, existing, deletableIds);
    expect(plan.toWrite).toEqual([{ pageId: 'p1', relPath: 'Space/Keep.md' }]);
    // The genuine delete is applied; the ghost file is preserved.
    expect(plan.toDelete).toEqual(['Space/Gone.md']);
    expect(plan.toDelete).not.toContain('Space/Ghost.md');
    expect(plan.moved).toEqual([]);
  });

  // The empty gate is the maximally-safe case: no id is a real row, so NOTHING
  // is absence-deleted (every absent tracked file is treated as a ghost). This
  // is what a cycle sees when `pageIdsExist` returns nothing for the candidates.
  it('GHOST GUARD: an EMPTY deletableIds set suppresses every absence delete', () => {
    const live: LiveEntry[] = [{ pageId: 'p1', relPath: 'Space/Keep.md' }];
    const existing: ExistingEntry[] = [
      { pageId: 'p1', relPath: 'Space/Keep.md' },
      { pageId: 'gone', relPath: 'Space/Gone.md' },
    ];
    const plan = planReconciliation(live, existing, new Set<string>());
    expect(plan.toDelete).toEqual([]);
    expect(plan.moved).toEqual([]);
  });

  it('NO-OP: live and existing identical -> writes (re-emit) but no deletes/moves', () => {
    const live: LiveEntry[] = [
      { pageId: 'p1', relPath: 'A.md' },
      { pageId: 'p2', relPath: 'B.md' },
    ];
    const existing: ExistingEntry[] = [
      { pageId: 'p1', relPath: 'A.md' },
      { pageId: 'p2', relPath: 'B.md' },
    ];
    const plan = planReconciliation(live, existing);
    expect(plan.toWrite).toEqual(live);
    expect(plan.toDelete).toEqual([]);
    expect(plan.moved).toEqual([]);
  });

  it('does NOT delete an old path that another live page will write (path reuse)', () => {
    // p1 moves from X.md to Y.md; p2 is a NEW page taking over X.md. The old
    // X.md must NOT be deleted, because p2 writes it.
    const live: LiveEntry[] = [
      { pageId: 'p1', relPath: 'Y.md' },
      { pageId: 'p2', relPath: 'X.md' },
    ];
    const existing: ExistingEntry[] = [{ pageId: 'p1', relPath: 'X.md' }];
    const plan = planReconciliation(live, existing);
    expect(new Set(plan.toWrite)).toEqual(
      new Set([
        { pageId: 'p1', relPath: 'Y.md' },
        { pageId: 'p2', relPath: 'X.md' },
      ]),
    );
    // X.md is a live target, so nothing is deleted.
    expect(plan.toDelete).toEqual([]);
    // The move is still recorded, but its old path is NOT removable (p2 writes
    // X.md): removeOldPath:false protects the reused path from data loss.
    expect(plan.moved).toEqual([
      { pageId: 'p1', fromRelPath: 'X.md', toRelPath: 'Y.md', removeOldPath: false },
    ]);
  });

  it('combines add + update + move + delete in one plan', () => {
    const live: LiveEntry[] = [
      { pageId: 'keep', relPath: 'Keep.md' }, // update in place
      { pageId: 'mover', relPath: 'New/Moved.md' }, // moved
      { pageId: 'fresh', relPath: 'Fresh.md' }, // added
    ];
    const existing: ExistingEntry[] = [
      { pageId: 'keep', relPath: 'Keep.md' },
      { pageId: 'mover', relPath: 'Old/Moved.md' },
      { pageId: 'dead', relPath: 'Dead.md' }, // deleted
    ];
    const plan = planReconciliation(live, existing);
    expect(plan.toWrite).toEqual(live);
    expect(plan.moved).toEqual([
      {
        pageId: 'mover',
        fromRelPath: 'Old/Moved.md',
        toRelPath: 'New/Moved.md',
        removeOldPath: true,
      },
    ]);
    // toDelete is ABSENCE-only now: the moved old path lives in `moved`, so only
    // the genuinely-gone page (Dead.md) is here.
    expect(plan.toDelete).toEqual(['Dead.md']);
  });

  it('records each duplicate tracked row of a present pageId as a removable move', () => {
    // Two stray files both claim pageId "dup"; the live page lives elsewhere.
    // Each stray is a MOVE (same pageId, different path) -> recorded in `moved`
    // with removeOldPath:true, NOT in absence-based toDelete.
    const live: LiveEntry[] = [{ pageId: 'dup', relPath: 'Canonical.md' }];
    const existing: ExistingEntry[] = [
      { pageId: 'dup', relPath: 'StrayA.md' },
      { pageId: 'dup', relPath: 'StrayB.md' },
    ];
    const plan = planReconciliation(live, existing);
    expect(plan.toWrite).toEqual([{ pageId: 'dup', relPath: 'Canonical.md' }]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.moved).toEqual([
      {
        pageId: 'dup',
        fromRelPath: 'StrayA.md',
        toRelPath: 'Canonical.md',
        removeOldPath: true,
      },
      {
        pageId: 'dup',
        fromRelPath: 'StrayB.md',
        toRelPath: 'Canonical.md',
        removeOldPath: true,
      },
    ]);
  });
});

describe('decideAbsenceDeletions (SPEC §8)', () => {
  it('APPLIES when the tree is complete and the delete count is modest', () => {
    const d = decideAbsenceDeletions({
      treeComplete: true,
      liveCount: 10,
      existingCount: 10,
      deleteCount: 1,
    });
    expect(d).toEqual({ apply: true });
  });

  it('SUPPRESSES all absence deletions when the tree fetch is incomplete', () => {
    // Even a single absence delete is suppressed on a partial tree (a missing
    // pageId in a partial tree is NOT proof of deletion).
    const d = decideAbsenceDeletions({
      treeComplete: false,
      liveCount: 9,
      existingCount: 10,
      deleteCount: 1,
    });
    expect(d).toEqual({ apply: false, reason: 'incomplete-fetch' });
  });

  it('SUPPRESSES when live returned 0 pages but files are tracked (complete flag aside)', () => {
    const d = decideAbsenceDeletions({
      treeComplete: true,
      liveCount: 0,
      existingCount: 5,
      deleteCount: 5,
    });
    expect(d).toEqual({ apply: false, reason: 'empty-live' });
  });

  it('SUPPRESSES over the mass-delete guard (> 50% of a non-trivial vault)', () => {
    const d = decideAbsenceDeletions({
      treeComplete: true,
      liveCount: 4,
      existingCount: 10,
      deleteCount: 6, // 60% > 50%
    });
    expect(d).toEqual({ apply: false, reason: 'mass-delete' });
  });

  it('does NOT apply the fraction guard for a tiny vault (below the floor)', () => {
    // 1-of-2 is normal in a tiny vault; the fraction guard does not fire.
    const d = decideAbsenceDeletions({
      treeComplete: true,
      liveCount: 1,
      existingCount: 2,
      deleteCount: 1,
    });
    expect(d).toEqual({ apply: true });
  });

  it('incomplete-fetch takes precedence over the mass-delete reason', () => {
    const d = decideAbsenceDeletions({
      treeComplete: false,
      liveCount: 4,
      existingCount: 10,
      deleteCount: 6,
    });
    expect(d).toEqual({ apply: false, reason: 'incomplete-fetch' });
  });

  it('trivially applies when nothing is tracked or nothing would be deleted', () => {
    expect(
      decideAbsenceDeletions({
        treeComplete: false,
        liveCount: 0,
        existingCount: 0,
        deleteCount: 0,
      }),
    ).toEqual({ apply: true });
    expect(
      decideAbsenceDeletions({
        treeComplete: false,
        liveCount: 5,
        existingCount: 5,
        deleteCount: 0,
      }),
    ).toEqual({ apply: true });
  });
});
