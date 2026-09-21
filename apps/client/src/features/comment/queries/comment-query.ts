import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  InfiniteData,
} from "@tanstack/react-query";
import {
  applySuggestion,
  createComment,
  deleteComment,
  dismissSuggestion,
  getPageComments,
  resolveComment,
  updateComment,
} from "@/features/comment/services/comment-service";
import {
  ICommentParams,
  IComment,
  IResolveComment,
  ISuggestionOutcome,
} from "@/features/comment/types/comment.types";
import { notifications } from "@mantine/notifications";
import { Button, Group, Text } from "@mantine/core";
import { IPagination } from "@/lib/types.ts";
import { useTranslation } from "react-i18next";
import React, { useEffect, useMemo, useRef } from "react";
import { useAtomValue } from "jotai";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms";
import {
  markOperationStart,
  measureOperation,
} from "@/lib/telemetry/vitals";

export const RQ_KEY = (pageId: string) => ["comments", pageId];

// How long the resolve success toast (with its inline Undo) stays up before it
// auto-closes. Policy constant — no env override.
export const RESOLVE_UNDO_AUTOCLOSE_MS = 10000;

export function useCommentsQuery(params: ICommentParams) {
  const query = useInfiniteQuery({
    queryKey: RQ_KEY(params.pageId),
    queryFn: ({ pageParam }) =>
      getPageComments({ pageId: params.pageId, cursor: pageParam, limit: 100 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? lastPage.meta.nextCursor : undefined,
    enabled: !!params.pageId,
  });

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const data = useMemo<IPagination<IComment> | undefined>(() => {
    if (!query.data) return undefined;
    return {
      items: query.data.pages.flatMap((p) => p.items),
      meta: query.data.pages[query.data.pages.length - 1].meta,
    };
  }, [query.data]);

  return {
    data,
    // Paint the first page as soon as it arrives instead of blocking until every
    // page has loaded; the background effect above keeps streaming the rest
    // (tab counts grow as pages arrive).
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useCreateCommentMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IComment, Error, Partial<IComment>>({
    mutationFn: (data) => createComment(data),
    onSuccess: (newComment) => {
      const cache = queryClient.getQueryData(
        RQ_KEY(newComment.pageId),
      ) as InfiniteData<IPagination<IComment>> | undefined;

      if (cache && cache.pages.length > 0) {
        const alreadyExists = cache.pages.some((page) =>
          page.items.some((c) => c.id === newComment.id),
        );
        if (alreadyExists) return;

        const lastIdx = cache.pages.length - 1;
        queryClient.setQueryData(RQ_KEY(newComment.pageId), {
          ...cache,
          pages: cache.pages.map((page, i) =>
            i === lastIdx
              ? { ...page, items: [...page.items, newComment] }
              : page,
          ),
        });
      }

      notifications.show({ message: t("Comment created successfully") });
    },
    onError: () => {
      notifications.show({
        message: t("Error creating comment"),
        color: "red",
      });
    },
  });
}

export function useUpdateCommentMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IComment, Error, Partial<IComment>>({
    mutationFn: (data) => updateComment(data),
    onSuccess: (updatedComment) => {
      const cache = queryClient.getQueryData(
        RQ_KEY(updatedComment.pageId),
      ) as InfiniteData<IPagination<IComment>> | undefined;

      if (cache) {
        queryClient.setQueryData(RQ_KEY(updatedComment.pageId), {
          ...cache,
          pages: cache.pages.map((page) => ({
            ...page,
            items: page.items.map((comment) =>
              comment.id === updatedComment.id ? updatedComment : comment,
            ),
          })),
        });
      }

      notifications.show({ message: t("Comment updated successfully") });
    },
    onError: () => {
      notifications.show({
        message: t("Failed to update comment"),
        color: "red",
      });
    },
  });
}

export function useDeleteCommentMutation(pageId?: string) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: (_data, commentId) => {
      const cache = queryClient.getQueryData(
        RQ_KEY(pageId),
      ) as InfiniteData<IPagination<IComment>> | undefined;

      if (cache) {
        queryClient.setQueryData(RQ_KEY(pageId), {
          ...cache,
          pages: cache.pages.map((page) => ({
            ...page,
            items: page.items.filter((comment) => comment.id !== commentId),
          })),
        });
      }

      notifications.show({ message: t("Comment deleted successfully") });
    },
    onError: () => {
      notifications.show({
        message: t("Failed to delete comment"),
        color: "red",
      });
    },
  });
}

