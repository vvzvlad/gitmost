import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parentFolderFile, applyPushActions } from '../src/engine/push';
import type { ApplyPushDeps, PushActions } from '../src/engine/push';
import { planReconciliation } from '../src/engine/reconcile';
import { buildVaultLayout, type PageNode } from '../src/engine/layout';
import { sanitizeTitle } from '../src/engine/sanitize';
import { firstDivergence } from './roundtrip-helpers';
import { applyPullActions } from '../src/engine/pull';
import type { PullActions, ApplyPullActionsDeps } from '../src/engine/pull';
import type { DeletionDecision } from '../src/engine/reconcile';
import { serializePageFile, parsePageFile } from '@docmost/prosemirror-markdown';

// Engine-layer coverage gaps flagged by the PR #119 reviewers (test-strategy
// report, Module 2 `src/engine`). Each block targets a specific under-covered
// branch directly. PURE units (no IO) are driven by plain inputs; the push/pull
// appliers are driven by FAKES that record calls — no real git/fs/network.

// --- 1. push.ts:parentFolderFile — move<->rename classification lynchpin -----
//
// `parentFolderFile(path)` returns the parent PAGE's file for a vault-relative
// path (SPEC §5 path-as-truth), or `null` for a root-level page. In the native-
// Obsidian FOLDER-NOTE layout the parent page that owns a folder is its folder-
// note `<dir>/<base>.md` (NOT `<dir>.md`). For a file that IS its folder's
// folder-note, the parent is ONE LEVEL UP (the grandparent folder's note, or
// ROOT at the top). It is the lynchpin of the move-vs-rename classifier, so it
// is tested directly: root-level, a leaf in a folder, a folder-note itself,
// deep nesting, and — critically — names CONTAINING DOTS (only the LAST slash
// splits the path).
describe('parentFolderFile (push.ts)', () => {
  it('returns null for a root-level path (no enclosing folder)', () => {
    expect(parentFolderFile('Child.md')).toBeNull();
    // A bare name with no slash at all is also root-level.
    expect(parentFolderFile('README.md')).toBeNull();
  });

  it('returns the enclosing folder-note for a LEAF inside a folder', () => {
    // The parent page owns folder `Space/`, so its file is the folder-note
    // `Space/Space.md` — NOT `Space.md`.
    expect(parentFolderFile('Space/Child.md')).toBe('Space/Space.md');
  });

  it('returns the grandparent folder-note for a FOLDER-NOTE itself', () => {
    // `Space/Sub/Sub.md` IS the folder-note of `Space/Sub`; its parent is the
    // folder-note one level up, `Space/Space.md`.
    expect(parentFolderFile('Space/Sub/Sub.md')).toBe('Space/Space.md');
    // A top-level folder-note `Space/Space.md` has the ROOT as its parent.
    expect(parentFolderFile('Space/Space.md')).toBeNull();
  });

  it('returns the DEEPEST enclosing folder-note for a deeply nested leaf', () => {
    // Only the last slash matters: the parent is the immediate folder's note.
    expect(parentFolderFile('Space/Parent/Sub/Child.md')).toBe(
      'Space/Parent/Sub/Sub.md',
    );
  });

  it('handles names CONTAINING DOTS without splitting on the dot', () => {
    // A dot in a folder/file segment must not be mistaken for the path split.
    // The split is purely on the LAST '/', so the folder-note is the dotted
    // folder name repeated inside it (dots and all).
    expect(parentFolderFile('Space/v1.2.3/Child.md')).toBe('Space/v1.2.3/v1.2.3.md');
    expect(parentFolderFile('a.b/c.d.md')).toBe('a.b/a.b.md');
    // A dotted root-level name still has no enclosing folder.
    expect(parentFolderFile('v1.2.3.md')).toBeNull();
  });
});

