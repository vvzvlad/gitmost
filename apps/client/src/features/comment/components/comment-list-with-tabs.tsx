import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  memo,
  useMemo,
} from "react";
import { useParams } from "react-router-dom";
import { measureOperation } from "@/lib/telemetry/vitals";
import {
  ActionIcon,
  Center,
  Divider,
  Group,
  Box,
  Stack,
  Tabs,
  Badge,
  Text,
  ScrollArea,
  Tooltip,
} from "@mantine/core";
import CommentListItem from "@/features/comment/components/comment-list-item";
import AgentEditCard, {
  RunHeader,
} from "@/features/comment/components/agent-edit-card";
import {
  useCommentsQuery,
  useCreateCommentMutation,
} from "@/features/comment/queries/comment-query";
import CommentEditor from "@/features/comment/components/comment-editor";
import CommentActions from "@/features/comment/components/comment-actions";
import { useFocusWithin } from "@mantine/hooks";
import { IComment } from "@/features/comment/types/comment.types.ts";
import {
  groupAgentRuns,
  CommentRenderUnit,
} from "@/features/comment/utils/group-agent-runs";
import { usePageMetaQuery } from "@/features/page/queries/page-query.ts";
import { extractPageSlugId } from "@/lib";
import { useTranslation } from "react-i18next";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { IconArrowUp, IconMessageOff, IconX } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";

interface CommentListWithTabsProps {
  onClose?: () => void;
}

// Index replies by their parent id once (O(n)), instead of an O(n^2) filter per
// thread. Replies whose parent is not in `items` are still grouped under their
// parentCommentId (they simply won't be reached by the top-level walk).
// Exported for unit testing.
export function buildChildrenByParent(
  items: IComment[] | undefined,
): Map<string, IComment[]> {
  const m = new Map<string, IComment[]>();
  for (const c of items ?? []) {
    if (c.parentCommentId) {
      const arr = m.get(c.parentCommentId);
      if (arr) arr.push(c);
      else m.set(c.parentCommentId, [c]);
    }
  }
  return m;
}

// Sort the Resolved tab by resolve time, newest first, on a COPY (never mutate
// the react-query cache array). `resolvedAt` is typed `Date` but at runtime it
// is an ISO STRING (from the axios-JSON onSuccess and the WS subscription) — a
// real Date only during the optimistic onMutate window — so it MUST be coerced
// with `new Date(...)` before `.getTime()`, or a raw `.getTime()` on the string
// throws / yields NaN. ES2019's stable sort preserves order for equal
// timestamps. Callers pass a list already filtered to a truthy `resolvedAt`, so
// the non-null assertion is safe.
// Exported for unit testing.
export function sortResolvedByResolvedAt(resolved: IComment[]): IComment[] {
  return [...resolved].sort(
    (a, b) =>
      new Date(b.resolvedAt!).getTime() - new Date(a.resolvedAt!).getTime(),
  );
}

// The redesigned card shell: a rounded, bordered surface on the panel body. Both
// a thread card and an agent-run group live inside one of these.
function PanelCard({
  children,
  ...rest
}: {
  children: React.ReactNode;
  [key: string]: unknown;
}) {
  return (
    <Box
      m="8px 10px"
      p={0}
      style={{
        background: "var(--mantine-color-body)",
        border: "1px solid var(--mantine-color-default-border)",
        borderRadius: 10,
        overflow: "hidden",
      }}
      {...rest}
    >
      {children}
    </Box>
  );
}

