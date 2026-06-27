import { IPage } from "@/features/page/types/page.types.ts";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { findBreadcrumbPath, pageToTreeNode } from "@/features/page/tree/utils";

/**
 * Pure selection/mapping for the breadcrumb nodes (#218). Three branches:
 *   1. tree-hit  — the lazily-built sidebar tree already contains this page's
 *      ancestor chain, so prefer it (stays live with sidebar renames/moves).
 *   2. tree-miss — fall back to the page's own ancestor data so a deep page
 *      resolves immediately instead of rendering a blank breadcrumb for seconds
 *      while the tree backfills. Mapped through the canonical `pageToTreeNode`
 *      (title -> name, hasChildren defaulted to false).
 *   3. neither   — no data yet, return null (the caller decides whether to keep
 *      a prior chain via computeBreadcrumbState).
 */
export function resolveBreadcrumbNodes(
  treeData: SpaceTreeNode[] | null | undefined,
  ancestors: IPage[] | null | undefined,
  pageId: string,
): SpaceTreeNode[] | null {
  if (treeData && treeData.length > 0) {
    const breadcrumb = findBreadcrumbPath(treeData, pageId);
    if (breadcrumb) {
      return breadcrumb;
    }
  }

  if (ancestors && ancestors.length > 0) {
    return ancestors.map((page) =>
      pageToTreeNode(page, { hasChildren: page.hasChildren ?? false }),
    );
  }

  return null;
}

/**
 * Decide the next breadcrumb state, given the previous one. When a chain
 * resolves (#218) it always wins. When nothing resolves yet, a stale chain from
 * a previously-viewed page must be CLEARED rather than left showing the wrong,
 * clickable trail (the reverse regression of the original blank-breadcrumb fix
 * when navigating A -> B to a deep page not yet in the lazily-built tree). The
 * one chain we keep through a transient miss is one that already ends at the
 * current page — that means we already resolved THIS page, so keeping it avoids
 * a needless blank flash without ever showing the previous page's chain.
 */
export function computeBreadcrumbState(
  treeData: SpaceTreeNode[] | null | undefined,
  ancestors: IPage[] | null | undefined,
  pageId: string,
  previous: SpaceTreeNode[] | null,
): SpaceTreeNode[] | null {
  const resolved = resolveBreadcrumbNodes(treeData, ancestors, pageId);
  if (resolved) {
    return resolved;
  }

  const previousEndsAtCurrentPage =
    previous != null && previous[previous.length - 1]?.id === pageId;
  return previousEndsAtCurrentPage ? previous : null;
}
