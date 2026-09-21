import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { computeBreadcrumbState } from "./breadcrumb.utils";
import { findBreadcrumbPath } from "@/features/page/tree/utils";
import {
  Button,
  Anchor,
  Popover,
  Breadcrumbs,
  ActionIcon,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconCornerDownRightDouble, IconDots } from "@tabler/icons-react";
import { Link, useParams } from "react-router-dom";
import classes from "./breadcrumb.module.css";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { IPage } from "@/features/page/types/page.types.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import {
  usePageMetaQuery,
  usePageBreadcrumbsQuery,
} from "@/features/page/queries/page-query.ts";
import { extractPageSlugId } from "@/lib";
import { useCachedPageMeta } from "@/features/page/atoms/page-meta-cache-atom";
import { useMediaQuery } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { PageIcon } from "@/components/ui/page-icon.tsx";
import { parseIconRef } from "@/lib/icon-ref.ts";

function getTitle(name: string, icon: string | null | undefined) {
  // Render the Lucide glyph only when a valid IconRef is set (breadcrumb nodes
  // without an icon stay text-only, as before); a legacy/invalid value shows no
  // glyph rather than leaking raw JSON.
  if (parseIconRef(icon)) {
    return (
      <>
        <PageIcon value={icon} size={16} />
        <span style={{ marginLeft: 4 }}>{name}</span>
      </>
    );
  }
  return name;
}

/**
 * Equality over a breadcrumb chain by the only fields the breadcrumb renders
 * (id, slugId, name, icon). Lets the selectAtom below hand back the SAME
 * reference when an unrelated tree mutation leaves THIS page's ancestor chain
 * visually unchanged, so the breadcrumb no longer re-renders on every tree
 * event (it previously subscribed to the whole treeDataAtom).
 */
export function breadcrumbPathEqual(
  a: SpaceTreeNode[] | null,
  b: SpaceTreeNode[] | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].slugId !== b[i].slugId ||
      a[i].name !== b[i].name ||
      a[i].icon !== b[i].icon
    ) {
      return false;
    }
  }
  return true;
}