// --- 2. reconcile.ts:planReconciliation — chained/swap move (no data loss) ----
//
// A collision where one move's TARGET equals another move's OLD path is the
// classic data-loss trap: naively removing the second move's old path would
// clobber the first move's freshly-written file. The planner must flag the
// reused old path `removeOldPath:false` so the caller never removes it. Both the
// chained-move and the full swap are asserted (no clobber, no loss).
describe('planReconciliation (reconcile.ts) — chained / swap move', () => {
  it('chained move: A target == B old path -> B keeps its old path (no clobber)', () => {
    // B is at b.md and moves to c.md; A is at a.md and moves to b.md. A's TARGET
    // path (b.md) is exactly B's OLD path. Removing b.md for B's move would
    // destroy A's just-written file, so B's move must record removeOldPath:false.
    const live = [
      { pageId: 'A', relPath: 'b.md' },
      { pageId: 'B', relPath: 'c.md' },
    ];
    const existing = [
      { pageId: 'A', relPath: 'a.md' },
      { pageId: 'B', relPath: 'b.md' },
    ];
    const plan = planReconciliation(live, existing);

    // Both pages are (re)written at their new paths; nothing is absence-deleted.
    expect(plan.toWrite).toEqual([
      { pageId: 'A', relPath: 'b.md' },
      { pageId: 'B', relPath: 'c.md' },
    ]);
    expect(plan.toDelete).toEqual([]);

    const moveOf = (id: string) => plan.moved.find((m) => m.pageId === id)!;
    // A's old path (a.md) is free -> safe to remove.
    expect(moveOf('A')).toEqual({
      pageId: 'A',
      fromRelPath: 'a.md',
      toRelPath: 'b.md',
      removeOldPath: true,
    });
    // B's old path (b.md) is reused by A's write -> MUST NOT be removed.
    expect(moveOf('B')).toEqual({
      pageId: 'B',
      fromRelPath: 'b.md',
      toRelPath: 'c.md',
      removeOldPath: false,
    });
  });

  it('swap move: A<->B exchange paths -> BOTH old paths are kept (no loss)', () => {
    // A and B swap: A a.md -> b.md, B b.md -> a.md. Each old path is the OTHER
    // page's live target, so NEITHER may be removed (the writes own them).
    const live = [
      { pageId: 'A', relPath: 'b.md' },
      { pageId: 'B', relPath: 'a.md' },
    ];
    const existing = [
      { pageId: 'A', relPath: 'a.md' },
      { pageId: 'B', relPath: 'b.md' },
    ];
    const plan = planReconciliation(live, existing);

    expect(plan.toDelete).toEqual([]);
    // Both pages written at their swapped destinations.
    expect(plan.toWrite).toEqual([
      { pageId: 'A', relPath: 'b.md' },
      { pageId: 'B', relPath: 'a.md' },
    ]);
    // Both moves recorded, both with removeOldPath:false (the swap is loss-free).
    expect(plan.moved).toEqual([
      {
        pageId: 'A',
        fromRelPath: 'a.md',
        toRelPath: 'b.md',
        removeOldPath: false,
      },
      {
        pageId: 'B',
        fromRelPath: 'b.md',
        toRelPath: 'a.md',
        removeOldPath: false,
      },
    ]);
  });
});

