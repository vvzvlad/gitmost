import {
  InfiniteData,
  QueryKey,
  useInfiniteQuery,
  UseInfiniteQueryResult,
  useMutation,
  useQuery,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  createPage,
  deletePage,
  getPageById,
  getSidebarPages,
  updatePage,
  movePage,
  getPageBreadcrumbs,
  getRecentChanges,
  getCreatedByPages,
  getAllSidebarPages,
  getDeletedPages,
  restorePage,
  getSpaceTree,
} from "@/features/page/services/page-service";
import {
  IMovePage,
  IPage,
  IPageInput,
  SidebarPagesParams,
} from "@/features/page/types/page.types";
import { notifications } from "@mantine/notifications";
import { IPagination, QueryParams } from "@/lib/types.ts";
import { queryClient } from "@/main.tsx";
import { buildTree } from "@/features/page/tree/utils";
import { useEffect } from "react";
import { validate as isValidUuid } from "uuid";
import { useTranslation } from "react-i18next";
import { useSetAtom, useStore } from "jotai";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { SpaceTreeNode } from "@/features/page/tree/types";
import { useQueryEmit } from "@/features/websocket/use-query-emit";
import { moveToTrashNotificationMessage } from "@/features/page/components/move-to-trash-notification";

export function usePageQuery(
  pageInput: Partial<IPageInput>,
): UseQueryResult<IPage, Error> {
  const query = useQuery({
    queryKey: ["pages", pageInput.pageId],
    queryFn: () => getPageById(pageInput),
    enabled: !!pageInput.pageId,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (query.data) {
      if (isValidUuid(pageInput.pageId)) {
        queryClient.setQueryData(["pages", query.data.slugId], query.data);
      } else {
        queryClient.setQueryData(["pages", query.data.id], query.data);
      }
    }
  }, [query.data]);

  return query;
}

export function useCreatePageMutation() {
  const { t } = useTranslation();
  return useMutation<IPage, Error, Partial<IPageInput>>({
    mutationFn: (data) => createPage(data),
    onSuccess: (data) => {
      invalidateOnCreatePage(data);
    },
    onError: (error) => {
      notifications.show({ message: t("Failed to create page"), color: "red" });
    },
  });
}

export function updatePageData(data: IPage) {
  const pageBySlug = queryClient.getQueryData<IPage>(["pages", data.slugId]);
  const pageById = queryClient.getQueryData<IPage>(["pages", data.id]);

  if (pageBySlug) {
    queryClient.setQueryData(["pages", data.slugId], {
      ...pageBySlug,
      ...data,
    });
  }

  if (pageById) {
    queryClient.setQueryData(["pages", data.id], { ...pageById, ...data });
  }

  invalidateOnUpdatePage(
    data.spaceId,
    data.parentPageId,
    data.id,
    data.title,
    data.icon,
  );
}

export function useUpdateTitlePageMutation() {
  return useMutation<IPage, Error, Partial<IPageInput>>({
    mutationFn: (data) => updatePage(data),
  });
}

export function useUpdatePageMutation() {
  return useMutation<IPage, Error, Partial<IPageInput>>({
    mutationFn: (data) => updatePage(data),
    onSuccess: (data) => {
      updatePageData(data);
    },
  });
}