function CommentListWithTabs({ onClose }: CommentListWithTabsProps) {
  const { t } = useTranslation();
  const { pageSlug } = useParams();
  const { data: page } = usePageMetaQuery({ pageId: extractPageSlugId(pageSlug) });
  const {
    data: comments,
    isLoading: isCommentsLoading,
    isError,
  } = useCommentsQuery({ pageId: page?.id });
  const createCommentMutation = useCreateCommentMutation();
  // mutateAsync is a stable reference across renders; depend on it (not the
  // mutation object) so the reply/comment callbacks stay stable.
  const createCommentAsync = createCommentMutation.mutateAsync;

  // #683 `comments_open` measure: the panel is "settled" once the comments query
  // resolves (the filled list or the empty-state renders — not just a frame).
  // measureOperation consumes the start mark (set in use-toggle-aside on the
  // open toggle), so it reports once per open; a later render is a no-op, and an
  // open that errored out (isError) reports nothing. Reflects the whole
  // click→list round-trip (network included), which is the point on a 300+
  // comment page (#340).
  useEffect(() => {
    if (!isCommentsLoading && !isError) {
      measureOperation("comments_open");
    }
  }, [isCommentsLoading, isError]);
  const { data: space } = useGetSpaceBySlugQuery(page?.space?.slug);

  const canEdit = page?.permissions?.canEdit ?? false;

  const canComment =
    canEdit ||
    (space?.settings?.comments?.allowViewerComments === true);

  const userSpaceRole = space?.membership?.role;

  // Separate active and resolved comments
  const { activeComments, resolvedComments } = useMemo(() => {
    if (!comments?.items) {
      return { activeComments: [], resolvedComments: [] };
    }

    const parentComments = comments.items.filter(
      (comment: IComment) => comment.parentCommentId === null,
    );

    const active = parentComments.filter(
      (comment: IComment) => !comment.resolvedAt,
    );
    const resolved = parentComments.filter(
      (comment: IComment) => comment.resolvedAt,
    );

    return {
      activeComments: active,
      resolvedComments: sortResolvedByResolvedAt(resolved),
    };
  }, [comments]);

  // Collapse each tab's top-level list into render units (a lone comment or a
  // collapsed agent run). Purely visual — the underlying data is untouched.
  const activeUnits = useMemo(
    () => groupAgentRuns(activeComments),
    [activeComments],
  );
  const resolvedUnits = useMemo(
    () => groupAgentRuns(resolvedComments),
    [resolvedComments],
  );

  // Index replies by their parent once, instead of an O(n^2) filter per thread.
  // The map ref changes on any comments update, so MemoizedChildComments re-runs
  // (cheap) and re-looks-up, while memoized CommentListItems skip unchanged items.
  const childrenByParent = useMemo(
    () => buildChildrenByParent(comments?.items),
    [comments?.items],
  );

  const [isPageCommentLoading, setIsPageCommentLoading] = useState(false);

  const handleAddPageComment = useCallback(
    async (_commentId: string, content: string) => {
      try {
        setIsPageCommentLoading(true);
        const createdComment = await createCommentAsync({
          pageId: page?.id,
          content: JSON.stringify(content),
        });

        setTimeout(() => {
          const selector = `div[data-comment-id="${createdComment.id}"]`;
          const commentElement = document.querySelector(selector);
          commentElement?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }, 400);
      } catch (error) {
        console.error("Failed to post comment:", error);
      } finally {
        setIsPageCommentLoading(false);
      }
    },
    [createCommentAsync, page?.id],
  );

  const handleAddReply = useCallback(
    async (commentId: string, content: string) => {
      // Pending state lives inside CommentEditorWithActions so sending a reply
      // does not churn renderComments and re-render the whole list.
      try {
        const commentData = {
          pageId: page?.id,
          parentCommentId: commentId,
          content: JSON.stringify(content),
        };

        await createCommentAsync(commentData);
      } catch (error) {
        console.error("Failed to post comment:", error);
      }
    },
    [createCommentAsync, page?.id],
  );

  // The full subtree for ONE top-level comment: its head card (thread row or
  // agent edit card), its nested replies, and a lazily-mounted reply editor.
  // Shared by a standalone card and a card inside an agent-run group so the
  // reply threading / lazy editor (#340) is wired identically in both.
  const renderCommentSubtree = useCallback(
    (comment: IComment, isEdit: boolean, showProvenance: boolean) => (
      <>
        {isEdit ? (
          <AgentEditCard
            comment={comment}
            canComment={canComment}
            canEdit={canEdit}
            userSpaceRole={userSpaceRole}
            showProvenance={showProvenance}
          />
        ) : (
          <Box p="xs">
            <CommentListItem
              comment={comment}
              pageId={page?.id}
              canComment={canComment}
              canEdit={canEdit}
              userSpaceRole={userSpaceRole}
            />
          </Box>
        )}

        <Box px="xs">
          <MemoizedChildComments
            childrenByParent={childrenByParent}
            parentId={comment.id}
            pageId={page?.id}
            canComment={canComment}
            canEdit={canEdit}
            userSpaceRole={userSpaceRole}
          />
        </Box>

        {!comment.resolvedAt && canComment && (
          <Box px="xs" pb="xs">
            <Divider my={2} />
            <CommentEditorWithActions
              commentId={comment.id}
              onSave={handleAddReply}
            />
          </Box>
        )}
      </>
    ),
    [
      childrenByParent,
      handleAddReply,
      page?.id,
      userSpaceRole,
      canComment,
      canEdit,
    ],
  );

  // Render one collapsed unit: a standalone card (thread or lone edit) or an
  // agent-run group (one RunHeader over N stacked edit cards).
  const renderUnit = useCallback(
    (unit: CommentRenderUnit) => {
      if (unit.kind === "single") {
        const c = unit.comment;
        const isEdit =
          c.createdSource === "agent" &&
          c.suggestedText != null &&
          !c.parentCommentId;
        return (
          <PanelCard key={c.id} data-comment-id={c.id}>
            {renderCommentSubtree(c, isEdit, true)}
          </PanelCard>
        );
      }

      // A collapsed agent run: one header, then each edit card (provenance
      // suppressed on the cards — the header carries the single provenance line).
      return (
        <PanelCard key={unit.key}>
          <RunHeader comments={unit.comments} />
          {unit.comments.map((c) => (
            <Box
              key={c.id}
              data-comment-id={c.id}
              style={{
                borderTop: "1px solid var(--mantine-color-default-border)",
              }}
            >
              {renderCommentSubtree(c, true, false)}
            </Box>
          ))}
        </PanelCard>
      );
    },
    [renderCommentSubtree],
  );

  if (isCommentsLoading) {
    return <></>;
  }

  if (isError) {
    return <div>{t("Error loading comments.")}</div>;
  }

  const pageCommentInput = canComment ? (
    <PageCommentInput
      onSave={handleAddPageComment}
      isLoading={isPageCommentLoading}
    />
  ) : null;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Tabs
        defaultValue="open"
        variant="default"
        // Default to not mounting an inactive tab (the heavy Resolved list stays
        // unmounted while Open is shown). The Open panel overrides this with its
        // own keepMounted (below) so an in-progress reply/edit draft survives an
        // Open -> Resolved -> Open switch.
        keepMounted={false}
        style={{
          flex: "1 1 auto",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header row: full-width centered tab list with the close button overlaid on the right. */}
        <div style={{ position: "relative" }}>
          <Tabs.List justify="center">
            <Tabs.Tab
              value="open"
              leftSection={
                <Badge size="sm" variant="light" color="blue">
                  {activeComments.length}
                </Badge>
              }
            >
              {t("Open")}
            </Tabs.Tab>
            <Tabs.Tab
              value="resolved"
              leftSection={
                <Badge size="sm" variant="light" color="green">
                  {resolvedComments.length}
                </Badge>
              }
            >
              {t("Resolved")}
            </Tabs.Tab>
          </Tabs.List>
          {onClose && (
            <Tooltip label={t("Close")} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={onClose}
                aria-label={t("Close")}
                style={{
                  position: "absolute",
                  right: 0,
                  top: "50%",
                  // Nudge the close button slightly up to align with the tab labels.
                  transform: "translateY(calc(-50% - 4px))",
                }}
              >
                <IconX size={18} />
              </ActionIcon>
            </Tooltip>
          )}
        </div>

        <ScrollArea
          style={{ flex: "1 1 auto" }}
          scrollbarSize={5}
          type="scroll"
        >
          <div style={{ paddingBottom: "8px" }}>
            {/* keepMounted keeps the Open panel alive even while Resolved is
                active, so a lazily-mounted reply editor's draft (and an
                in-progress edit) is not discarded on tab switch. */}
            <Tabs.Panel value="open" pt="xs" keepMounted>
              {activeComments.length === 0 ? (
                <Center py="xl">
                  <Stack align="center" gap="xs">
                    <IconMessageOff
                      size={32}
                      stroke={1.5}
                      color="var(--mantine-color-dimmed)"
                    />
                    <Text size="sm" c="dimmed">
                      {t("No open comments.")}
                    </Text>
                  </Stack>
                </Center>
              ) : (
                activeUnits.map(renderUnit)
              )}
            </Tabs.Panel>

            <Tabs.Panel value="resolved" pt="xs">
              {resolvedComments.length === 0 ? (
                <Center py="xl">
                  <Stack align="center" gap="xs">
                    <IconMessageOff
                      size={32}
                      stroke={1.5}
                      color="var(--mantine-color-dimmed)"
                    />
                    <Text size="sm" c="dimmed">
                      {t("No resolved comments.")}
                    </Text>
                  </Stack>
                </Center>
              ) : (
                resolvedUnits.map(renderUnit)
              )}
            </Tabs.Panel>
          </div>
        </ScrollArea>
      </Tabs>
      {pageCommentInput}
    </div>
  );
}