function updateCommentInCache(
  cache: InfiniteData<IPagination<IComment>>,
  commentId: string,
  updater: (comment: IComment) => IComment,
): InfiniteData<IPagination<IComment>> {
  return {
    ...cache,
    pages: cache.pages.map((page) => ({
      ...page,
      items: page.items.map((comment) =>
        comment.id === commentId ? updater(comment) : comment,
      ),
    })),
  };
}

function removeCommentFromCache(
  cache: InfiniteData<IPagination<IComment>>,
  commentId: string,
): InfiniteData<IPagination<IComment>> {
  return {
    ...cache,
    pages: cache.pages.map((page) => ({
      ...page,
      items: page.items.filter((comment) => comment.id !== commentId),
    })),
  };
}

// Reconcile the local comment cache with an ephemeral-suggestion outcome (#329)
// returned by apply/dismiss: 'deleted' → drop the comment (it disappeared);
// 'resolved' → the thread had replies and was resolved, so carry the resolved
// state through (which relocates it to the resolved tab).
function applySuggestionOutcomeToCache(
  queryClient: ReturnType<typeof useQueryClient>,
  pageId: string,
  commentId: string,
  data: ISuggestionOutcome,
) {
  const cache = queryClient.getQueryData(RQ_KEY(pageId)) as
    | InfiniteData<IPagination<IComment>>
    | undefined;
  if (!cache) return;

  if (data.outcome === "deleted") {
    queryClient.setQueryData(RQ_KEY(pageId), removeCommentFromCache(cache, commentId));
    return;
  }

  // 'resolved' (or an older server that omits outcome): reflect the resolved
  // state and the applied stamps (apply sets them; dismiss leaves them null).
  queryClient.setQueryData(
    RQ_KEY(pageId),
    updateCommentInCache(cache, commentId, (comment) => ({
      ...comment,
      suggestionAppliedAt: data.suggestionAppliedAt,
      suggestionAppliedById: data.suggestionAppliedById,
      resolvedAt: data.resolvedAt,
      resolvedById: data.resolvedById,
      resolvedBy: data.resolvedBy,
    })),
  );
}

export function useApplySuggestionMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<
    ISuggestionOutcome,
    any,
    { commentId: string; pageId: string }
  >({
    // No optimistic update: apply can fail with 409 (the commented text drifted),
    // so we only mutate the cache once the server confirms.
    mutationFn: ({ commentId }) => applySuggestion(commentId),
    // #683 `comment_apply` — mark at the user action; measured in onSettled on
    // success only. There is no optimistic update here, so onMutate is used
    // purely for the telemetry start mark.
    onMutate: () => {
      markOperationStart("comment_apply");
    },
    onSuccess: (data, variables) => {
      // Ephemeral (#329): the server hard-deletes the applied suggestion when the
      // thread has no replies ('deleted') or resolves it when it does ('resolved').
      applySuggestionOutcomeToCache(
        queryClient,
        variables.pageId,
        variables.commentId,
        data,
      );

      notifications.show({ message: t("Suggestion applied") });
    },
    onError: (err: any, variables) => {
      const status = err?.response?.status;
      // Idempotent race (double-click, or apply↔dismiss): after #329 an applied
      // reply-less suggestion is hard-deleted, so a second/racing apply hits 404
      // (already gone). ONLY 404 is a real success-noop — drop it from the cache
      // and report success, the user's intent is already satisfied (restores the
      // #315 apply idempotency the ephemeral delete would otherwise break).
      //
      // 400 is NOT success (#338 F2): apply's only 400 is "Cannot apply … on a
      // resolved comment thread" — the thread was resolved (often WITH a live
      // discussion) but the edit was NOT applied. Treating it as "Suggestion
      // applied" is a false success that also drops a live thread from the cache.
      // The #315 idempotent repeat does NOT produce 400 (childless → 404;
      // with-replies → 200), so we never lose idempotency by excluding it here.
      if (status === 404) {
        const cache = queryClient.getQueryData(RQ_KEY(variables.pageId)) as
          | InfiniteData<IPagination<IComment>>
          | undefined;
        if (cache) {
          queryClient.setQueryData(
            RQ_KEY(variables.pageId),
            removeCommentFromCache(cache, variables.commentId),
          );
        }
        notifications.show({ message: t("Suggestion applied") });
        return;
      }
      // 400 => the thread was resolved and the edit could not be applied. Show a
      // real error and KEEP the comment in the cache (it is still alive). Prefer
      // the server's specific message when it carries one.
      if (status === 400) {
        const serverMsg = err?.response?.data?.message;
        notifications.show({
          message:
            typeof serverMsg === "string" && serverMsg.length > 0
              ? serverMsg
              : t("Failed to apply suggestion"),
          color: "red",
        });
        return;
      }
      // 409 => the commented text changed since the suggestion was made. Surface
      // a specific message (with the current text) rather than a generic error.
      const currentText = err?.response?.data?.currentText;
      if (status === 409 && typeof currentText === "string") {
        const shortText =
          currentText.length > 80
            ? `${currentText.slice(0, 80)}…`
            : currentText;
        notifications.show({
          title: t(
            "The commented text changed since this suggestion was made; it was not applied.",
          ),
          message: shortText,
          color: "red",
        });
        return;
      }
      notifications.show({
        message: t("Failed to apply suggestion"),
        color: "red",
      });
    },
    // #683 `comment_apply` measure — success only. The 404 idempotent-race branch
    // lives in onError (RQ treats it as an error), so it is intentionally NOT
    // measured; only a clean apply reports, and a real failure lets the mark
    // expire.
    onSettled: (_data, error) => {
      if (!error) measureOperation("comment_apply");
    },
  });
}

