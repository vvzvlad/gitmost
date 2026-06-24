import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { sharedTreeDataAtom } from "@/features/share/atoms/shared-page-atom";
import { SharedPageTreeNode } from "@/features/share/utils";

export function useSharedPageSubpages(pageId: string | undefined) {
  const treeData = useAtomValue(sharedTreeDataAtom);

  return useMemo(() => {
    if (!treeData || !pageId) return [];

    function findSubpages(nodes: SharedPageTreeNode[]): SharedPageTreeNode[] {
      for (const node of nodes) {
        if (node.value === pageId || node.slugId === pageId) {
          return node.children || [];
        }
        if (node.children && node.children.length > 0) {
          const subpages = findSubpages(node.children);
          if (subpages.length > 0) {
            return subpages;
          }
        }
      }
      return [];
    }

    return findSubpages(treeData);
  }, [treeData, pageId]);
}

// Recursive variant for the subpages node in a shared/public context. The shared
// tree (`sharedTreeDataAtom`) is ALREADY fully nested, so a page's `children`
// each carry their own nested `children` — exactly what the recursive renderer
// needs. The data is therefore identical to the flat hook; only the rendering
// differs (the recursive view walks `children` instead of showing one level).
// Thin alias to avoid duplicating the lookup. No `/pages/tree` request here.
export const useSharedPageSubtree = useSharedPageSubpages;