interface ChildCommentsProps {
  childrenByParent: Map<string, IComment[]>;
  parentId: string;
  pageId: string;
  canComment: boolean;
  canEdit?: boolean;
  userSpaceRole?: string;
}
const ChildComments = ({
  childrenByParent,
  parentId,
  pageId,
  canComment,
  canEdit,
  userSpaceRole,
}: ChildCommentsProps) => {
  const children = childrenByParent.get(parentId) ?? [];

  return (
    <div>
      {children.map((childComment) => (
        <div key={childComment.id}>
          <CommentListItem
            comment={childComment}
            pageId={pageId}
            canComment={canComment}
            canEdit={canEdit}
            userSpaceRole={userSpaceRole}
          />
          <MemoizedChildComments
            childrenByParent={childrenByParent}
            parentId={childComment.id}
            pageId={pageId}
            canComment={canComment}
            canEdit={canEdit}
            userSpaceRole={userSpaceRole}
          />
        </div>
      ))}
    </div>
  );
};

const MemoizedChildComments = memo(ChildComments);

export const CommentEditorWithActions = ({
  commentId,
  onSave,
  placeholder = undefined,
}) => {
  const { t } = useTranslation();
  // Lazily mount the TipTap reply editor: until the user interacts with the
  // stub, no editor instance is created for this thread. Once mounted it stays
  // mounted so the draft is preserved.
  const [mounted, setMounted] = useState(false);
  const [content, setContent] = useState("");
  const [isSending, setIsSending] = useState(false);
  const { ref, focused } = useFocusWithin();
  const commentEditorRef = useRef(null);

  const activate = useCallback(() => setMounted(true), []);

  const handleSave = useCallback(async () => {
    try {
      setIsSending(true);
      await onSave(commentId, content);
      setContent("");
      commentEditorRef.current?.clearContent();
    } finally {
      setIsSending(false);
    }
  }, [commentId, content, onSave]);

  if (!mounted) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onFocus={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        style={{
          padding: "6px",
          fontSize: "var(--mantine-font-size-sm)",
          lineHeight: 1.4,
          color: "var(--mantine-color-placeholder)",
          cursor: "text",
          borderRadius: "var(--mantine-radius-sm)",
        }}
      >
        {placeholder || t("Reply...")}
      </div>
    );
  }

  return (
    <div ref={ref}>
      <CommentEditor
        ref={commentEditorRef}
        onUpdate={setContent}
        onSave={handleSave}
        editable={true}
        placeholder={placeholder}
        autofocus={true}
      />
      {focused && <CommentActions onSave={handleSave} isLoading={isSending} />}
    </div>
  );
};

