import { Group, Text, Box } from "@mantine/core";
import { AgentAvatarStack } from "@/components/ui/agent-avatar-stack.tsx";
import React, { useRef, useState } from "react";
import classes from "./comment.module.css";
import { useAtom, useAtomValue } from "jotai";
import { useTimeAgo } from "@/hooks/use-time-ago";
import CommentEditor from "@/features/comment/components/comment-editor";
import CommentContentView from "@/features/comment/components/comment-content-view";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms";
import CommentActions from "@/features/comment/components/comment-actions";
import CommentMenu from "@/features/comment/components/comment-menu";
import ResolveComment from "@/features/comment/components/resolve-comment";
import { useHover } from "@mantine/hooks";
import {
  useDeleteCommentMutation,
  useResolveCommentMutation,
  useUpdateCommentMutation,
} from "@/features/comment/queries/comment-query";
import { IComment } from "@/features/comment/types/comment.types";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useTranslation } from "react-i18next";
import { useBodyWriteBlocked } from "@/features/editor/hooks/use-body-write-blocked";

interface CommentListItemProps {
  comment: IComment;
  pageId: string;
  canComment: boolean;
  // Real page-edit permission (page.permissions.canEdit). Kept on the props for
  // parity with the container's wiring even though the thread row itself no
  // longer renders the suggestion Apply button (that moved to AgentEditCard).
  canEdit?: boolean;
  userSpaceRole?: string;
}

