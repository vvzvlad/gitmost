import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { ActionIcon, Anchor, Text } from "@mantine/core";
import { IconFileDescription } from "@tabler/icons-react";
import { PageIcon } from "@/components/ui/page-icon.tsx";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { usePageMetaQuery } from "@/features/page/queries/page-query.ts";
import { useSharePageQuery } from "@/features/share/queries/share-query.ts";
import {
  buildPageUrl,
  buildSharedPageUrl,
} from "@/features/page/page.utils.ts";
import { extractPageSlugId } from "@/lib";
import classes from "./mention.module.css";

interface MentionAttrs {
  label?: string;
  entityType?: string;
  entityId?: string;
  slugId?: string;
  anchorId?: string;
}

// Presentational mention renderer (no NodeViewWrapper). Shared by the editor
// NodeView (MentionView) and the static comment renderer (CommentContentView)
// so mention click/nav/icon behavior stays identical outside of an editor.
export function MentionContent({ attrs }: { attrs: MentionAttrs }) {
  const { label, entityType, slugId, anchorId } = attrs;
  const isPageMention = entityType === "page";
  const { spaceSlug, pageSlug } = useParams();
  const { shareId } = useParams();
  const navigate = useNavigate();

  const location = useLocation();
  const isShareRoute = location.pathname.startsWith("/share");

  const {
    data: page,
    isLoading,
    isError,
  } = usePageMetaQuery({ pageId: isPageMention && !isShareRoute ? slugId : null });

  const { data: sharedPage } = useSharePageQuery({
    pageId: isPageMention && isShareRoute ? slugId : undefined,
  });

  const currentPageSlugId = extractPageSlugId(pageSlug);
  const isSamePage = currentPageSlugId === slugId;

  const handleClick = (e: React.MouseEvent) => {
    if (isSamePage && anchorId) {
      e.preventDefault();
      const element = document.querySelector(`[id="${anchorId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "start" });
        navigate(`#${anchorId}`, { replace: true });
      }
    }
  };

  const sharePageTitle = sharedPage?.page?.title || label;

  const shareSlugUrl = buildSharedPageUrl({
    shareId,
    pageSlugId: slugId,
    pageTitle: sharePageTitle,
    anchorId,
  });

  return (
    <>
      {entityType === "user" && (
        <Text className={classes.userMention} component="span">
          @{label}
        </Text>
      )}

      {isPageMention && isShareRoute && (
        <Anchor
          component={Link}
          fw={500}
          to={shareSlugUrl}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
        >
          <ActionIcon
            variant="transparent"
            color="gray"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            <IconFileDescription size={18} />
          </ActionIcon>
          <span className={classes.pageMentionText}>
            {sharePageTitle}
          </span>
        </Anchor>
      )}

      {isPageMention && !isShareRoute && isError && (
        <Anchor
          component={Link}
          fw={500}
          to={buildPageUrl(spaceSlug, slugId, label, anchorId)}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
        >
          <ActionIcon
            variant="transparent"
            color="gray"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            <IconFileDescription size={18} />
          </ActionIcon>
          <span className={classes.pageMentionText}>
            {label}
          </span>
        </Anchor>
      )}

      {isPageMention && !isShareRoute && !isError && (
        <Anchor
          component={Link}
          fw={500}
          to={buildPageUrl(page?.space?.slug || spaceSlug, slugId, page?.title || label, anchorId)}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
        >
          <span
            style={{ marginRight: "4px", verticalAlign: "text-bottom" }}
          >
            <PageIcon value={page?.icon} size={18} />
          </span>

          <span className={classes.pageMentionText}>
            {page?.title || label}
          </span>
        </Anchor>
      )}
    </>
  );
}

export default function MentionView(props: NodeViewProps) {
  return (
    <NodeViewWrapper style={{ display: "inline" }} data-drag-handle>
      <MentionContent attrs={props.node.attrs} />
    </NodeViewWrapper>
  );
}