// --- 3. layout.ts:buildVaultLayout — last-resort-by-id branch (~L135-139) ------
//
// The final full-path uniqueness pass has two fallbacks for a colliding leaf:
// first re-stem with the sanitized slugId, and — if STILL colliding — append the
// globally-unique sanitized pageId as a last resort. That id branch is reached
// when FOUR pages share the SAME title AND slugId in the SAME (orphan) bucket:
// the name pass only calls `disambiguate` ONCE, so the 3rd and 4th pages collide
// in the FINAL pass, where the 4th's slugId-disambiguated stem ALSO collides
// (with the 3rd's), forcing the id suffix.
describe('buildVaultLayout (layout.ts) — last-resort-by-id disambiguation', () => {
  it('falls through to the globally-unique pageId when title+slugId both collide', () => {
    // Four orphans (parent outside the input set -> they all bucket at the root)
    // with identical title "A" and identical slugId "s".
    const pages: PageNode[] = [
      { id: 'id1', title: 'A', slugId: 's', parentPageId: 'missing' },
      { id: 'id2', title: 'A', slugId: 's', parentPageId: 'missing' },
      { id: 'id3', title: 'A', slugId: 's', parentPageId: 'missing' },
      { id: 'id4', title: 'A', slugId: 's', parentPageId: 'missing' },
    ];
    const layout = buildVaultLayout(pages);

    // The disambiguation ladder:
    //   id1 -> "A"            (name pass, free)
    //   id2 -> "A ~s"         (name pass, slugId suffix)
    //   id3 -> "A ~s ~s"      (FINAL pass, first attempt: slugId suffix)
    //   id4 -> "A ~s ~s ~id4" (FINAL pass, LAST RESORT: sanitized pageId suffix)
    expect(layout.get('id1')!.stem).toBe('A');
    expect(layout.get('id2')!.stem).toBe('A ~s');
    expect(layout.get('id3')!.stem).toBe('A ~s ~s');
    // The last-resort branch appends the sanitized id (globally unique).
    expect(layout.get('id4')!.stem).toBe(`A ~s ~s ~${sanitizeTitle('id4')}`);

    // All four full paths are unique (the invariant the branch protects).
    const pathOf = (e: { segments: string[]; stem: string }) =>
      [...e.segments, e.stem].join('/');
    const paths = ['id1', 'id2', 'id3', 'id4'].map((id) =>
      pathOf(layout.get(id)!),
    );
    expect(new Set(paths).size).toBe(4);
    // All orphans bucket at the vault root (segments: []).
    for (const id of ['id1', 'id2', 'id3', 'id4']) {
      expect(layout.get(id)!.segments).toEqual([]);
    }
  });
});

// --- 4. roundtrip-helpers.ts:firstDivergence — exported but 0% covered --------
//
// `firstDivergence(a, b)` deep-compares two values and returns either `null`
// (equal) or `{ path, a, b }` locating the FIRST point of difference. Contract
// learned by reading the function: arrays compare length first (`$.length`),
// nested paths build a JSON-pointer-ish `$.x.y[i].z`, and a type/null mismatch
// is reported at the current path with the raw differing values.
describe('firstDivergence (roundtrip-helpers.ts)', () => {
  it('returns null for deeply equal values (no divergence)', () => {
    expect(firstDivergence({ a: 1, b: [1, 2, { c: 'x' }] }, { a: 1, b: [1, 2, { c: 'x' }] })).toBeNull();
    expect(firstDivergence(42, 42)).toBeNull();
    expect(firstDivergence(null, null)).toBeNull();
    expect(firstDivergence([], [])).toBeNull();
  });

  it('locates a divergence at a leaf by path', () => {
    expect(firstDivergence({ a: 1 }, { a: 2 })).toEqual({ path: '$.a', a: 1, b: 2 });
  });

  it('locates a divergence deep inside a nested array/object by path', () => {
    const d = firstDivergence(
      { x: { y: [1, { z: 'a' }] } },
      { x: { y: [1, { z: 'b' }] } },
    );
    expect(d).toEqual({ path: '$.x.y[1].z', a: 'a', b: 'b' });
  });

  it('reports an array length mismatch at `<path>.length`', () => {
    expect(firstDivergence([1, 2], [1, 2, 3])).toEqual({
      path: '$.length',
      a: 2,
      b: 3,
    });
  });

  it('reports a type mismatch (and null vs object) at the current path', () => {
    expect(firstDivergence(1, '1')).toEqual({ path: '$', a: 1, b: '1' });
    expect(firstDivergence(null, {})).toEqual({ path: '$', a: null, b: {} });
    // array vs object at the same path
    expect(firstDivergence([], {})).toEqual({ path: '$', a: [], b: {} });
  });
});