// Type B — the thread ROW. Renders a single human OR agent-without-edit comment
// in the redesigned visual: provenance avatar, author + timeago, hover-revealed
// resolve + edit/delete menu, the anchored selection quote, and the body through
// the static CommentContentView (or the inline TipTap editor while editing). It
// is used for both a top-level thread comment and, recursively, each reply row.
// ALL wiring (update/delete/resolve mutations, owner/admin gate, anchor nav) is
// the same logic the old row carried — only the presentation changed, and the
// agent suggested-edit block was lifted out into AgentEditCard.
function CommentListItem({
  comment,
  pageId,
  canComment,
  canEdit,
  userSpaceRole,
}: CommentListItemProps) {
  const { t } = useTranslation();
  const { hovered, ref } = useHover();
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const editor = useAtomValue(pageEditorAtom);
  const editContentRef = useRef<any>(null);
  const updateCommentMutation = useUpdateCommentMutation();
  const deleteCommentMutation = useDeleteCommentMutation(comment.pageId);
  const resolveCommentMutation = useResolveCommentMutation();
  const [currentUser] = useAtom(currentUserAtom);
  const createdAtAgo = useTimeAgo(comment.createdAt);
  // #564 — both handlers below pair a server mutation with an in-document mark
  // update (unsetComment / setCommentResolved). In the local-first read-only
  // window that mark update is dropped by the body write guard, so the pair must
  // refuse as a whole rather than commit the server half alone.
  const { refuseIfBlocked } = useBodyWriteBlocked();

  // `canEdit`/`pageId` are threaded through for wiring parity with the container;
  // the thread row does not itself gate on them (Apply lives on AgentEditCard).
  void canEdit;
  void pageId;

  // Owner-or-space-admin gate (#338): mirrors the server authz for the comment
  // menu (edit/delete), so we never render an action the server will 403.
  const isOwnerOrAdmin =
    currentUser?.user?.id === comment.creatorId || userSpaceRole === "admin";

  const isAgent = comment.createdSource === "agent" && !!comment.agent;

  async function handleUpdateComment() {
    try {
      setIsLoading(true);
      const commentToUpdate = {
        commentId: comment.id,
        content: JSON.stringify(editContentRef.current ?? comment.content),
      };
      await updateCommentMutation.mutateAsync(commentToUpdate);
      editContentRef.current = null;
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to update comment:", error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDeleteComment() {
    if (refuseIfBlocked()) return;
    try {
      await deleteCommentMutation.mutateAsync(comment.id);
      editor?.commands.unsetComment(comment.id);
    } catch (error) {
      console.error("Failed to delete comment:", error);
    }
  }

  async function handleResolveComment() {
    if (refuseIfBlocked()) return;
    try {
      const isResolved = comment.resolvedAt != null;
      await resolveCommentMutation.mutateAsync({
        commentId: comment.id,
        pageId: comment.pageId,
        resolved: !isResolved,
      });
      if (editor) {
        editor.commands.setCommentResolved(comment.id, !isResolved);
      }
    } catch (error) {
      console.error("Failed to toggle resolved state:", error);
    }
  }

  function handleCommentClick(target: IComment) {
    const el = document.querySelector(
      `.comment-mark[data-comment-id="${target.id}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("comment-highlight");
      setTimeout(() => {
        el.classList.remove("comment-highlight");
      }, 3000);
    }
  }

  function handleEditToggle() {
    setIsEditing(true);
  }
  function cancelEdit() {
    editContentRef.current = null;
    setIsEditing(false);
  }

  return (
    <Box ref={ref} pb={6}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        {isAgent ? (
          <AgentAvatarStack
            agent={comment.agent!}
            launcher={comment.launcher}
            aiChatId={comment.aiChatId}
            showName={false}
          />
        ) : (
          <CustomAvatar
            size="sm"
            avatarUrl={comment.creator.avatarUrl}
            name={comment.creator.name}
          />
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <Group justify="space-between" wrap="nowrap">
            <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
              {isAgent ? (
                <>
                  <Text size="xs" fw={600} lineClamp={1} lh={1.2}>
                    {comment.agent!.name}
                  </Text>
                  {comment.launcher && (
                    <>
                      <Text size="xs" c="dimmed" fw={400} aria-hidden>
                        ·
                      </Text>
                      <Text
                        size="xs"
                        c="dimmed"
                        fw={400}
                        lineClamp={1}
                        lh={1.2}
                      >
                        {comment.launcher.name}
                      </Text>
                    </>
                  )}
                </>
              ) : (
                <Text size="xs" fw={500} lineClamp={1} lh={1.2}>
                  {comment.creator.name}
                </Text>
              )}
            </Group>

            <div style={{ visibility: hovered ? "visible" : "hidden" }}>
              {!comment.parentCommentId && canComment && (
                <ResolveComment
                  editor={editor}
                  commentId={comment.id}
                  pageId={comment.pageId}
                  resolvedAt={comment.resolvedAt}
                />
              )}

              {isOwnerOrAdmin && (
                <CommentMenu
                  onEditComment={handleEditToggle}
                  onDeleteComment={handleDeleteComment}
                  onResolveComment={handleResolveComment}
                  canEdit={currentUser?.user?.id === comment.creatorId}
                  canComment={canComment}
                  isResolved={comment.resolvedAt != null}
                  isParentComment={!comment.parentCommentId}
                />
              )}
            </div>
          </Group>

          <Group gap="xs">
            <Text size="xs" fw={500} c="dimmed" lh={1.1}>
              {createdAtAgo}
            </Text>
          </Group>
        </div>
      </Group>

      <div>
        {!comment.parentCommentId && comment?.selection && (
          <Box
            className={classes.textSelection}
            onClick={() => handleCommentClick(comment)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleCommentClick(comment);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={t("Jump to comment selection")}
          >
            <Text size="xs">{comment?.selection}</Text>
          </Box>
        )}

        {!isEditing ? (
          <CommentContentView content={comment.content} />
        ) : (
          <>
            <CommentEditor
              defaultContent={comment.content}
              editable={true}
              onUpdate={(newContent: any) => {
                editContentRef.current = newContent;
              }}
              onSave={handleUpdateComment}
              autofocus={true}
            />

            <CommentActions
              onSave={handleUpdateComment}
              isLoading={isLoading}
              onCancel={cancelEdit}
              isCommentEditor={true}
            />
          </>
        )}
      </div>
    </Box>
  );
}

// Memoized so a resolve/apply/reply cache update (which only replaces the touched
// comment's object identity) re-renders that one thread, not all ~356 items.
export default React.memo(CommentListItem);