export function useRemovePageMutation() {
  const { t } = useTranslation();
  // Reuse the existing restore flow for the toast's Undo action. Its side
  // effects (tree re-insert, cache updates, websocket emit, success toast) live
  // in its useMutation-level onSuccess, so they still run after the originating
  // tree node / page header has unmounted by the time Undo is clicked.
  const restorePageMutation = useRestorePageMutation();
  return useMutation({
    mutationFn: (pageId: string) => deletePage(pageId, false),
    onSuccess: (_, pageId) => {
      // Replace the former pre-delete confirmation dialog with an Undo action
      // surfaced directly in the "moved to trash" toast.
      const notificationId = `page-moved-to-trash-${pageId}`;
      notifications.show({
        id: notificationId,
        autoClose: 8000,
        message: moveToTrashNotificationMessage({
          message: t("Page moved to trash"),
          undoLabel: t("Undo"),
          onUndo: () => {
            notifications.hide(notificationId);
            restorePageMutation.mutate(pageId);
          },
        }),
      });

      // Stamp deletedAt so a re-visit shows the trash banner, not stale state.
      const cached = queryClient.getQueryData<IPage>(["pages", pageId]);
      if (cached) {
        const stamped = { ...cached, deletedAt: new Date() };
        queryClient.setQueryData(["pages", cached.id], stamped);
        queryClient.setQueryData(["pages", cached.slugId], stamped);
      }

      invalidateOnDeletePage(pageId);
      queryClient.invalidateQueries({
        predicate: (item) =>
          ["trash-list"].includes(item.queryKey[0] as string),
      });
    },
    onError: (error) => {
      notifications.show({ message: t("Failed to delete page"), color: "red" });
    },
  });
}

export function useDeletePageMutation() {
  const { t } = useTranslation();
  return useMutation({
    mutationFn: (pageId: string) => deletePage(pageId, true),
    onSuccess: (data, pageId) => {
      notifications.show({ message: t("Page deleted successfully") });
      invalidateOnDeletePage(pageId);

      // Invalidate to refresh trash lists
      queryClient.invalidateQueries({
        predicate: (item) =>
          ["trash-list"].includes(item.queryKey[0] as string),
      });
    },
    onError: (error) => {
      const message =
        error["response"]?.data?.message || t("Failed to delete page");
      notifications.show({ message, color: "red" });
    },
  });
}

export function useMovePageMutation() {
  return useMutation<void, Error, IMovePage>({
    mutationFn: (data) => movePage(data),
  });
}

export function useRestorePageMutation() {
  const { t } = useTranslation();
  const setTreeData = useSetAtom(treeDataAtom);
  const store = useStore();
  const emit = useQueryEmit();

  return useMutation({
    mutationFn: (pageId: string) => restorePage(pageId),
    onSuccess: async (restoredPage) => {
      notifications.show({ message: t("Page restored successfully") });

      // Undo can fire from the trash toast after the originating tree node /
      // page header has unmounted, so a render-time `treeData` closure would be
      // stale. Read the live tree imperatively from the store at execution time.
      const currentTree = store.get(treeDataAtom);

      // Check if the page already exists in the tree (it shouldn't)
      if (!treeModel.find(currentTree, restoredPage.id)) {
        // Create the tree node data with hasChildren from backend
        const nodeData: SpaceTreeNode = {
          id: restoredPage.id,
          slugId: restoredPage.slugId,
          name: restoredPage.title || "Untitled",
          icon: restoredPage.icon,
          position: restoredPage.position,
          spaceId: restoredPage.spaceId,
          parentPageId: restoredPage.parentPageId,
          hasChildren: restoredPage.hasChildren || false,
          children: [],
        };

        // Determine the parent and index
        const parentId = restoredPage.parentPageId || null;
        let index = 0;

        if (parentId) {
          const parentNode = treeModel.find(currentTree, parentId);
          if (parentNode) {
            index = parentNode.children?.length || 0;
          }
        } else {
          // Root level page
          index = currentTree.length;
        }

        // Add the node to the tree via a functional updater, re-checking
        // existence against the freshest state for idempotency.
        setTreeData((prev) =>
          treeModel.find(prev, restoredPage.id)
            ? prev
            : treeModel.insert(prev, parentId, nodeData, index),
        );

        // Emit websocket event to sync with other users
        setTimeout(() => {
          emit({
            operation: "addTreeNode",
            spaceId: restoredPage.spaceId,
            payload: {
              parentId,
              index,
              data: nodeData,
            },
          });
        }, 50);
      }

      //  await queryClient.invalidateQueries({ queryKey: ["sidebar-pages", restoredPage.spaceId] });

      // Also invalidate deleted pages query to refresh the trash list
      await queryClient.invalidateQueries({
        queryKey: ["trash-list", restoredPage.spaceId],
      });

      // Merge — restore endpoint returns a skinny page;
      // Replace would strip space/permissions/content and break the editor.
      const merge = (cached: IPage | undefined) =>
        cached ? { ...cached, ...restoredPage } : cached;
      queryClient.setQueryData<IPage>(["pages", restoredPage.id], merge);
      queryClient.setQueryData<IPage>(["pages", restoredPage.slugId], merge);
    },
    onError: (error) => {
      notifications.show({
        message: t("Failed to restore page"),
        color: "red",
      });
    },
  });
}