const PageCommentInput = ({ onSave, isLoading }) => {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const { ref, focused } = useFocusWithin();
  const commentEditorRef = useRef(null);
  const [currentUser] = useAtom(currentUserAtom);

  const handleSave = useCallback(() => {
    onSave(null, content);
    setContent("");
    commentEditorRef.current?.clearContent();
  }, [content, onSave]);

  return (
    <div
      ref={ref}
      style={{
        flex: "0 0 auto",
        borderTop: "1px solid var(--mantine-color-default-border)",
        paddingTop: "var(--mantine-spacing-sm)",
        paddingBottom: 10,
        position: "relative",
      }}
    >
      <Group wrap="nowrap" align="flex-start" gap="xs">
        <CustomAvatar
          size="sm"
          avatarUrl={currentUser?.user?.avatarUrl}
          name={currentUser?.user?.name}
          style={{ flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <CommentEditor
            ref={commentEditorRef}
            onUpdate={setContent}
            onSave={handleSave}
            editable={true}
            placeholder={t("Add a comment...")}
            surface="muted"
          />
        </div>
      </Group>
      {focused && (
        <ActionIcon
          variant="filled"
          radius="xl"
          size="sm"
          aria-label={t("Send comment")}
          onClick={handleSave}
          onMouseDown={(e) => e.preventDefault()}
          loading={isLoading}
          style={{ position: "absolute", right: 8, bottom: 15 }}
        >
          <IconArrowUp size={16} />
        </ActionIcon>
      )}
    </div>
  );
};

export default CommentListWithTabs;
