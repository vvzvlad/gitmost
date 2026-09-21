import { useAtom } from "jotai";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  fetchAllAncestorChildren,
  useGetRootSidebarPagesQuery,
  usePageMetaQuery,
} from "@/features/page/queries/page-query.ts";
import classes from "@/features/page/tree/styles/tree.module.css";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { openTreeNodesAtom } from "@/features/page/tree/atoms/open-tree-nodes-atom.ts";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation.ts";
import {
  buildTree,
  buildTreeWithChildren,
  mergeRootTrees,
  collectAllIds,
  collectBranchIds,
  openBranches,
  closeIds,
  loadedOpenBranchIds,
  pruneCollapsedChildren,
} from "@/features/page/tree/utils/utils.ts";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import {
  getPageBreadcrumbs,
  getSpaceTree,
} from "@/features/page/services/page-service.ts";
import { IPage } from "@/features/page/types/page.types.ts";
import { extractPageSlugId } from "@/lib";
import { isCompactPageTreeEnabled } from "@/lib/config.ts";
import {
  DocTree,
  ROW_HEIGHT_COMPACT,
  ROW_HEIGHT_STANDARD,
  TREE_ICON_SIZE_COMPACT,
  TREE_ICON_SIZE_STANDARD,
} from "./doc-tree";
import { SpaceTreeRow } from "./space-tree-row";

interface SpaceTreeProps {
  spaceId: string;
  readOnly: boolean;
}

export type SpaceTreeApi = {
  expandAll: () => Promise<void>;
  collapseAll: () => void;
  isExpanding: boolean;
};

