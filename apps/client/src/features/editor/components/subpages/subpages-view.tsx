import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { Stack, Text, Anchor, ActionIcon } from "@mantine/core";
import { IconFileDescription } from "@tabler/icons-react";
import {
  useGetSidebarPagesQuery,
  useGetPageTreeQuery,
} from "@/features/page/queries/page-query";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import classes from "./subpages.module.css";
import styles from "../mention/mention.module.css";
import {
  buildPageUrl,
  buildSharedPageUrl,
} from "@/features/page/page.utils.ts";
import { useTranslation } from "react-i18next";
import { sortPositionKeys } from "@/features/page/tree/utils/utils";
import {
  useSharedPageSubpages,
  useSharedPageSubtree,
} from "@/features/share/hooks/use-shared-page-subpages";
import {
  SubpageNode,
  buildSubtree,
  mapSharedNodes,
  countNodes,
} from "./subpages-view.utils";

// Threshold above which the recursive tree shows a small count note. We never
// cap the data — this is only an informational hint for very large trees.
const LARGE_TREE_THRESHOLD = 300;

interface TreeNodeProps {
  node: SubpageNode;
  depth: number;
  shareId?: string;
  spaceSlug?: string;
  // Threaded down from the variant component so a large tree does not create one
  // i18n subscription (useTranslation) per rendered node.
  t: (key: string) => string;
}

// Recursive renderer for a single node and its descendants. Indents each level
// by depth * 16px and reuses the same link/icon markup as the flat list.
function TreeNode({ node, depth, shareId, spaceSlug, t }: TreeNodeProps) {
  return (
    <>
      <Anchor
        component={Link}
        fw={500}
        to={
          shareId
            ? buildSharedPageUrl({
                shareId,
                pageSlugId: node.slugId,
                pageTitle: node.title,
              })
            : buildPageUrl(spaceSlug, node.slugId, node.title)
        }
        underline="never"
        className={styles.pageMentionLink}
        draggable={false}
        style={{ paddingLeft: depth * 16 }}
      >
        {node?.icon ? (
          <span style={{ marginRight: "4px" }}>{node.icon}</span>
        ) : (
          <ActionIcon
            variant="transparent"
            color="gray"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            <IconFileDescription size={18} />
          </ActionIcon>
        )}

        <span className={styles.pageMentionText}>
          {node?.title || t("untitled")}
        </span>
      </Anchor>

      {node.children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          shareId={shareId}
          spaceSlug={spaceSlug}
          t={t}
        />
      ))}
    </>
  );
}

export default function SubpagesView(props: NodeViewProps) {
  const { editor } = props;
  const { spaceSlug, shareId } = useParams();
  const { t } = useTranslation();

  const recursive: boolean = props.node.attrs.recursive ?? false;

  //@ts-ignore
  const currentPageId = editor.storage.pageId;

  if (recursive) {
    return (
      <RecursiveSubpages
        currentPageId={currentPageId}
        shareId={shareId}
        spaceSlug={spaceSlug}
        t={t}
      />
    );
  }

  return (
    <FlatSubpages
      currentPageId={currentPageId}
      shareId={shareId}
      spaceSlug={spaceSlug}
      t={t}
    />
  );
}

interface SubpagesVariantProps {
  currentPageId: string;
  shareId?: string;
  spaceSlug?: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function FlatSubpages({
  currentPageId,
  shareId,
  spaceSlug,
  t,
}: SubpagesVariantProps) {
  // Get subpages from shared tree if we're in a shared context
  const sharedSubpages = useSharedPageSubpages(currentPageId);

  const { data, isLoading, error } = useGetSidebarPagesQuery(
    shareId ? null : { pageId: currentPageId },
  );

  const subpages = useMemo(() => {
    // If we're in a shared context, use the shared subpages
    if (shareId && sharedSubpages) {
      return sharedSubpages.map((node) => ({
        id: node.value,
        slugId: node.slugId,
        title: node.name,
        icon: node.icon,
        position: node.position,
      }));
    }

    // Otherwise use the API data
    if (!data?.pages) return [];
    const allPages = data.pages.flatMap((page) => page.items);
    return sortPositionKeys(allPages);
  }, [data, shareId, sharedSubpages]);

  if (isLoading && !shareId) {
    return null;
  }

  if (error && !shareId) {
    return (
      <NodeViewWrapper data-drag-handle>
        <Text c="dimmed" size="md" py="md">
          {t("Failed to load subpages")}
        </Text>
      </NodeViewWrapper>
    );
  }

  if (subpages.length === 0) {
    return (
      <NodeViewWrapper data-drag-handle>
        <div className={classes.container}>
          <Text c="dimmed" size="md" py="md">
            {t("No subpages")}
          </Text>
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper data-drag-handle>
      <div className={classes.container}>
        <Stack gap={5}>
          {subpages.map((page) => (
            <Anchor
              key={page.id}
              component={Link}
              fw={500}
              to={
                shareId
                  ? buildSharedPageUrl({
                      shareId,
                      pageSlugId: page.slugId,
                      pageTitle: page.title,
                    })
                  : buildPageUrl(spaceSlug, page.slugId, page.title)
              }
              underline="never"
              className={styles.pageMentionLink}
              draggable={false}
            >
              {page?.icon ? (
                <span style={{ marginRight: "4px" }}>{page.icon}</span>
              ) : (
                <ActionIcon
                  variant="transparent"
                  color="gray"
                  component="span"
                  size={18}
                  style={{ verticalAlign: "text-bottom" }}
                >
                  <IconFileDescription size={18} />
                </ActionIcon>
              )}

              <span className={styles.pageMentionText}>
                {page?.title || t("untitled")}
              </span>
            </Anchor>
          ))}
        </Stack>
      </div>
    </NodeViewWrapper>
  );
}

function RecursiveSubpages({
  currentPageId,
  shareId,
  spaceSlug,
  t,
}: SubpagesVariantProps) {
  // In a shared/public context reuse the already-loaded nested shared tree
  // instead of issuing a /pages/tree request.
  const sharedSubtree = useSharedPageSubtree(currentPageId);

  const { data, isLoading, error } = useGetPageTreeQuery(
    shareId ? "" : currentPageId,
  );

  const tree = useMemo<SubpageNode[]>(() => {
    if (shareId) {
      return mapSharedNodes(sharedSubtree);
    }
    if (!data) return [];
    return buildSubtree(data, currentPageId);
  }, [data, shareId, sharedSubtree, currentPageId]);

  const total = useMemo(() => countNodes(tree), [tree]);

  if (isLoading && !shareId) {
    return null;
  }

  if (error && !shareId) {
    return (
      <NodeViewWrapper data-drag-handle>
        <Text c="dimmed" size="md" py="md">
          {t("Failed to load subpages")}
        </Text>
      </NodeViewWrapper>
    );
  }

  if (tree.length === 0) {
    return (
      <NodeViewWrapper data-drag-handle>
        <div className={classes.container}>
          <Text c="dimmed" size="md" py="md">
            {t("No subpages")}
          </Text>
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper data-drag-handle>
      <div className={classes.container}>
        <Stack gap={5}>
          {tree.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              shareId={shareId}
              spaceSlug={spaceSlug}
              t={t}
            />
          ))}
        </Stack>
        {total > LARGE_TREE_THRESHOLD && (
          <Text c="dimmed" size="xs" pt="xs">
            {t("Showing {{count}} subpages", { count: total })}
          </Text>
        )}
      </div>
    </NodeViewWrapper>
  );
}
