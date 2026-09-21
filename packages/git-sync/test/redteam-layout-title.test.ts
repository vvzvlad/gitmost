import { describe, expect, it } from 'vitest';
import { buildVaultLayout, type PageNode } from '../src/engine/layout.js';
import { classifyRenameMoves } from '../src/engine/push.js';
import type {
  ClassifyRenameMovesDeps,
  MetaSide,
  RenameMoveAction,
} from '../src/engine/push.js';
import type { DocmostMdMeta } from '@docmost/prosemirror-markdown';

// RED-TEAM finding #4 (two facets):
//   (a) buildVaultLayout disambiguation is ORDER-DEPENDENT: which of two
//       equally-titled root pages keeps the bare stem (and which gets the
//       ` ~slugId` suffix) depends purely on input array order. The layout is
//       supposed to be a deterministic function of the page SET, so reordering
//       the input must not move the suffix onto a different page.
//   (b) The page title derived from a DISAMBIGUATED filename ('Report ~a1.md')
//       never strips the cosmetic ` ~slugId` suffix, so a pure disambiguation
//       file-rename is mis-classified as a real title RENAME that would push the
//       suffix ('Report ~a1') back into Docmost as the page's actual title.

describe('redteam #4a — buildVaultLayout is stable under input reorder', () => {
  it('keeps the same stem for page A regardless of input order', () => {
    const A: PageNode = { id: 'A', title: 'Report', slugId: 'a1', parentPageId: null };
    const B: PageNode = { id: 'B', title: 'Report', slugId: 'b2', parentPageId: null };

    const l1 = buildVaultLayout([A, B]);
    const l2 = buildVaultLayout([B, A]);

    // Identity (pageId A) must resolve to the same file stem no matter how the
    // flat page list happened to be ordered.
    expect(l2.get('A')?.stem).toBe(l1.get('A')?.stem);
  });
});

describe('redteam #4b — disambiguation suffix is not a title change', () => {
  // Mirror production push.ts `titleFromPath` EXACTLY: the synthetic native meta
  // sets `title = baseName(path) without ".md"`. This is the real derivation the
  // injected `metaAt` carries in `main`.
  function titleFromPath(path: string): string {
    const slash = path.lastIndexOf('/');
    const base = slash < 0 ? path : path.slice(slash + 1);
    return base.endsWith('.md') ? base.slice(0, -3) : base;
  }

  function deps(): ClassifyRenameMovesDeps {
    const metaAt = (path: string, _side: MetaSide): DocmostMdMeta | null => ({
      version: 1,
      title: titleFromPath(path),
      pageId: 'p1',
    });
    // Same enclosing folder (root) on both sides -> no reparent.
    const resolveParentPageId = (_path: string, _side: MetaSide): string | null => null;
    return { metaAt, resolveParentPageId };
  }

  it('does NOT emit a rename when only a ~slugId suffix was appended', () => {
    // A sibling collision appeared, so the file 'Report.md' was relocated to the
    // disambiguated 'Report ~a1.md'. The page TITLE in Docmost is still 'Report'.
    const rms: RenameMoveAction[] = [
      { pageId: 'p1', oldPath: 'Report.md', newPath: 'Report ~a1.md' },
    ];

    const [classified] = classifyRenameMoves(rms, deps());

    // Desired behaviour: a pure disambiguation file-rename is cosmetic/local and
    // must NOT be pushed as a title change. (If any rename WERE emitted it must
    // carry the real title 'Report', never the suffixed 'Report ~a1'.)
    expect(classified.rename).toBeUndefined();
  });
});
