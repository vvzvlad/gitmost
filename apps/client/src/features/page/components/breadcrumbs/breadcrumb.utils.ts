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
 *   3. neither   — no data yet, return null so the caller keeps its prior state.
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