const SpaceTree = forwardRef<SpaceTreeApi, SpaceTreeProps>(function SpaceTree(
  { spaceId, readOnly },
  ref,
) {
  const { t } = useTranslation();
  const { pageSlug } = useParams();
  const compactTree = isCompactPageTreeEnabled();
  const [data, setData] = useAtom(treeDataAtom);
  const [isExpanding, setIsExpanding] = useState(false);
  const { handleMove } = useTreeMutation(spaceId);
  const {
    data: pagesData,
    hasNextPage,
    fetchNextPage,
    isFetching,
  } = useGetRootSidebarPagesQuery({ spaceId });
  const [openTreeNodes, setOpenTreeNodes] = useAtom(openTreeNodesAtom);
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const spaceIdRef = useRef(spaceId);
  spaceIdRef.current = spaceId;
  const { data: currentPage } = usePageMetaQuery({
    pageId: extractPageSlugId(pageSlug),
  });

  useEffect(() => {
    setIsDataLoaded(false);
  }, [spaceId]);

  useEffect(() => {
    if (hasNextPage && !isFetching) {
      fetchNextPage();
    }
  }, [hasNextPage, fetchNextPage, isFetching, spaceId]);

  useEffect(() => {
    if (!pagesData?.pages || hasNextPage) return;

    const allItems = pagesData.pages.flatMap((page) => page.items);
    const treeData = buildTree(allItems);

    setData((prev) => {
      // Keep nodes belonging to other spaces — filteredData filters by spaceId
      // for rendering, so accumulating is safe. Preserves lazy-loaded children
      // and open-state when the user returns to a previously-visited space.
      const otherSpaces = prev.filter((n) => n?.spaceId !== spaceId);
      const currentSpace = prev.filter((n) => n?.spaceId === spaceId);
      const refreshed =
        currentSpace.length > 0
          ? mergeRootTrees(currentSpace, treeData)
          : treeData;
      return [...otherSpaces, ...refreshed];
    });
    setIsDataLoaded(true);
  }, [pagesData, hasNextPage, spaceId]);

  useEffect(() => {
    const effectSpaceId = spaceId;

    const fetchData = async () => {
      if (isDataLoaded && currentPage) {
        // check if pageId node is present in the tree
        const node = treeModel.find(data, currentPage.id);
        if (node) {
          // if node is found, no need to traverse its ancestors
          return;
        }

        // if not found, fetch and build its ancestors and their children
        if (!currentPage.id) return;
        const ancestors = await getPageBreadcrumbs(currentPage.id);

        if (spaceIdRef.current !== effectSpaceId) return;

        if (ancestors && ancestors.length > 1) {
          let flatTreeItems = [...buildTree(ancestors)];

          const fetchAndUpdateChildren = async (ancestor: IPage) => {
            // we don't want to fetch the children of the opened page
            if (ancestor.id === currentPage.id) return;
            const children = await fetchAllAncestorChildren({
              pageId: ancestor.id,
              spaceId: ancestor.spaceId,
            });

            flatTreeItems = [
              ...flatTreeItems,
              ...children.filter(
                (child) => !flatTreeItems.some((item) => item.id === child.id),
              ),
            ];
          };

          const fetchPromises = ancestors.map((ancestor) =>
            fetchAndUpdateChildren(ancestor),
          );

          Promise.all(fetchPromises).then(() => {
            if (spaceIdRef.current !== effectSpaceId) return;

            // build tree with children
            const ancestorsTree = buildTreeWithChildren(flatTreeItems);
            // child of root page we're attaching the built ancestors to
            const rootChild = ancestorsTree[0];

            // attach built ancestors to tree using functional updater
            setData((currentData) =>
              treeModel.appendChildren(
                currentData,
                rootChild.id,
                rootChild.children ?? [],
              ),
            );

            // open all ancestors of the current page. DocTree picks up the
            // selectedId change and scrolls the row into view on its own once
            // flat contains it.
            setOpenTreeNodes((prev) => {
              const next = { ...prev };
              for (const a of ancestors) {
                if (a.id !== currentPage.id) next[a.id] = true;
              }
              return next;
            });
          });
        }
      }
    };

    fetchData();
  }, [isDataLoaded, currentPage?.id]);

  const openIds = useMemo(
    () => new Set(Object.keys(openTreeNodes).filter((k) => openTreeNodes[k])),
    [openTreeNodes],
  );

  // Latest tree + open-state for the reconnect handler (its closure would
  // otherwise read stale snapshots).
  const [socket] = useAtom(socketAtom);
  const dataRef = useRef(data);
  dataRef.current = data;
  const openIdsRef = useRef(openIds);
  openIdsRef.current = openIds;

  // Boot-cache hygiene (#159 #8): the localStorage-hydrated tree carries the
  // children of every branch ever expanded, including ones now COLLAPSED. Their
  // first expand would skip the lazy-load and render stale children (a
  // rename/move/delete missed while offline). Drop the cached children of every
  // COLLAPSED branch ONCE at mount so its first expand fetches fresh via
  // handleToggle — exactly as it did before the tree was cached. OPEN branches
  // keep their children and are refreshed by refreshOpenBranches instead, so
  // this runs before any expand and never double-fetches an open branch.
  const prunedBootCacheRef = useRef(false);
  useEffect(() => {
    if (prunedBootCacheRef.current) return;
    prunedBootCacheRef.current = true;
    setData((prev) => pruneCollapsedChildren(prev, openIdsRef.current));
  }, [setData]);

  // Re-fetch and reconcile the children of every currently-open, already-loaded
  // branch of THIS space. Shared by the socket reconnect handler and the
  // post-load cache refresh below. The ROOT level is reconciled separately by
  // the root-query refetch + mergeRootTrees; an UNLOADED branch is skipped
  // (lazy-load fetches it fresh on expand). Reads refs so it always sees the
  // latest tree/open-state/space without re-creating the callback.
  const refreshOpenBranches = useCallback(async () => {
    const effectSpaceId = spaceIdRef.current;
    const branchIds = loadedOpenBranchIds(
      dataRef.current.filter((n) => n?.spaceId === effectSpaceId),
      openIdsRef.current,
    );
    if (branchIds.length === 0) return;
    for (const id of branchIds) {
      try {
        // `fresh: true` bypasses the 30-min sidebar-pages cache so the
        // reconcile sees the server's CURRENT children (handler-order
        // independent — no reliance on the global reconnect invalidation).
        const fresh = await fetchAllAncestorChildren(
          { pageId: id, spaceId: effectSpaceId },
          { fresh: true },
        );
        if (spaceIdRef.current !== effectSpaceId) return; // space switched
        setData((prev) => treeModel.reconcileChildren(prev, id, fresh));
      } catch (err) {
        console.error("[tree] open branch refresh failed", err);
      }
    }
  }, [setData]);

  // Reconnect refresh (#159 #8): on a socket reconnect, refresh open branches
  // so a move/rename/delete that happened INSIDE a loaded branch while events
  // were missed (laptop sleep / wifi gap) is reflected instead of left stale.
  // No first-connect guard is needed: space-tree usually mounts AFTER the
  // initial connect, so every `connect` it sees is a reconnect; the rare
  // initial-connect case has an empty tree, so the refresh is a harmless no-op.
  useEffect(() => {
    if (!socket) return;
    const onConnect = () => {
      refreshOpenBranches();
    };
    socket.on("connect", onConnect);
    return () => {
      socket.off("connect", onConnect);
    };
  }, [socket, refreshOpenBranches]);

  // Post-load cache refresh: the sidebar paints instantly from the
  // localStorage-cached tree, so children of open branches may be stale. Once
  // the server root set has been merged for this space (isDataLoaded flips
  // true), refresh every open, already-loaded branch ONCE per space per mount.
  // dataRef.current is already up to date here: refs are assigned during
  // render, and this effect runs after the merge-triggered re-render commit.
  const refreshedSpacesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isDataLoaded) return;
    if (refreshedSpacesRef.current.has(spaceId)) return;
    refreshedSpacesRef.current.add(spaceId);
    refreshOpenBranches();
  }, [isDataLoaded, spaceId, refreshOpenBranches]);

  const handleToggle = useCallback(
    async (id: string, isOpen: boolean) => {
      setOpenTreeNodes((prev) => ({ ...prev, [id]: isOpen }));
      if (isOpen) {
        const node = treeModel.find(data, id) as SpaceTreeNode | null;
        // Same "unloaded branch" predicate the realtime insert paths use
        // (`isUnloadedBranch`) so the lazy-load gate and the realtime inserts
        // (`insertByPosition` / `placeByPosition`) can never disagree about what
        // counts as unloaded (#525). Note: local raw `insert` (DnD/create-page)
        // does not yet route through it — see #525 follow-up.
        if (treeModel.isUnloadedBranch(node)) {
          const fetched = await fetchAllAncestorChildren({
            pageId: id,
            spaceId: node.spaceId,
          });
          setData((prev) => treeModel.appendChildren(prev, id, fetched));
        }
      }
    },
    [data, setOpenTreeNodes, setData],
  );

  const filteredData = useMemo(
    () => data.filter((node) => node?.spaceId === spaceId),
    [data, spaceId],
  );

  const expandAll = useCallback(async () => {
    const startSpaceId = spaceIdRef.current;
    setIsExpanding(true);
    try {
      // One request: the entire space tree, permission-filtered server-side.
      const items = await getSpaceTree({ spaceId: startSpaceId });
      // Space switched mid-flight — abort merge/expand.
      if (spaceIdRef.current !== startSpaceId) return;

      const fullTree = buildTreeWithChildren(buildTree(items));

      setData((prev) => {
        // Replace current-space nodes with the full tree; keep other spaces intact.
        const others = prev.filter((n) => n?.spaceId !== startSpaceId);
        return [...others, ...fullTree];
      });

      // Open every branch node (node with children) of the current space only.
      const branchIds = collectBranchIds(fullTree);

      setOpenTreeNodes((prev) => openBranches(prev, branchIds));
    } catch (err: any) {
      // Never swallow: log full error + surface the real reason.
      console.error("[tree] expandAll failed", err);
      notifications.show({
        color: "red",
        message: t("Couldn't expand the tree: {{reason}}", {
          reason: err?.response?.data?.message ?? err?.message ?? String(err),
        }),
      });
    } finally {
      setIsExpanding(false);
    }
  }, [setData, setOpenTreeNodes, t]);

  const collapseAll = useCallback(() => {
    // The open-map is shared across spaces; collapse only current-space ids so
    // other spaces' expanded state is left intact.
    const ids = collectAllIds(filteredData);

    setOpenTreeNodes((prev) => closeIds(prev, ids));
  }, [filteredData, setOpenTreeNodes]);

  useImperativeHandle(ref, () => ({ expandAll, collapseAll, isExpanding }), [
    expandAll,
    collapseAll,
    isExpanding,
  ]);

  // Stable callbacks for DocTree. Without these, every parent render recreates
  // the props and tears down every row's draggable/dropTarget subscription,
  // defeating memo(DocTreeRow).
  const renderRow = useCallback(
    (rowProps: Parameters<typeof SpaceTreeRow>[0]) => (
      <SpaceTreeRow
        {...rowProps}
        readOnly={readOnly}
        iconSize={compactTree ? TREE_ICON_SIZE_COMPACT : TREE_ICON_SIZE_STANDARD}
      />
    ),
    [readOnly, compactTree],
  );
  const disableDragDrop = useCallback(
    (n: SpaceTreeNode) => n.canEdit === false,
    [],
  );
  const getDragLabel = useCallback(
    (n: SpaceTreeNode) => n.name || t("Untitled"),
    [t],
  );

  return (
    <div className={classes.treeContainer}>
      {/* "No pages yet" only after the SERVER confirmed the space is empty —
          never while just the localStorage cache is empty. */}
      {isDataLoaded && filteredData.length === 0 && (
        <Text size="xs" c="dimmed" py="xs" px="sm">
          {t("No pages yet")}
        </Text>
      )}
      {/* Cache-first paint: render as soon as ANY data exists (synchronous
          localStorage hydration) instead of waiting for the server round-trip;
          the background merge/refresh reconciles it afterwards. */}
      {filteredData.length > 0 && (
        <DocTree<SpaceTreeNode>
          data={filteredData}
          openIds={openIds}
          selectedId={currentPage?.id}
          renderRow={renderRow}
          onMove={handleMove}
          onToggle={handleToggle}
          rowHeight={compactTree ? ROW_HEIGHT_COMPACT : ROW_HEIGHT_STANDARD}
          readOnly={readOnly}
          disableDrag={disableDragDrop}
          disableDrop={disableDragDrop}
          getDragLabel={getDragLabel}
          aria-label={t("Pages")}
        />
      )}
    </div>
  );
});

export default SpaceTree;