export function useDismissSuggestionMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<
    ISuggestionOutcome,
    any,
    { commentId: string; pageId: string }
  >({
    mutationFn: ({ commentId }) => dismissSuggestion(commentId),
    onSuccess: (data, variables) => {
      // Ephemeral (#329): dismiss hard-deletes the suggestion when the thread has
      // no replies ('deleted') or resolves it when it does ('resolved').
      applySuggestionOutcomeToCache(
        queryClient,
        variables.pageId,
        variables.commentId,
        data,
      );

      notifications.show({ message: t("Suggestion dismissed") });
    },
    onError: (err: any, variables) => {
      // Idempotent race (double-click, or apply↔dismiss): the comment is already
      // gone (404). ONLY 404 is a real success-noop — drop it from the cache and
      // report success, the user's intent (make it disappear) is satisfied.
      //
      // 400 is NOT success (#338 F2): it means the thread is still ALIVE (already
      // resolved, or a reply raced in), so treating it as "dismissed" would drop
      // a live thread from the cache. Show a real error and keep the comment.
      const status = err?.response?.status;
      if (status === 404) {
        const cache = queryClient.getQueryData(RQ_KEY(variables.pageId)) as
          | InfiniteData<IPagination<IComment>>
          | undefined;
        if (cache) {
          queryClient.setQueryData(
            RQ_KEY(variables.pageId),
            removeCommentFromCache(cache, variables.commentId),
          );
        }
        notifications.show({ message: t("Suggestion dismissed") });
        return;
      }
      notifications.show({
        message: t("Failed to dismiss suggestion"),
        color: "red",
      });
    },
  });
}