export function useGetSidebarPagesQuery(
  data: SidebarPagesParams | null,
): UseInfiniteQueryResult<InfiniteData<IPagination<IPage>, unknown>> {
  return useInfiniteQuery({
    queryKey: ["sidebar-pages", data],
    enabled: !!data?.pageId || !!data?.spaceId,
    queryFn: ({ pageParam }) =>
      getSidebarPages({ ...data, cursor: pageParam, limit: 100 }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor ?? undefined,
  });
}

export function useGetRootSidebarPagesQuery(data: SidebarPagesParams) {
  return useInfiniteQuery({
    queryKey: ["root-sidebar-pages", data.spaceId],
    queryFn: async ({ pageParam }) => {
      return getSidebarPages({
        spaceId: data.spaceId,
        cursor: pageParam,
        limit: 100,
      });
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor ?? undefined,
  });
}

export function useGetPageTreeQuery(pageId: string) {
  return useQuery({
    queryKey: ["page-tree", pageId],
    queryFn: () => getSpaceTree({ pageId }),
    enabled: !!pageId,
    staleTime: 30 * 1000,
  });
}

export function usePageBreadcrumbsQuery(
  pageId: string,
): UseQueryResult<Partial<IPage[]>, Error> {
  return useQuery({
    queryKey: ["breadcrumbs", pageId],
    queryFn: () => getPageBreadcrumbs(pageId),
    enabled: !!pageId,
  });
}

export async function fetchAllAncestorChildren(
  params: SidebarPagesParams,
  // `fresh: true` forces a server refetch (staleTime 0) — used by the reconnect
  // refresh (#159 #8), which must NOT receive the 30-min-cached children.
  opts?: { fresh?: boolean },
) {
  // not using a hook here, so we can call it inside a useEffect hook
  const response = await queryClient.fetchQuery({
    queryKey: ["sidebar-pages", params],
    queryFn: () => getAllSidebarPages(params),
    staleTime: opts?.fresh ? 0 : 30 * 60 * 1000,
  });

  const allItems = response.pages.flatMap((page) => page.items);
  return buildTree(allItems);
}

export function useRecentChangesQuery(spaceId?: string) {
  return useInfiniteQuery({
    queryKey: ["recent-changes", spaceId],
    queryFn: ({ pageParam }) =>
      getRecentChanges({ spaceId, cursor: pageParam, limit: 15 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? lastPage.meta.nextCursor : undefined,
    refetchOnMount: true,
  });
}

export function useCreatedByQuery(params?: {
  userId?: string;
  spaceId?: string;
}) {
  const { userId, spaceId } = params ?? {};
  return useInfiniteQuery({
    queryKey: ["pages-created-by-user", { userId, spaceId }],
    queryFn: ({ pageParam }) =>
      getCreatedByPages({ userId, spaceId, cursor: pageParam, limit: 15 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? lastPage.meta.nextCursor : undefined,
    refetchOnMount: true,
  });
}

export function useDeletedPagesQuery(
  spaceId: string,
  params?: QueryParams,
): UseQueryResult<IPagination<IPage>, Error> {
  return useQuery({
    queryKey: ["trash-list", spaceId, params],
    queryFn: () => getDeletedPages(spaceId, params),
    enabled: !!spaceId,
    placeholderData: keepPreviousData,
    refetchOnMount: true,
    staleTime: 0,
  });
}

/**
 * Invalidate every cached page-subtree (the recursive `subpages` node, issue
 * #150). Called from each tree-structure cache helper below so a create / move /
 * rename / delete (local OR websocket-echoed) refreshes any open recursive tree.
 * Keyed loosely (`["page-tree"]` prefix) so all subtrees are caught.
 */
function invalidatePageTree() {
  queryClient.invalidateQueries({ queryKey: ["page-tree"] });
}

export function invalidateOnCreatePage(data: Partial<IPage>) {
  invalidatePageTree();
  const newPage: Partial<IPage> = {
    creatorId: data.creatorId,
    hasChildren: data.hasChildren,
    icon: data.icon,
    id: data.id,
    parentPageId: data.parentPageId,
    position: data.position,
    slugId: data.slugId,
    spaceId: data.spaceId,
    title: data.title,
    // Carry the death-timer deadline so a note created as temporary keeps its
    // sidebar clock marker when the tree is rebuilt from this cached entry
    // (buildTree → mergeRootTrees). Omitting it overwrote the optimistic/socket
    // node's marker with `undefined`, hiding it until a reload.
    temporaryExpiresAt: data.temporaryExpiresAt,
  };

  let queryKey: QueryKey = null;
  if (data.parentPageId === null) {
    queryKey = ["root-sidebar-pages", data.spaceId];
  } else {
    queryKey = [
      "sidebar-pages",
      { pageId: data.parentPageId, spaceId: data.spaceId },
    ];
  }

  //update all sidebar pages
  queryClient.setQueryData<InfiniteData<IPagination<Partial<IPage>>>>(
    queryKey,
    (old) => {
      if (!old) return old;

      // Idempotency guard: the server now self-echoes addTreeNode back to the
      // author, so this writer can run twice for one create (mutation onSuccess
      // + socket echo). Skip the append if the page is already in the cache to
      // avoid a duplicate node / duplicate React key.
      const exists = old.pages.some((page) =>
        page.items.some((item) => item.id === newPage.id),
      );
      if (exists) return old;

      return {
        ...old,
        pages: old.pages.map((page, index) => {
          if (index === old.pages.length - 1) {
            return {
              ...page,
              items: [...page.items, newPage],
            };
          }
          return page;
        }),
      };
    },
  );

  //update sidebar haschildren
  if (data.parentPageId !== null) {
    //update sub sidebar pages haschildern
    const subSideBarMatches = queryClient.getQueriesData({
      queryKey: ["sidebar-pages"],
      exact: false,
    });

    subSideBarMatches.forEach(([key, d]) => {
      queryClient.setQueryData<InfiniteData<IPagination<IPage>>>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((sidebarPage: IPage) =>
              sidebarPage.id === data.parentPageId
                ? { ...sidebarPage, hasChildren: true }
                : sidebarPage,
            ),
          })),
        };
      });
    });

    //update root sidebar pages haschildern
    const rootSideBarMatches = queryClient.getQueriesData({
      queryKey: ["root-sidebar-pages", data.spaceId],
      exact: false,
    });

    rootSideBarMatches.forEach(([key, d]) => {
      queryClient.setQueryData<InfiniteData<IPagination<IPage>>>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((sidebarPage: IPage) =>
              sidebarPage.id === data.parentPageId
                ? { ...sidebarPage, hasChildren: true }
                : sidebarPage,
            ),
          })),
        };
      });
    });
  }

  //update recent changes
  queryClient.invalidateQueries({
    queryKey: ["recent-changes", data.spaceId],
  });
}

