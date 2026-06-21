import { Page } from '@docmost/db/types/entity.types';

/**
 * Raw page row consumed by the sidebar-tree shaping. This is the minimal flat
 * shape returned by the repo queries (getPageAndDescendants / getSpaceDescendants),
 * before hasChildren/canEdit are derived.
 */
export type SidebarPageRow = {
  id: string;
  slugId: string;
  title: string;
  icon: string;
  position: string;
  parentPageId: string | null;
  spaceId: string;
};

export type ShapedSidebarPage = Pick<
  Page,
  'id' | 'slugId' | 'title' | 'icon' | 'position' | 'parentPageId' | 'spaceId'
> & { hasChildren: boolean; canEdit: boolean };

/**
 * Pure shaping/permission transform extracted from
 * PageService.getSidebarPagesTree. Takes the FINAL (already pruned/filtered)
 * flat page set and derives the sidebar item shape:
 *  - hasChildren: a node has children iff some returned row points to it as
 *    parent. In a restricted space the input is already pruned/filtered, so
 *    inaccessible children are not revealed.
 *  - canEdit: open space -> spaceCanEdit; restricted space -> per-page
 *    permission AND spaceCanEdit.
 *  - ordering: by position with byte order, matching the sidebar's
 *    `position collate "C"` SQL ordering. position is non-null in returned
 *    rows; a null is treated defensively as sorting last.
 *
 * Kept as a standalone pure function so it can be unit-tested directly without
 * the full PageService dependency chain.
 */
export function shapeSidebarPagesTree(
  pages: SidebarPageRow[],
  opts: {
    hasRestrictions: boolean;
    spaceCanEdit?: boolean;
    permissionMap?: Map<string, boolean>;
  },
): ShapedSidebarPage[] {
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
