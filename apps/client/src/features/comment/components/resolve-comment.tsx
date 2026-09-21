import { ActionIcon, Tooltip } from "@mantine/core";
import { IconCircleCheck, IconCircleCheckFilled } from "@tabler/icons-react";
import { useResolveCommentMutation } from "@/features/comment/queries/comment-query";
import { useTranslation } from "react-i18next";
import { Editor } from "@tiptap/react";
import { useBodyWriteBlocked } from "@/features/editor/hooks/use-body-write-blocked";

interface ResolveCommentProps {
  editor: Editor | null;
  commentId: string;
  pageId: string;
  resolvedAt?: Date;
}

function ResolveComment({
  editor,
  commentId,
  pageId,
  resolvedAt,
}: ResolveCommentProps) {
  const { t } = useTranslation();
  const resolveCommentMutation = useResolveCommentMutation();
  const { refuseIfBlocked } = useBodyWriteBlocked();

  const isResolved = resolvedAt != null;

  const handleResolveToggle = async () => {
    // #564 — refuse BEFORE the mutation: in the local-first read-only window the
    // `setCommentResolved` mark update below is dropped by the body write guard,
    // so going ahead would flip the comment server-side while the document kept
    // showing the old state.
    if (refuseIfBlocked()) return;
    try {
      await resolveCommentMutation.mutateAsync({
        commentId,
        pageId,
        resolved: !isResolved,
      });

      if (editor) {
        editor.commands.setCommentResolved(commentId, !isResolved);
      }
    } catch (error) {
      console.error("Failed to toggle resolved state:", error);
    }
  };

  return (
    <Tooltip
      label={isResolved ? t("Re-open comment") : t("Resolve comment")}
      position="top"
    >
      <ActionIcon
        onClick={handleResolveToggle}
        variant="subtle"
        color={isResolved ? "green" : "gray"}
        size="sm"
        loading={resolveCommentMutation.isPending}
        disabled={resolveCommentMutation.isPending}
      >
        {isResolved ? (
          <IconCircleCheckFilled size={18} />
        ) : (
          <IconCircleCheck size={18} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}

export default ResolveComment;
