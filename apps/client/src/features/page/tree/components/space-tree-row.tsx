import { useRef } from "react";
import { Link, useParams } from "react-router-dom";
import {
  markOperationStart,
  measureOperation,
} from "@/lib/telemetry/vitals";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { ActionIcon, rem, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconChevronDown,
  IconChevronRight,
  IconClockHour4,
  IconLink,
  IconPlus,
  IconPointFilled,
  IconTemplate,
  IconTrash,
} from "@tabler/icons-react";

import { PageIconPicker } from "@/components/ui/page-icon.tsx";
import { queryClient } from "@/main.tsx";
import { useClipboard } from "@/hooks/use-clipboard";
import { getAppUrl } from "@/lib/config.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { getPageById } from "@/features/page/services/page-service.ts";
import {
  useUpdatePageMutation,
  fetchAllAncestorChildren,
} from "@/features/page/queries/page-query.ts";
import { useQueryEmit } from "@/features/websocket/use-query-emit.ts";
import { mobileSidebarAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts";

import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation.ts";
import type { SpaceTreeNode } from "@/features/page/tree/types.ts";
import type { RenderRowProps } from "./doc-tree";
import { NodeMenu } from "./space-tree-node-menu";
import classes from "@/features/page/tree/styles/tree.module.css";
import { updateTreeNodeIcon } from "@/features/page/tree/utils/utils.ts";

type SpaceTreeRowProps = RenderRowProps<SpaceTreeNode> & {
  readOnly: boolean;
  /** Page-icon tile size for the current tree density (see TREE_ICON_SIZE_*). */
  iconSize: number;
};

export function SpaceTreeRow({
  node,
  isOpen,
  hasChildren,
  toggleOpen,
  rowRef,
  tabIndex,
  treeItemProps,
  readOnly,
  iconSize,
}: SpaceTreeRowProps) {
  const { t } = useTranslation();
  const { spaceSlug } = useParams();
  const updatePageMutation = useUpdatePageMutation();
  // Setter-only: subscribing to the whole treeDataAtom (via useAtom) re-rendered
  // every virtualized row on any tree event, bypassing the DocTreeRow memo. This
  // row never reads the tree value, only writes it, so useSetAtom avoids the
  // value subscription.
  const setTreeData = useSetAtom(treeDataAtom);
  const emit = useQueryEmit();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mobileSidebarOpened] = useAtom(mobileSidebarAtom);
  const toggleMobileSidebar = useToggleSidebar(mobileSidebarAtom);
  const workspace = useAtomValue(workspaceAtom);

  // Workspace toggle for the row quick-action icons. ABSENT => ON (default),
  // because the icons already shipped — so compare against `false` rather than
  // testing for an explicit `true`. The "⋮" menu keeps both actions either way.
  const quickActionsEnabled = workspace?.settings?.treeQuickActions !== false;

  const canEdit = !readOnly && node.canEdit !== false;
  const pageUrl = buildPageUrl(spaceSlug, node.slugId, node.name);

  const prefetchPage = () => {
    timerRef.current = setTimeout(async () => {
      const page = await queryClient.fetchQuery({
        queryKey: ["pages", node.id],
        queryFn: () => getPageById({ pageId: node.id }),
        staleTime: 5 * 60 * 1000,
      });
      if (page?.slugId) {
        queryClient.setQueryData(["pages", page.slugId], page);
      }
    }, 150);
  };

  const cancelPagePrefetch = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleUpdateNodeIcon = (nodeId: string, newIcon: string | null) => {
    setTreeData((prev) =>
      updateTreeNodeIcon(prev, nodeId, newIcon),
    );
  };

  const handleEmojiIconClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // The picker hands back the serialized IconRef JSON (see icon-ref.ts). The
  // optimistic tree update and the mutation store the string as-is.
  const handleIconSelect = (icon: string) => {
    handleUpdateNodeIcon(node.id, icon);
    updatePageMutation
      .mutateAsync({ pageId: node.id, icon })
      .then((data) => {
        setTimeout(() => {
          emit({
            operation: "updateOne",
            spaceId: node.spaceId,
            entity: ["pages"],
            id: node.id,
            payload: { icon, parentPageId: data.parentPageId },
          });
        }, 50);
      });
  };

  const handleRemoveEmoji = () => {
    handleUpdateNodeIcon(node.id, null);
    updatePageMutation.mutateAsync({ pageId: node.id, icon: null });

    setTimeout(() => {
      emit({
        operation: "updateOne",
        spaceId: node.spaceId,
        entity: ["pages"],
        id: node.id,
        payload: { icon: null },
      });
    }, 50);
  };

  const handleLoadChildren = async () => {
    if (!node.hasChildren) return;
    // #683 `tree_expand` — mark at the expand action; measured once the children
    // are appended and rendered (double-rAF render → paint). A cache-hit expand
    // is ~0ms and is dropped by the report threshold; a failed fetch measures
    // nothing (the mark expires). Includes network on a cold expand — honest, the
    // user waits for children to appear.
    markOperationStart("tree_expand");
    try {
      const childrenTree = await fetchAllAncestorChildren({
        pageId: node.id,
        spaceId: node.spaceId,
      });
      setTreeData((prev) =>
        treeModel.appendChildren(prev, node.id, childrenTree),
      );
      try {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => measureOperation("tree_expand")),
        );
      } catch {
        measureOperation("tree_expand");
      }
    } catch (error) {
      console.error("Failed to fetch children:", error);
    }
  };

  return (
    <Link
      ref={rowRef as React.Ref<HTMLAnchorElement>}
      to={pageUrl}
      className={classes.node}
      tabIndex={tabIndex}
      {...treeItemProps}
      onClick={() => {
        if (mobileSidebarOpened) {
          toggleMobileSidebar();
        }
      }}
      onMouseEnter={prefetchPage}
      onMouseLeave={cancelPagePrefetch}
    >
      <PageArrow
        isOpen={isOpen}
        hasChildren={hasChildren}
        onToggle={toggleOpen}
      />

      <div onClick={handleEmojiIconClick} style={{ marginRight: "4px" }}>
        {/* The trigger ActionIcon is sized to the glyph on purpose: its default
            (Mantine `md`, 28px) is taller than a 26px compact row, leaves a wide
            dead gap between the icon and the title, and overlaps the
            neighbouring rows' hit areas. PageIconPicker derives the button's own
            border box from `size`. */}
        <PageIconPicker
          value={node.icon}
          onChange={handleIconSelect}
          onRemove={handleRemoveEmoji}
          readOnly={!canEdit}
          size={iconSize}
          actionIconProps={{ tabIndex: -1 }}
        />
      </div>

      <span className={classes.text}>{node.name || t("Untitled")}</span>

      {node.isTemplate === true && (
        <Tooltip label={t("Template")} withArrow>
          <IconTemplate
            size={14}
            stroke={1.5}
            // Visual-only indicator: subtle and never shrinks. Pointer events
            // stay enabled so the Tooltip's hover handlers fire; clicks fall
            // through to the row link since no stopPropagation is used.
            style={{
              flexShrink: 0,
              marginLeft: rem(4),
              color: "var(--mantine-color-dimmed)",
            }}
            aria-label={t("Template")}
            role="img"
          />
        </Tooltip>
      )}

      {node.temporaryExpiresAt && (
        <Tooltip
          // Children ride along to trash with the note (recursive removePage).
          label={t("Temporary note — moves to trash unless made permanent")}
          withArrow
        >
          <IconClockHour4
            size={14}
            stroke={1.5}
            // Same visual-only indicator pattern as the template icon, but
            // orange to flag the impending death timer.
            style={{
              flexShrink: 0,
              marginLeft: rem(4),
              color: "var(--mantine-color-orange-6)",
            }}
            aria-label={t("Temporary note")}
            role="img"
          />
        </Tooltip>
      )}

      <div className={classes.actions}>
        {quickActionsEnabled && <CopyLinkNode node={node} />}

        {quickActionsEnabled && canEdit && <DeleteNode node={node} />}

        <NodeMenu node={node} canEdit={canEdit} />

        {canEdit && (
          <CreateNode
            node={node}
            isOpen={isOpen}
            hasChildren={hasChildren}
            onToggle={toggleOpen}
            onExpandTree={handleLoadChildren}
          />
        )}
      </div>
    </Link>
  );
}

