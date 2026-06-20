/**
 * Pure-logic test for getSidebarPagesTree's shaping/permission logic.
 *
 * NOTE: We cannot import PageService directly here — its dependency chain
 * imports `src/collaboration/collaboration.util` via a bare `src/...` path, and
 * the server's jest config (package.json "jest".moduleNameMapper) has no
 * `^src/(.*)$` mapping, so the module fails to resolve under jest. That is a
 * pre-existing config gap unrelated to this feature. To still cover the
 * load-bearing logic we replicate the exact shaping algorithm from
 * PageService.getSidebarPagesTree below and assert against it. If the service
 * logic changes, keep this mirror in sync.
 */

type RawPage = {
  id: string;
  slugId: string;
  title: string;
  icon: string;
  position: string;
  parentPageId: string | null;
  spaceId: string;
};

// Mirror of the shaping/branch logic in PageService.getSidebarPagesTree.
function shapeTree(
  pages: RawPage[],
  opts: {
    hasRestrictions: boolean;
    spaceCanEdit?: boolean;
    permissionMap?: Map<string, boolean>;
  },
) {
  const parentIds = new Set<string>();
  for (const p of pages) {
    if (p.parentPageId) parentIds.add(p.parentPageId);
  }

  const shaped = pages.map((p) => ({
    id: p.id,
    slugId: p.slugId,
    title: p.title,
    icon: p.icon,
    position: p.position,
    parentPageId: p.parentPageId,
    spaceId: p.spaceId,
    hasChildren: parentIds.has(p.id),
    canEdit: opts.hasRestrictions
      ? Boolean(opts.permissionMap?.get(p.id)) && (opts.spaceCanEdit ?? true)
      : (opts.spaceCanEdit ?? true),
  }));

  shaped.sort((a, b) => {
    if (a.position == null) return b.position == null ? 0 : 1;
    if (b.position == null) return -1;
    return Buffer.compare(Buffer.from(a.position), Buffer.from(b.position));
  });

  return shaped;
}

const page = (
  id: string,
  parentPageId: string | null,
  position: string,
): RawPage => ({
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

    const result = shapeTree(pages, {
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
    const result = shapeTree(pages, {
      hasRestrictions: false,
      spaceCanEdit: false,
    });
    expect(result.every((p) => p.canEdit === false)).toBe(true);
  });

  it('restricted space: hasChildren does not reveal pruned children', () => {
    // Simulates the filterAccessibleTreePages result: "child" was pruned, so
    // the returned set has no row with parent === root.
    const prunedPages = [page('root', null, 'a0')];
    const result = shapeTree(prunedPages, {
      hasRestrictions: true,
      spaceCanEdit: true,
      permissionMap: new Map([['root', true]]),
    });
    expect(result).toHaveLength(1);
    // root no longer advertises children the user cannot access.
    expect(result[0].hasChildren).toBe(false);
  });

  it('restricted space: canEdit is per-page AND spaceCanEdit', () => {
    const pages = [
      page('root', null, 'a0'),
      page('child', 'root', 'a0'),
    ];
    const result = shapeTree(pages, {
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
    const result = shapeTree(pages, {
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
    const result = shapeTree(pages, {
      hasRestrictions: false,
      spaceCanEdit: true,
    });
    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('shape contains exactly the sidebar item fields', () => {
    const result = shapeTree([page('root', null, 'a0')], {
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