// --- 5. push.ts:applyPushActions — prefetch-move failure isolation ------------
//
// The reviewer asked to exercise the per-entry try/catch around the rename/move
// PREFETCH (push.ts ~L644-672): one move's prefetch should fail in isolation
// while OTHER actions still apply. IMPORTANT FINDING (documented, not a skip of
// the invariant): the prefetch helpers (`resolveParentPageIdViaTree`,
// `metaAtViaTree`) SWALLOW their own IO errors internally (each wraps readFile /
// showFileAtRef / parseDocmostMarkdown in try/catch and returns null), so an
// injected `readFile`/`showFileAtRef` throw NEVER propagates into the L644-672
// catch — that catch is defensive dead code reachable only by a future change to
// the helpers (the source comment says exactly this). It therefore cannot be hit
// through the public deps WITHOUT modifying production code (forbidden here).
//
// What IS testable — and is the invariant the reviewer cares about — is the
// OBSERVABLE isolation: a move whose tree files are unreadable is isolated (it
// resolves to a no-op Docmost call, never aborting the batch) while updates,
// creates and deletes in the SAME batch still apply, and the refs still advance.
describe('applyPushActions (push.ts) — move prefetch isolation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function makeClient() {
    return {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      importPageMarkdown: vi.fn(async () => ({ updatedAt: 'u' })),
      createPage: vi.fn(async () => ({ data: { id: 'new-id' } })),
      deletePage: vi.fn(async () => ({})),
      movePage: vi.fn(async () => ({})),
      renamePage: vi.fn(async () => ({})),
    };
  }

  it('isolates a move whose tree reads are unreadable; other actions still apply', async () => {
    const client = makeClient();
    const git = {
      updateRef: vi.fn(async () => {}),
      fastForwardBranch: vi.fn(async () => ({ ok: true })),
      // The OLD-side parent/meta reads resolve to null (absent at last-pushed).
      showFileAtRef: vi.fn(async () => null),
    };
    // The update file exists and is readable; the move's NEW-path tree reads
    // throw (simulating an unreadable/missing parent folder file at `current`).
    const store: Record<string, string> = {
      'Up.md': serializePageFile('u1', 'body'),
    };
    const deps: ApplyPushDeps = {
      client,
      git,
      readFile: vi.fn(async (p: string) => {
        if (p in store) return store[p];
        throw new Error(`unreadable ${p}`);
      }),
      writeFile: vi.fn(async () => {}),
      spaceId: 'sp',
    };
    const actions: PushActions = {
      creates: [],
      updates: [{ pageId: 'u1', path: 'Up.md' }],
      deletes: [{ pageId: 'd1' }],
      renamesMoves: [
        { pageId: 'pg', oldPath: 'Old/C.md', newPath: 'New/C.md' },
      ],
      skipped: [],
    };

    const res = await applyPushActions(deps, actions, 'COMMIT-SHA');

    // The update and the delete in the SAME batch still applied.
    expect(res.updated).toBe(1);
    expect(res.deleted).toBe(1);
    expect(client.importPageMarkdown).toHaveBeenCalledWith(
      'u1',
      parsePageFile(store['Up.md']).body,
      null,
    );
    expect(client.deletePage).toHaveBeenCalledWith('d1');

    // The broken move was ISOLATED: no movePage/renamePage call, recorded as a
    // graceful no-op (both parents resolve to ROOT/null, no title -> nothing to
    // do), NOT a fatal error.
    expect(client.movePage).not.toHaveBeenCalled();
    expect(client.renamePage).not.toHaveBeenCalled();
    expect(res.moved).toBe(0);
    expect(res.renamed).toBe(0);
    expect(res.noops).toHaveLength(1);
    expect(res.noops[0]).toMatchObject({ pageId: 'pg', reason: 'path-only-rename' });

    // No failures -> the refs advance (a clean batch is not blocked by the
    // isolated, gracefully-handled move).
    expect(res.failures).toEqual([]);
    expect(res.lastPushedAdvanced).toBe(true);
    expect(git.updateRef).toHaveBeenCalledWith(expect.any(String), 'COMMIT-SHA');
  });
});