interface PageArrowProps {
  isOpen: boolean;
  hasChildren: boolean;
  onToggle: () => void;
}

function PageArrow({ isOpen, hasChildren, onToggle }: PageArrowProps) {
  const { t } = useTranslation();

  if (!hasChildren) {
    return (
      <span
        aria-hidden
        className={classes.actionIcon}
        style={{
          width: 20,
          height: 20,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <IconPointFilled size={8} />
      </span>
    );
  }

  return (
    <ActionIcon
      size={20}
      variant="subtle"
      color="gray"
      className={classes.actionIcon}
      aria-label={isOpen ? t("Collapse") : t("Expand")}
      aria-expanded={isOpen}
      tabIndex={-1}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
    >
      {isOpen ? (
        <IconChevronDown stroke={2} size={18} />
      ) : (
        <IconChevronRight stroke={2} size={18} />
      )}
    </ActionIcon>
  );
}

interface CreateNodeProps {
  node: SpaceTreeNode;
  isOpen: boolean;
  hasChildren: boolean;
  onToggle: () => void;
  onExpandTree: () => Promise<void> | void;
}

function CreateNode({
  node,
  isOpen,
  hasChildren,
  onToggle,
  onExpandTree,
}: CreateNodeProps) {
  const { t } = useTranslation();
  const { handleCreate } = useTreeMutation(node.spaceId);

  async function handleClickCreate() {
    if (node.hasChildren && !hasChildren) {
      // Expand and lazy-load before creating a child. handleCreate reads the
      // latest tree imperatively (via useStore) so we no longer need a
      // setTimeout to wait for React to rerun the closure with fresh data.
      if (!isOpen) onToggle();
      await onExpandTree();
    } else if (!isOpen) {
      onToggle();
    }
    handleCreate(node.id);
  }

  return (
    <ActionIcon
      size={20}
      variant="subtle"
      color="gray"
      className={classes.actionIcon}
      aria-label={t("Create subpage of {{name}}", { name: node.name || t("Untitled") })}
      tabIndex={-1}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleClickCreate();
      }}
    >
      <IconPlus style={{ width: rem(20), height: rem(20) }} stroke={2} />
    </ActionIcon>
  );
}

