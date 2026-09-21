import { describe, expect, it } from 'vitest';
import { computePullActions } from '../src/engine/pull';
import type { PageNode } from '../src/engine/layout';

// R-Pull-2 (test-strategy report §5): `computePullActions` is the PURE half of
// the pull cycle — layout + planReconciliation + the SPEC §8 absence-deletion
// suppression decision, folded together, with NO IO. These tests exercise it
// without git/fs/network. The thin IO applier is covered in apply-pull-actions.

/** A live tree node (only the fields the layout / reconciliation read). */
function node(
  id: string,
  title: string,
  parentPageId: string | null = null,
  hasChildren = false,
): PageNode {
  return { id, title, slugId: id, parentPageId, hasChildren };
}

describe('computePullActions — normal complete fetch', () => {
  it('builds toWrite from the live layout and an empty existing set (all adds)', () => {
    const pages = [
      node('root', 'Root', null, true),
      node('child', 'Child', 'root'),
    ];
    const actions = computePullActions({
      pages,
      treeComplete: true,
      existing: [],
    });
    // Each live page is (re)written at its deterministic layout path. `root`
    // has a child, so it lives at the folder-note `Root/Root.md` (native-Obsidian
    // layout), with the child alongside it in that folder.
    expect(actions.toWrite).toEqual([
      { pageId: 'root', relPath: 'Root/Root.md' },
      { pageId: 'child', relPath: 'Root/Child.md' },
    ]);
    expect(actions.moved).toEqual([]);
    expect(actions.toDelete).toEqual([]);
    expect(actions.deletionDecision).toEqual({ apply: true });
  });

  it('plans toWrite / moved / toDelete correctly for a mixed reconciliation', () => {
    const pages = [
      node('keep', 'Keep'),
      node('mover', 'Mover'),
      node('fresh', 'Fresh'),
    ];
    // existing: keep (same path), mover (old path -> move), dead (absent -> delete).
    const existing = [
      { pageId: 'keep', relPath: 'Keep.md' },
      { pageId: 'mover', relPath: 'Old/Mover.md' },
      { pageId: 'dead', relPath: 'Dead.md' },
    ];
    const actions = computePullActions({ pages, treeComplete: true, existing });

    expect(actions.toWrite).toEqual([
      { pageId: 'keep', relPath: 'Keep.md' },
      { pageId: 'mover', relPath: 'Mover.md' },
      { pageId: 'fresh', relPath: 'Fresh.md' },
    ]);
    // mover moved from Old/Mover.md to the new layout path Mover.md.
    expect(actions.moved).toEqual([
      {
        pageId: 'mover',
        fromRelPath: 'Old/Mover.md',
        toRelPath: 'Mover.md',
        removeOldPath: true,
      },
    ]);
    // dead is absent from live -> an absence delete (decision applies it).
    expect(actions.toDelete).toEqual(['Dead.md']);
    expect(actions.deletionDecision).toEqual({ apply: true });
  });

  it('a live page moved to a NEW path is in `moved`, its old path NOT in toDelete', () => {
    const pages = [node('p1', 'Doc', 'newparent'), node('newparent', 'NewParent', null, true)];
    const existing = [{ pageId: 'p1', relPath: 'OldParent/Doc.md' }];
    const actions = computePullActions({ pages, treeComplete: true, existing });

    const moved = actions.moved.find((m) => m.pageId === 'p1');
    expect(moved).toBeTruthy();
    expect(moved!.fromRelPath).toBe('OldParent/Doc.md');
    expect(moved!.toRelPath).toBe('NewParent/Doc.md');
    // The old path is a MOVE removal, NEVER an absence delete.
    expect(actions.toDelete).not.toContain('OldParent/Doc.md');
    expect(actions.toDelete).toEqual([]);
  });
});

describe('computePullActions — SPEC §8 suppression folded in', () => {
  it('INCOMPLETE fetch (treeComplete:false) SUPPRESSES absence deletions', () => {
    // dead is absent from the live tree, but the tree fetch was partial -> the
    // missing pageId is NOT proof of deletion, so toDelete must be EMPTY and the
    // decision must report apply:false / incomplete-fetch.
    const pages = [node('keep', 'Keep')];
    const existing = [
      { pageId: 'keep', relPath: 'Keep.md' },
      { pageId: 'dead', relPath: 'Dead.md' },
    ];
    const actions = computePullActions({
      pages,
      treeComplete: false,
      existing,
    });

    expect(actions.deletionDecision).toEqual({
      apply: false,
      reason: 'incomplete-fetch',
    });
    // Suppressed: nothing to delete this cycle...
    expect(actions.toDelete).toEqual([]);
    // ...but the planned count is still reported (for the suppression log).
    expect(actions.plannedDeleteCount).toBe(1);
    // Writes/updates still happen regardless of the suppression.
    expect(actions.toWrite).toEqual([{ pageId: 'keep', relPath: 'Keep.md' }]);
  });

  it('MASS-DELETE guard (>50% of a non-trivial vault) SUPPRESSES deletions', () => {
    // 1 live page, 10 existing tracked, 9 of them absent -> 9/10 > 50% on a
    // non-trivial (>=4) vault -> mass-delete suppression.
    const pages = [node('p0', 'P0')];
    const existing = [
      { pageId: 'p0', relPath: 'P0.md' },
      ...Array.from({ length: 9 }, (_, i) => ({
        pageId: `gone${i}`,
        relPath: `Gone${i}.md`,
      })),
    ];
    const actions = computePullActions({ pages, treeComplete: true, existing });

    expect(actions.deletionDecision).toEqual({
      apply: false,
      reason: 'mass-delete',
    });
    expect(actions.toDelete).toEqual([]);
    expect(actions.plannedDeleteCount).toBe(9);
    expect(actions.existingCount).toBe(10);
  });

  it('moves are NOT suppressed even on an incomplete fetch', () => {
    // A moved page is PRESENT in live, so its move is real regardless of the
    // suppression (which only governs ABSENCE deletes).
    const pages = [node('m', 'Moved')];
    const existing = [{ pageId: 'm', relPath: 'Old/Moved.md' }];
    const actions = computePullActions({
      pages,
      treeComplete: false,
      existing,
    });
    expect(actions.moved).toEqual([
      {
        pageId: 'm',
        fromRelPath: 'Old/Moved.md',
        toRelPath: 'Moved.md',
        removeOldPath: true,
      },
    ]);
    // No absence deletes were planned here, so the decision trivially applies.
    expect(actions.toDelete).toEqual([]);
  });

  it('empty-live with tracked files SUPPRESSES (failed fetch, not a real wipe)', () => {
    const existing = [
      { pageId: 'a', relPath: 'A.md' },
      { pageId: 'b', relPath: 'B.md' },
    ];
    const actions = computePullActions({
      pages: [],
      treeComplete: true,
      existing,
    });
    expect(actions.deletionDecision).toEqual({
      apply: false,
      reason: 'empty-live',
    });
    expect(actions.toDelete).toEqual([]);
    expect(actions.toWrite).toEqual([]);
  });
});

describe('computePullActions — degenerate inputs', () => {
  it('skips nodes without an id and nodes with no layout entry', () => {
    const pages = [
      node('p1', 'Valid'),
      { id: '', title: 'NoId' } as PageNode, // skipped (no id)
    ];
    const actions = computePullActions({
      pages,
      treeComplete: true,
      existing: [],
    });
    expect(actions.toWrite).toEqual([{ pageId: 'p1', relPath: 'Valid.md' }]);
  });
});