export default function Breadcrumb() {
  const { t } = useTranslation();
  const [breadcrumbNodes, setBreadcrumbNodes] = useState<
    SpaceTreeNode[] | null
  >(null);
  const { pageSlug, spaceSlug } = useParams();
  const pageSlugId = extractPageSlugId(pageSlug);
  const { data: currentPage } = usePageMetaQuery({
    pageId: pageSlugId,
  });
  // #563 — local-first phase 1: on a reload the page query has not resolved yet,
  // so fall back to the synchronously-read boot cache to learn the page id. That
  // is all the breadcrumb needs to derive its chain from the (equally
  // boot-cached) sidebar tree, so the crumbs paint with the rest of the chrome
  // instead of after the round-trip. The live query wins as soon as it lands.
  const cachedMeta = useCachedPageMeta(pageSlugId);
  // `placeholderData: keepPreviousData` means `currentPage` can still hold the
  // PREVIOUS page while we navigate into this one, so it only counts as live data
  // for THIS page when its identifiers match the URL (same guard as page.tsx).
  // Otherwise the cached entry — which IS this page's — drives the crumbs.
  const livePage =
    currentPage &&
    (currentPage.slugId === pageSlugId || currentPage.id === pageSlugId)
      ? currentPage
      : undefined;
  const currentPageMeta = livePage ?? cachedMeta;
  const currentPageId = currentPageMeta?.id;
  // The page's own ancestor chain, fetched independently of the lazily-built
  // sidebar tree so a deep page doesn't render a blank breadcrumb for seconds
  // while the tree backfills (#218).
  const { data: ancestors } = usePageBreadcrumbsQuery(currentPageId);
  const isMobile = useMediaQuery("(max-width: 48em)");

  // Narrowed subscription: instead of subscribing to the whole treeDataAtom and
  // recomputing on every tree event, derive ONLY the current page's ancestor
  // chain. The custom equality returns the previous reference when that chain is
  // visually unchanged, so an unrelated tree mutation no longer re-renders this
  // component. Mirrors computeBreadcrumbState's tree-hit branch
  // (findBreadcrumbPath); the tree-miss/ancestors fallback is applied below.
  const treePathAtom = useMemo(
    () =>
      selectAtom(
        treeDataAtom,
        (tree): SpaceTreeNode[] | null =>
          currentPageId ? findBreadcrumbPath(tree, currentPageId) : null,
        breadcrumbPathEqual,
      ),
    [currentPageId],
  );
  const treePath = useAtomValue(treePathAtom);

  useEffect(() => {
    if (!currentPageMeta) return;

    // Selection/mapping + stale-clearing live in a pure, unit-tested helper
    // (#218). The tree-hit chain (treePath) always wins when present; otherwise
    // fall back to the page's own ancestors and the stale-clearing logic — this
    // reproduces computeBreadcrumbState(fullTree, ancestors, …) exactly, since
    // its tree-hit branch is precisely findBreadcrumbPath(fullTree, pageId).
    setBreadcrumbNodes((previous) =>
      treePath ??
      computeBreadcrumbState(
        null,
        ancestors as IPage[] | undefined,
        currentPageMeta.id,
        previous,
      ),
    );
  }, [currentPageMeta?.id, treePath, ancestors]);

  const HiddenNodesTooltipContent = () =>
    breadcrumbNodes?.slice(1, -1).map((node) => (
      <Button.Group orientation="vertical" key={node.id}>
        <Button
          justify="start"
          component={Link}
          to={buildPageUrl(spaceSlug, node.slugId, node.name)}
          variant="default"
          style={{ border: "none" }}
        >
          <Text fz={"sm"} className={classes.truncatedText}>
            {getTitle(node.name, node.icon)}
          </Text>
        </Button>
      </Button.Group>
    ));

  const MobileHiddenNodesTooltipContent = () =>
    breadcrumbNodes?.map((node) => (
      <Button.Group orientation="vertical" key={node.id}>
        <Button
          justify="start"
          component={Link}
          to={buildPageUrl(spaceSlug, node.slugId, node.name)}
          variant="default"
          style={{ border: "none" }}
        >
          <Text fz={"sm"} className={classes.truncatedText}>
            {getTitle(node.name, node.icon)}
          </Text>
        </Button>
      </Button.Group>
    ));

  const renderAnchor = useCallback(
    (node: SpaceTreeNode, isCurrent = false) => (
      <Tooltip label={node.name} key={node.id}>
        <Anchor
          component={Link}
          to={buildPageUrl(spaceSlug, node.slugId, node.name)}
          underline="never"
          fz="sm"
          key={node.id}
          className={classes.truncatedText}
          aria-current={isCurrent ? "page" : undefined}
        >
          {getTitle(node.name, node.icon)}
        </Anchor>
      </Tooltip>
    ),
    [spaceSlug],
  );

  const getBreadcrumbItems = () => {
    if (!breadcrumbNodes) return [];

    if (breadcrumbNodes.length > 3) {
      const firstNode = breadcrumbNodes[0];
      //const secondLastNode = breadcrumbNodes[breadcrumbNodes.length - 2];
      const lastNode = breadcrumbNodes[breadcrumbNodes.length - 1];

      return [
        renderAnchor(firstNode),
        <Popover
          width={250}
          position="bottom"
          withArrow
          shadow="xl"
          key="hidden-nodes"
        >
          <Popover.Target>
            <ActionIcon
              color="gray"
              variant="transparent"
              aria-label={t("Show hidden breadcrumbs")}
            >
              <IconDots size={20} stroke={2} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <HiddenNodesTooltipContent />
          </Popover.Dropdown>
        </Popover>,
        //renderAnchor(secondLastNode),
        renderAnchor(lastNode, true),
      ];
    }

    return breadcrumbNodes.map((node, i) =>
      renderAnchor(node, i === breadcrumbNodes.length - 1),
    );
  };

  const getMobileBreadcrumbItems = () => {
    if (!breadcrumbNodes) return [];

    if (breadcrumbNodes.length > 0) {
      return [
        <Popover
          width={250}
          position="bottom"
          withArrow
          shadow="xl"
          key="mobile-hidden-nodes"
        >
          <Popover.Target>
            <Tooltip label={t("Breadcrumbs")}>
              <ActionIcon
                color="gray"
                variant="transparent"
                aria-label={t("Breadcrumbs")}
              >
                <IconCornerDownRightDouble size={20} stroke={2} />
              </ActionIcon>
            </Tooltip>
          </Popover.Target>
          <Popover.Dropdown>
            <MobileHiddenNodesTooltipContent />
          </Popover.Dropdown>
        </Popover>,
      ];
    }

    return breadcrumbNodes.map((node, i) =>
      renderAnchor(node, i === breadcrumbNodes.length - 1),
    );
  };

  return (
    <nav aria-label={t("Breadcrumb")} className={classes.breadcrumbDiv}>
      {breadcrumbNodes && (
        <Breadcrumbs className={classes.breadcrumbs}>
          {isMobile ? getMobileBreadcrumbItems() : getBreadcrumbItems()}
        </Breadcrumbs>
      )}
    </nav>
  );
}
