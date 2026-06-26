/**
 * Unit test for the REAL sidebar-tree shaping/permission logic.
 *
 * PageService.getSidebarPagesTree delegates its load-bearing shaping (deriving
 * hasChildren, applying the open/restricted-space canEdit branches, and
 * position ordering) to the pure `shapeSidebarPagesTree` helper. We import and
 * exercise that production helper directly here, so a regression in the real
 * logic is caught. (The full PageService is not needed because the shaping is a
 * self-contained pure transform over an already-fetched/filtered page set.)
 */
import {
  shapeSidebarPagesTree,
  SidebarPageRow,
} from './sidebar-pages-tree.util';

const page = (
  id: string,
  parentPageId: string | null,
  position: string,
): SidebarPageRow => ({
  id,
  slugId: `slug-${id}`,
  title: `Page ${id}`,
  icon: '',
  position,
  parentPageId,
  spaceId: 'space-1',
});

describe('getSidebarPagesTree shaping logic', () => {
  it('open space: canEdit = spaceCanEdit, hasChildren derived from set', () => {
    const pages = [
      page('root', null, 'a0'),
      page('child', 'root', 'a0'),
      page('leaf', 'child', 'a0'),
    ];

    const result = shapeSidebarPagesTree(pages, {
      hasRestrictions: false,
      spaceCanEdit: true,
    });

    const byId = new Map(result.map((p) => [p.id, p]));
    expect(byId.get('root')!.hasChildren).toBe(true);
    expect(byId.get('child')!.hasChildren).toBe(true);
    expect(byId.get('leaf')!.hasChildren).toBe(false);
    expect(result.every((p) => p.canEdit === true)).toBe(true);
  });

  it('open space: spaceCanEdit=false makes every node read-only', () => {
    const pages = [page('root', null, 'a0'), page('child', 'root', 'a0')];
    const result = shapeSidebarPagesTree(pages, {
      hasRestrictions: false,
      spaceCanEdit: false,
    });
    expect(result.every((p) => p.canEdit === false)).toBe(true);
  });

  it('restricted space: hasChildren does not reveal pruned children', () => {
    // Simulates the filterAccessibleTreePages result: "child" was pruned, so
    // the returned set has no row with parent === root.
    const prunedPages = [page('root', null, 'a0')];
    const result = shapeSidebarPagesTree(prunedPages, {
      hasRestrictions: true,
      spaceCanEdit: true,
      permissionMap: new Map([['root', true]]),
    });
    expect(result).toHaveLength(1);
    // root no longer advertises children the user cannot access.
    expect(result[0].hasChildren).toBe(false);
  });

  it('restricted space: canEdit is per-page AND spaceCanEdit', () => {
    const pages = [page('root', null, 'a0'), page('child', 'root', 'a0')];
    const result = shapeSidebarPagesTree(pages, {
      hasRestrictions: true,
      spaceCanEdit: true,
      permissionMap: new Map([
        ['root', true],
        ['child', false],
      ]),
    });
    const byId = new Map(result.map((p) => [p.id, p]));
    expect(byId.get('root')!.canEdit).toBe(true);
    expect(byId.get('child')!.canEdit).toBe(false);
    expect(byId.get('root')!.hasChildren).toBe(true);
  });

  it('restricted space: spaceCanEdit=false overrides per-page canEdit', () => {
    const pages = [page('root', null, 'a0')];
    const result = shapeSidebarPagesTree(pages, {
      hasRestrictions: true,
      spaceCanEdit: false,
      permissionMap: new Map([['root', true]]),
    });
    expect(result[0].canEdit).toBe(false);
  });

  it('orders by position (collate-C style ascending)', () => {
    const pages = [
      page('b', null, 'a1'),
      page('c', null, 'a2'),
      page('a', null, 'a0'),
    ];
    const result = shapeSidebarPagesTree(pages, {
      hasRestrictions: false,
      spaceCanEdit: true,
    });
    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('shape contains exactly the sidebar item fields', () => {
    const result = shapeSidebarPagesTree([page('root', null, 'a0')], {
      hasRestrictions: false,
      spaceCanEdit: true,
    });
    expect(Object.keys(result[0]).sort()).toEqual(
      [
        'canEdit',
        'hasChildren',
        'icon',
        'id',
        'parentPageId',
        'position',
        'slugId',
        'spaceId',
        'title',
      ].sort(),
    );
  });
});