interface RowActionProps {
  node: SpaceTreeNode;
}

// Row shortcut for the NodeMenu "Copy link" item. The URL is built exactly as
// the menu builds it, so both entry points copy the same absolute page link.
function CopyLinkNode({ node }: RowActionProps) {
  const { t } = useTranslation();
  const { spaceSlug } = useParams();
  const clipboard = useClipboard({ timeout: 500 });

  const handleCopyLink = () => {
    const pageUrl =
      getAppUrl() + buildPageUrl(spaceSlug, node.slugId, node.name);
    clipboard.copy(pageUrl);
    notifications.show({ message: t("Link copied") });
  };

  return (
    <ActionIcon
      size={20}
      variant="subtle"
      color="gray"
      className={classes.actionIcon}
      aria-label={t("Copy link")}
      tabIndex={-1}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleCopyLink();
      }}
    >
      <IconLink style={{ width: rem(18), height: rem(18) }} stroke={2} />
    </ActionIcon>
  );
}

// Row shortcut for the NodeMenu "Move to trash" item. Unconfirmed on purpose —
// it mirrors the menu item, which also deletes straight away, and the page is
// recoverable from trash.
function DeleteNode({ node }: RowActionProps) {
  const { t } = useTranslation();
  const { handleDelete } = useTreeMutation(node.spaceId);

  return (
    <ActionIcon
      size={20}
      variant="subtle"
      color="gray"
      className={`${classes.actionIcon} ${classes.actionIconDanger}`}
      aria-label={t("Move to trash")}
      tabIndex={-1}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleDelete(node.id);
      }}
    >
      <IconTrash style={{ width: rem(18), height: rem(18) }} stroke={2} />
    </ActionIcon>
  );
}