export function useResolveCommentMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  // Keep the live editor in a ref: the toast's Undo (and the 404 branch) must
  // clear the inline comment mark AFTER the originating CommentListItem has
  // unmounted (resolving pulls the comment out of the Open list, so its item is
  // already gone by the time the 10s toast is clicked). In read-only view
  // pageEditorAtom is null and the mark converges via the server's
  // COMMENT_MARK_UPDATE job instead.
  const editor = useAtomValue(pageEditorAtom);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Self-reference the mutation so the toast's Undo can re-invoke it (reopen)
  // long after the triggering component unmounted. Declared BEFORE useMutation
  // and assigned AFTER; the onClick reads mutationRef.current at CALL time, not
  // definition time, so there is no initialization cycle.
  const mutationRef = useRef<{
    mutate: (vars: IResolveComment) => void;
  } | null>(null);

  const mutation = useMutation({
    mutationFn: (data: IResolveComment) => resolveComment(data),
    onMutate: async (variables) => {
      // #683 `comment_resolve` — mark at the optimistic start; measured in
      // onSettled on success only (the "до/после" #399 round-trip incl. the
      // thread re-render). A failed resolve leaves the mark to expire.
      markOperationStart("comment_resolve");
      await queryClient.cancelQueries({ queryKey: RQ_KEY(variables.pageId) });
      const previousCache = queryClient.getQueryData(RQ_KEY(variables.pageId));

      const cache = previousCache as
        | InfiniteData<IPagination<IComment>>
        | undefined;
      if (cache) {
        queryClient.setQueryData(
          RQ_KEY(variables.pageId),
          updateCommentInCache(cache, variables.commentId, (comment) => ({
            ...comment,
            resolvedAt: variables.resolved ? new Date() : null,
            resolvedById: variables.resolved ? "optimistic" : null,
            resolvedBy: variables.resolved
              ? ({ id: "optimistic", name: "", avatarUrl: null } as IComment["resolvedBy"])
              : null,
          })),
        );
      }

      return { previousCache };
    },
    onError: (err: any, variables, context) => {
      // Terminal 404: the comment was really deleted (missing comment or deleted
      // page — access denial is 403, resolve is idempotent so no 400). Do NOT
      // roll back (that would resurrect a phantom row in Resolved); instead drop
      // it from the cache and clear its now-orphaned inline mark. Mirrors
      // handleDeleteComment and the dismiss-mutation 404 branch.
      if (err?.response?.status === 404) {
        const cache = queryClient.getQueryData(RQ_KEY(variables.pageId)) as
          | InfiniteData<IPagination<IComment>>
          | undefined;
        if (cache) {
          queryClient.setQueryData(
            RQ_KEY(variables.pageId),
            removeCommentFromCache(cache, variables.commentId),
          );
        }
        const ed = editorRef.current;
        if (ed && !ed.isDestroyed) {
          try {
            ed.commands.unsetComment(variables.commentId);
          } catch {
            /* editor gone / mark already removed */
          }
        }
        notifications.show({
          message: t("Comment no longer exists"),
          color: "red",
        });
        return;
      }

      // Generic failure: roll back the optimistic update and show a DIRECTIONAL
      // error (resolve vs. reopen), not always "resolve".
      if (context?.previousCache) {
        queryClient.setQueryData(
          RQ_KEY(variables.pageId),
          context.previousCache,
        );
      }
      notifications.show({
        message: variables.resolved
          ? t("Failed to resolve comment")
          : t("Failed to re-open comment"),
        color: "red",
      });
    },
    onSuccess: (data: IComment, variables) => {
      const cache = queryClient.getQueryData(
        RQ_KEY(data.pageId),
      ) as InfiniteData<IPagination<IComment>> | undefined;

      if (cache) {
        queryClient.setQueryData(
          RQ_KEY(data.pageId),
          updateCommentInCache(cache, variables.commentId, (comment) => ({
            ...comment,
            resolvedAt: data.resolvedAt,
            resolvedById: data.resolvedById,
            resolvedBy: data.resolvedBy,
          })),
        );
      }

      // Reopen keeps the plain toast without an Undo.
      if (!variables.resolved) {
        // Clear the inline mark ONLY after the server confirms the reopen, so a
        // failed reopen never leaves an active highlight the panel still treats
        // as resolved. Mirrors the 404 branch's editor-liveness guard/try-catch.
        // The button-triggered reopen already set the mark, so this is an
        // idempotent no-op there.
        const ed = editorRef.current;
        if (ed && !ed.isDestroyed) {
          try {
            ed.commands.setCommentResolved(variables.commentId, false);
          } catch {
            /* editor gone — server COMMENT_MARK_UPDATE converges it */
          }
        }
        notifications.show({ message: t("Comment re-opened successfully") });
        return;
      }

      // Resolve: attach an inline Undo (reopen) to the success toast. Built with
      // React.createElement because this is a .ts module (no JSX).
      const { commentId, pageId } = variables;
      const notificationId = `resolve-undo-${commentId}`;
      // Double-click guard: notifications.hide is NOT synchronous, so the button
      // stays clickable for a frame or two — without this a fast double-click
      // would fire reopen twice.
      let done = false;
      notifications.show({
        id: notificationId,
        autoClose: RESOLVE_UNDO_AUTOCLOSE_MS,
        message: React.createElement(
          Group,
          { justify: "space-between", wrap: "nowrap", gap: "md" },
          React.createElement(
            Text,
            { size: "sm" },
            t("Comment resolved successfully"),
          ),
          React.createElement(
            Button,
            {
              variant: "subtle",
              size: "compact-sm",
              onClick: () => {
                if (done) return;
                done = true;
                // Reopen via the SAME mutation (read at click time — the
                // originating item is already unmounted).
                mutationRef.current?.mutate({
                  commentId,
                  pageId,
                  resolved: false,
                });
                // The inline mark is cleared in the reopen mutation's onSuccess
                // (bound to server confirmation), NOT here — clearing it eagerly
                // would desync the doc from the panel if reopen then fails.
                notifications.hide(notificationId);
              },
            },
            t("Undo"),
          ),
        ),
      });
    },
    // #683 `comment_resolve` measure — success only (skip errors, incl. the
    // rollback and the 404-drop paths, so a failed resolve reports nothing and
    // its start mark expires).
    onSettled: (_data, error) => {
      if (!error) measureOperation("comment_resolve");
    },
  });

  mutationRef.current = mutation;
  return mutation;
}