// --- 6. pull.ts:applyPullActions — failedPageIds keyed per-pageId -------------
//
// `failedPageIds` is keyed by pageId: when MULTIPLE moves each want their old
// path removed, but ONE page's new-path write fails, ONLY that page's old path
// must be KEPT (the ⭐ data-loss guard) — every OTHER page's old path is still
// removed. This proves the set is keyed by pageId (the failing one only), not a
// coarse all-or-nothing gate.
describe('applyPullActions (pull.ts) — failedPageIds keyed per-pageId', () => {
  const VAULT = '/vault';
  const APPLY: DeletionDecision = { apply: true };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function makeClient() {
    return {
      getPageJson: vi.fn(async (pageId: string) => ({
        id: pageId,
        slugId: `slug-${pageId}`,
        title: `Title ${pageId}`,
        spaceId: 'space',
        parentPageId: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: pageId }] },
          ],
        },
      })),
    };
  }
  function makeGit() {
    return {
      stageAll: vi.fn(async () => {}),
      commit: vi.fn(async () => true),
      checkout: vi.fn(async () => {}),
      merge: vi.fn(async () => ({ ok: true, conflict: false, output: '' })),
    };
  }
  function makeFs(failWriteFor: Set<string>) {
    const rms: string[] = [];
    const fs = {
      writeFile: vi.fn(async (abs: string) => {
        if (failWriteFor.has(abs)) throw new Error(`write failed for ${abs}`);
      }),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async (abs: string) => {
        rms.push(abs);
      }),
    };
    return { fs, rms };
  }

  it('keeps ONLY the failing page old path; the other moves still remove theirs', async () => {
    // Two moves, both removeOldPath:true. Page "ok" writes fine; page "bad"
    // fails its new-path write. Only "bad"'s old path must be kept.
    const client = makeClient();
    const git = makeGit();
    const fs = makeFs(new Set(['/vault/NewBad/Bad.md']));

    const deps: ApplyPullActionsDeps = {
      client,
      git,
      writeFile: fs.fs.writeFile,
      mkdir: fs.fs.mkdir,
      rm: fs.fs.rm,
    };
    const actions: PullActions = {
      toWrite: [
        { pageId: 'ok', relPath: 'NewOk/Ok.md' },
        { pageId: 'bad', relPath: 'NewBad/Bad.md' },
      ],
      moved: [
        {
          pageId: 'ok',
          fromRelPath: 'OldOk/Ok.md',
          toRelPath: 'NewOk/Ok.md',
          removeOldPath: true,
        },
        {
          pageId: 'bad',
          fromRelPath: 'OldBad/Bad.md',
          toRelPath: 'NewBad/Bad.md',
          removeOldPath: true,
        },
      ],
      toDelete: [],
      deletionDecision: APPLY,
      existingCount: 2,
      plannedDeleteCount: 0,
    };

    const res = await applyPullActions(deps, actions, VAULT);

    // One write succeeded ("ok"), one failed ("bad").
    expect(res.written).toBe(1);
    expect(res.failed).toBe(1);

    // The healthy page's old path WAS removed; the failing page's old path was
    // KEPT (failedPageIds is keyed by pageId -> only "bad" is suppressed).
    expect(fs.rms).toContain('/vault/OldOk/Ok.md');
    expect(fs.rms).not.toContain('/vault/OldBad/Bad.md');
    // Exactly one move old-path removal applied (the healthy one).
    expect(res.movedApplied).toBe(1);
    expect(fs.rms).toEqual(['/vault/OldOk/Ok.md']);
  });
});