export function invalidateOnUpdatePage(
  spaceId: string,
  parentPageId: string,
  id: string,
  title: string,
  icon: string,
) {
  invalidatePageTree();
  let queryKey: QueryKey = null;
  if (parentPageId === null) {
    queryKey = ["root-sidebar-pages", spaceId];
  } else {
    queryKey = ["sidebar-pages", { pageId: parentPageId, spaceId: spaceId }];
  }
  //update all sidebar pages
  queryClient.setQueryData<InfiniteData<IPagination<IPage>>>(
    queryKey,
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.map((sidebarPage: IPage) =>
            sidebarPage.id === id
              ? { ...sidebarPage, title: title, icon: icon }
              : sidebarPage,
          ),
        })),
      };
    },
  );

  //update recent changes
  queryClient.invalidateQueries({
    queryKey: ["recent-changes", spaceId],
  });
}

export function updateCacheOnMovePage(
  spaceId: string,
  pageId: string,
  oldParentId: string | null,
  newParentId: string | null,
  pageData: Partial<IPage>,
) {
  invalidatePageTree();
  // Remove page from old parent's cache
  const oldQueryKey =
    oldParentId === null
      ? ["root-sidebar-pages", spaceId]
      : ["sidebar-pages", { pageId: oldParentId, spaceId }];

  queryClient.setQueryData<InfiniteData<IPagination<IPage>>>(
    oldQueryKey,
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.filter((item) => item.id !== pageId),
        })),
      };
    },
  );

  // Update old parent's hasChildren flag if it has no more children
  if (oldParentId !== null) {
    const oldParentCache = queryClient.getQueryData<
      InfiniteData<IPagination<IPage>>
    >(["sidebar-pages", { pageId: oldParentId, spaceId }]);

    const remainingChildren =
      oldParentCache?.pages.flatMap((p) => p.items).length ?? 0;

    if (remainingChildren === 0) {
      // Update hasChildren in all caches where old parent appears
      const allSideBarMatches = queryClient.getQueriesData({
        predicate: (query) =>
          query.queryKey[0] === "root-sidebar-pages" ||
          query.queryKey[0] === "sidebar-pages",
      });

      allSideBarMatches.forEach(([key]) => {
        queryClient.setQueryData<InfiniteData<IPagination<IPage>>>(
          key,
          (old) => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === oldParentId
                    ? { ...item, hasChildren: false }
                    : item,
                ),
              })),
            };
          },
        );
      });
    }
  }

  // Add page to new parent's cache
  const newQueryKey =
    newParentId === null
      ? ["root-sidebar-pages", spaceId]
      : ["sidebar-pages", { pageId: newParentId, spaceId }];

  queryClient.setQueryData<InfiniteData<IPagination<Partial<IPage>>>>(
    newQueryKey,
    (old) => {
      if (!old) return old;

      // Check if page already exists in new location
      const exists = old.pages.some((page) =>
        page.items.some((item) => item.id === pageId),
      );
      if (exists) return old;

      return {
        ...old,
        pages: old.pages.map((page, index) => {
          if (index === old.pages.length - 1) {
            return {
              ...page,
              items: [...page.items, pageData],
            };
          }
          return page;
        }),
      };
    },
  );

  // Update new parent's hasChildren flag
  if (newParentId !== null) {
    const allSideBarMatches = queryClient.getQueriesData({
      predicate: (query) =>
        query.queryKey[0] === "root-sidebar-pages" ||
        query.queryKey[0] === "sidebar-pages",
    });

    allSideBarMatches.forEach(([key]) => {
      queryClient.setQueryData<InfiniteData<IPagination<IPage>>>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              item.id === newParentId ? { ...item, hasChildren: true } : item,
            ),
          })),
        };
      });
    });
  }
}

export function invalidateOnDeletePage(pageId: string) {
  invalidatePageTree();
  //update all sidebar pages
  const allSideBarMatches = queryClient.getQueriesData({
    predicate: (query) =>
      query.queryKey[0] === "root-sidebar-pages" ||
      query.queryKey[0] === "sidebar-pages",
  });

  allSideBarMatches.forEach(([key, d]) => {
    queryClient.setQueryData<InfiniteData<IPagination<IPage>>>(key, (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.filter(
            (sidebarPage: IPage) => sidebarPage.id !== pageId,
          ),
        })),
      };
    });
  });

  //update recent changes
  queryClient.invalidateQueries({
    queryKey: ["recent-changes"],
  });
}
