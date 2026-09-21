import { describe, expect, it } from 'vitest';
import { buildVaultLayout, type PageNode } from '../src/engine/layout.js';

describe('buildVaultLayout', () => {
  it('disambiguates two siblings with the same sanitized title via ~slugId', () => {
    const pages: PageNode[] = [
      { id: 'p1', title: 'Notes', slugId: 'slug-a', parentPageId: null },
      { id: 'p2', title: 'Notes', slugId: 'slug-b', parentPageId: null },
    ];
    const layout = buildVaultLayout(pages);
    expect(layout.get('p1')).toEqual({ segments: [], stem: 'Notes' });
    expect(layout.get('p2')).toEqual({ segments: [], stem: 'Notes ~slug-b' });
  });

  it('falls back to ~id when a colliding sibling has no slugId', () => {
    const pages: PageNode[] = [
      { id: 'p1', title: 'Notes', parentPageId: null },
      { id: 'p2', title: 'Notes', parentPageId: null },
    ];
    const layout = buildVaultLayout(pages);
    expect(layout.get('p1')?.stem).toBe('Notes');
    expect(layout.get('p2')?.stem).toBe('Notes ~p2');
  });

  it('does NOT collide identical titles under DIFFERENT parents (distinct segments)', () => {
    const pages: PageNode[] = [
      { id: 'a', title: 'Alpha', parentPageId: null },
      { id: 'b', title: 'Beta', parentPageId: null },
      { id: 'a1', title: 'Notes', parentPageId: 'a' },
      { id: 'b1', title: 'Notes', parentPageId: 'b' },
    ];
    const layout = buildVaultLayout(pages);
    // Same stem, but different folder segments => no disambiguation needed.
    expect(layout.get('a1')).toEqual({ segments: ['Alpha'], stem: 'Notes' });
    expect(layout.get('b1')).toEqual({ segments: ['Beta'], stem: 'Notes' });
  });

  it('terminates on a 2-node parent cycle and yields a finite result', () => {
    const pages: PageNode[] = [
      { id: 'a', title: 'A', parentPageId: 'b' },
      { id: 'b', title: 'B', parentPageId: 'a' },
    ];
    const layout = buildVaultLayout(pages);
    // Both resolve to a finite path; the visited-guard breaks the cycle.
    expect(layout.size).toBe(2);
    const a = layout.get('a');
    const b = layout.get('b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Each node's segment chain is bounded (no infinite walk).
    expect(a!.segments.length).toBeLessThanOrEqual(2);
    expect(b!.segments.length).toBeLessThanOrEqual(2);
  });

  it('maps a root page (parentPageId null) to empty segments', () => {
    const pages: PageNode[] = [{ id: 'root', title: 'Home', parentPageId: null }];
    const layout = buildVaultLayout(pages);
    expect(layout.get('root')).toEqual({ segments: [], stem: 'Home' });
  });

  it('emits ancestors in root->leaf order for a deep chain', () => {
    const pages: PageNode[] = [
      { id: 'g', title: 'Grand', parentPageId: null },
      { id: 'p', title: 'Parent', parentPageId: 'g' },
      { id: 'c', title: 'Child', parentPageId: 'p' },
    ];
    const layout = buildVaultLayout(pages);
    expect(layout.get('c')).toEqual({
      segments: ['Grand', 'Parent'],
      stem: 'Child',
    });
  });

  it('disambiguates two orphan-parent pages with the same title at the path level', () => {
    // Both parents are OUTSIDE the input set, so both pages bucket at the root
    // with segments: []. Sibling-scoping cannot see this (different parentKeys),
    // so the final full-path pass must produce DISTINCT paths.
    const pages: PageNode[] = [
      { id: 'x', title: 'Orphan', slugId: 'sx', parentPageId: 'missing-1' },
      { id: 'y', title: 'Orphan', slugId: 'sy', parentPageId: 'missing-2' },
    ];
    const layout = buildVaultLayout(pages);
    const ex = layout.get('x')!;
    const ey = layout.get('y')!;
    const pathOf = (e: { segments: string[]; stem: string }) =>
      [...e.segments, e.stem].join('/');
    expect(pathOf(ex)).not.toBe(pathOf(ey));
    // The first keeps the plain stem; the later one is re-stemmed.
    expect(ex.stem).toBe('Orphan');
    expect(ey.stem).toBe('Orphan ~sy');
  });

  it('sanitizes a slugId containing a path separator before using it as a suffix', () => {
    // A crafted slugId with "/" must NOT leak a path separator into the stem.
    const pages: PageNode[] = [
      { id: 'p1', title: 'Notes', slugId: 'a/b', parentPageId: null },
      { id: 'p2', title: 'Notes', slugId: 'c/d', parentPageId: null },
    ];
    const layout = buildVaultLayout(pages);
    const stem = layout.get('p2')!.stem;
    expect(stem).not.toContain('/');
    expect(stem).not.toContain('\\');
    // The "/" was replaced by sanitizeTitle's dash substitution.
    expect(stem).toBe('Notes ~c-d');
  });

  it('disambiguates two ORPHAN ancestors at the NAME pass so their children stay in sync', () => {
    // Two orphan PARENTS share the same title but live under DIFFERENT missing
    // parents, so sibling-scoping by raw parentPageId would never compare them.
    // Both bucket at the vault root, so they MUST be disambiguated in the name
    // pass (sharing the "__root__" bucket) BEFORE any child folder segment is
    // computed from the parent name — otherwise re-stemming a parent post-hoc
    // would desync its child's folder from the parent file.
    const pages: PageNode[] = [
      { id: 'p1', title: 'Dup', slugId: 's1', parentPageId: 'missing-1' },
      { id: 'p2', title: 'Dup', slugId: 's2', parentPageId: 'missing-2' },
      { id: 'c1', title: 'Child', parentPageId: 'p1' },
      { id: 'c2', title: 'Child', parentPageId: 'p2' },
    ];
    const layout = buildVaultLayout(pages);
    const p1 = layout.get('p1')!;
    const p2 = layout.get('p2')!;
    const c1 = layout.get('c1')!;
    const c2 = layout.get('c2')!;

    // The two orphan parents get DISTINCT stems, both at the root.
    expect(p1.segments).toEqual([]);
    expect(p2.segments).toEqual([]);
    expect(p1.stem).toBe('Dup');
    expect(p2.stem).toBe('Dup ~s2');
    expect(p1.stem).not.toBe(p2.stem);

    // Each child's folder segment EXACTLY equals its parent's resolved stem
    // (no desync): the parent name is final before segments are built.
    expect(c1.segments).toEqual([p1.stem]);
    expect(c2.segments).toEqual([p2.stem]);

    // All four full paths are unique.
    const pathOf = (e: { segments: string[]; stem: string }) =>
      [...e.segments, e.stem].join('/');
    const paths = [p1, p2, c1, c2].map(pathOf);
    expect(new Set(paths).size).toBe(paths.length);
  });

  // --- native-Obsidian folder-note layout -------------------------------------

  const pathOf = (e: { segments: string[]; stem: string }) =>
    [...e.segments, e.stem].join('/');

  it('puts a LEAF (no children) at <name> (segments=[])', () => {
    const pages: PageNode[] = [{ id: 'p1', title: 'Заметка' }];
    const layout = buildVaultLayout(pages);
    expect(layout.get('p1')).toEqual({ segments: [], stem: 'Заметка' });
  });

  it('puts a PARENT (with children) at <name>/<name> (folder-note)', () => {
    const pages: PageNode[] = [
      { id: 'par', title: 'Проект', hasChildren: true },
      { id: 'ch', title: 'Задача', parentPageId: 'par' },
    ];
    const layout = buildVaultLayout(pages);
    // Folder-note: the parent's OWN file lives inside its own folder.
    expect(layout.get('par')).toEqual({ segments: ['Проект'], stem: 'Проект' });
    // The child sits ALONGSIDE the folder-note in the same folder.
    expect(layout.get('ch')).toEqual({ segments: ['Проект'], stem: 'Задача' });
    expect(pathOf(layout.get('par')!)).toBe('Проект/Проект');
    expect(pathOf(layout.get('ch')!)).toBe('Проект/Задача');
  });

  it('nests a PARENT-of-parents as <a>/<b>/<b>', () => {
    const pages: PageNode[] = [
      { id: 'a', title: 'Проект', hasChildren: true },
      { id: 'b', title: 'Подпроект', parentPageId: 'a', hasChildren: true },
      { id: 'c', title: 'Лист', parentPageId: 'b' },
    ];
    const layout = buildVaultLayout(pages);
    expect(pathOf(layout.get('a')!)).toBe('Проект/Проект');
    expect(pathOf(layout.get('b')!)).toBe('Проект/Подпроект/Подпроект');
    expect(pathOf(layout.get('c')!)).toBe('Проект/Подпроект/Лист');
  });

  it('disambiguates a CHILD named like its parent folder (folder-note wins)', () => {
    // A child whose title equals the parent's title would collide with the
    // parent's folder-note `Проект/Проект`. The folder-note must keep the
    // canonical path; the CHILD (a leaf) is the one that gets a suffix.
    const pages: PageNode[] = [
      { id: 'par', title: 'Проект', slugId: 'parSlug', hasChildren: true },
      { id: 'ch', title: 'Проект', slugId: 'chSlug', parentPageId: 'par' },
    ];
    const layout = buildVaultLayout(pages);
    const par = layout.get('par')!;
    const ch = layout.get('ch')!;
    // Folder-note keeps `Проект/Проект`.
    expect(pathOf(par)).toBe('Проект/Проект');
    // Child is forced off that path (suffix applied), still in the folder.
    expect(ch.segments).toEqual(['Проект']);
    expect(pathOf(ch)).not.toBe('Проект/Проект');
    expect(ch.stem.startsWith('Проект ')).toBe(true);
    expect(pathOf(par)).not.toBe(pathOf(ch));
  });

  it('keeps two same-named PARENTS distinct (folder == file name each)', () => {
    const pages: PageNode[] = [
      { id: 'a', title: 'Dup', slugId: 'sa', hasChildren: true },
      { id: 'b', title: 'Dup', slugId: 'sb', hasChildren: true },
    ];
    const layout = buildVaultLayout(pages);
    const a = layout.get('a')!;
    const b = layout.get('b')!;
    // Each parent's folder segment EQUALS its file stem (folder-note invariant):
    // a folder `X/` must always contain its own note `X`.
    expect(a.segments).toEqual([a.stem]);
    expect(b.segments).toEqual([b.stem]);
    expect(pathOf(a)).not.toBe(pathOf(b));
  });

  it('does not move a childless page into a folder', () => {
    const pages: PageNode[] = [{ id: 'p', title: 'Пусто', hasChildren: false }];
    const layout = buildVaultLayout(pages);
    expect(layout.get('p')).toEqual({ segments: [], stem: 'Пусто' });
  });
});
