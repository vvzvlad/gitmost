import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  InfiniteData,
} from "@tanstack/react-query";

/**
 * Coverage for the resolve/reopen mutation (#542): the Undo-in-toast reopen and
 * its double-click guard, the terminal 404 branch (drop from cache + clear the
 * inline mark, no rollback), and the directional error copy.
 */

// A fake TipTap editor injected via the mocked pageEditorAtom, so we can assert
// the mutation clears the inline comment mark (unsetComment / setCommentResolved).
const editorMock = vi.hoisted(() => ({
  current: {
    isDestroyed: false,
    commands: { unsetComment: vi.fn(), setCommentResolved: vi.fn() },
  } as {
    isDestroyed: boolean;
    commands: {
      unsetComment: (id: string) => void;
      setCommentResolved: (id: string, v: boolean) => void;
    };
  } | null,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn(), hide: vi.fn() },
}));

vi.mock("jotai", () => ({
  atom: (v: unknown) => v,
  useAtomValue: () => editorMock.current,
}));

vi.mock("@/features/comment/services/comment-service", () => ({
  applySuggestion: vi.fn(),
  dismissSuggestion: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  resolveComment: vi.fn(),
  getPageComments: vi.fn(),
}));

import { notifications } from "@mantine/notifications";
import { resolveComment } from "@/features/comment/services/comment-service";
import {
  useResolveCommentMutation,
  RESOLVE_UNDO_AUTOCLOSE_MS,
  RQ_KEY,
} from "@/features/comment/queries/comment-query";
import { IComment } from "@/features/comment/types/comment.types";

const PAGE_ID = "page-1";

function seededClient(comment: IComment) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const seed: InfiniteData<any> = {
    pageParams: [undefined],
    pages: [
      { items: [comment], meta: { hasNextPage: false, nextCursor: null } },
    ],
  };
  queryClient.setQueryData(RQ_KEY(PAGE_ID), seed);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function items(queryClient: QueryClient): IComment[] {
  const cache = queryClient.getQueryData(RQ_KEY(PAGE_ID)) as
    | InfiniteData<any>
    | undefined;
  return cache?.pages.flatMap((p) => p.items) ?? [];
}

const comment = (over?: Partial<IComment>): IComment =>
  ({
    id: "c-1",
    pageId: PAGE_ID,
    content: "{}",
    creatorId: "u-1",
    workspaceId: "ws-1",
    createdAt: new Date(),
    resolvedAt: null,
    ...over,
  }) as IComment;

// Pull the inline Undo button's onClick out of the success toast's message tree.
function undoOnClickFromToast(): () => void {
  const call = vi
    .mocked(notifications.show)
    .mock.calls.map((c) => c[0])
    .find((arg: any) => arg?.autoClose === RESOLVE_UNDO_AUTOCLOSE_MS);
  expect(call).toBeTruthy();
  const message: any = (call as any).message;
  // message = Group( Text, Button ); grab the Button element's onClick.
  const children = message.props.children as any[];
  const button = children[1];
  return button.props.onClick;
}

describe("useResolveCommentMutation — Undo toast (#542)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorMock.current = {
      isDestroyed: false,
      commands: { unsetComment: vi.fn(), setCommentResolved: vi.fn() },
    };
  });

  it("resolve shows an Undo toast with autoClose=10000ms; reopen shows NO Undo", async () => {
    vi.mocked(resolveComment).mockImplementation(async (data) =>
      comment({
        resolvedAt: data.resolved ? (new Date() as any) : null,
      }),
    );
    const { wrapper } = seededClient(comment());
    const { result } = renderHook(() => useResolveCommentMutation(), {
      wrapper,
    });

    await result.current.mutateAsync({
      commentId: "c-1",
      pageId: PAGE_ID,
      resolved: true,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const resolveToast = vi
      .mocked(notifications.show)
      .mock.calls.map((c) => c[0])
      .find((a: any) => a?.autoClose === RESOLVE_UNDO_AUTOCLOSE_MS);
    expect(resolveToast).toBeTruthy();
    expect((resolveToast as any).id).toBe("resolve-undo-c-1");
    expect((resolveToast as any).autoClose).toBe(10000);

    // Now a reopen → plain toast, no autoClose/Undo, no id.
    vi.clearAllMocks();
    await result.current.mutateAsync({
      commentId: "c-1",
      pageId: PAGE_ID,
      resolved: false,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const calls = vi.mocked(notifications.show).mock.calls.map((c) => c[0]);
    expect(
      calls.some((a: any) => a?.autoClose === RESOLVE_UNDO_AUTOCLOSE_MS),
    ).toBe(false);
    expect(calls).toContainEqual({ message: "Comment re-opened successfully" });
  });

  it("double/fast Undo click fires reopen EXACTLY once (guard)", async () => {
    vi.mocked(resolveComment).mockImplementation(async (data) =>
      comment({ resolvedAt: data.resolved ? (new Date() as any) : null }),
    );
    const { wrapper } = seededClient(comment());
    const { result } = renderHook(() => useResolveCommentMutation(), {
      wrapper,
    });

    await result.current.mutateAsync({
      commentId: "c-1",
      pageId: PAGE_ID,
      resolved: true,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const onClick = undoOnClickFromToast();
    // Fire twice synchronously (notifications.hide is not synchronous).
    onClick();
    onClick();

    await waitFor(() => {
      const reopenCalls = vi
        .mocked(resolveComment)
        .mock.calls.filter(([d]) => d.resolved === false);
      expect(reopenCalls).toHaveLength(1);
    });
    // The mark was cleared once via setCommentResolved(id, false).
    expect(editorMock.current!.commands.setCommentResolved).toHaveBeenCalledWith(
      "c-1",
      false,
    );
    // The toast was hidden.
    expect(notifications.hide).toHaveBeenCalledWith("resolve-undo-c-1");
  });

  it("404 → drops the comment from cache, clears the inline mark, no rollback, no Undo", async () => {
    vi.mocked(resolveComment).mockRejectedValue({ response: { status: 404 } });
    const { queryClient, wrapper } = seededClient(comment());
    const { result } = renderHook(() => useResolveCommentMutation(), {
      wrapper,
    });

    await result.current
      .mutateAsync({ commentId: "c-1", pageId: PAGE_ID, resolved: true })
      .catch(() => undefined);
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Removed from cache (NOT rolled back to a phantom).
    expect(items(queryClient)).toHaveLength(0);
    // Inline mark cleared via unsetComment (mandatory — no panel row left to do it).
    expect(editorMock.current!.commands.unsetComment).toHaveBeenCalledWith(
      "c-1",
    );
    // Neutral message, red, and crucially NOT the success copy and NO Undo toast.
    expect(notifications.show).toHaveBeenCalledWith({
      message: "Comment no longer exists",
      color: "red",
    });
    const calls = vi.mocked(notifications.show).mock.calls.map((c) => c[0]);
    expect(
      calls.some((a: any) => a?.autoClose === RESOLVE_UNDO_AUTOCLOSE_MS),
    ).toBe(false);
  });

  it("404 does not crash when the editor is gone (read-only / panel closed)", async () => {
    editorMock.current = null;
    vi.mocked(resolveComment).mockRejectedValue({ response: { status: 404 } });
    const { queryClient, wrapper } = seededClient(comment());
    const { result } = renderHook(() => useResolveCommentMutation(), {
      wrapper,
    });

    await result.current
      .mutateAsync({ commentId: "c-1", pageId: PAGE_ID, resolved: true })
      .catch(() => undefined);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(items(queryClient)).toHaveLength(0);
    expect(notifications.show).toHaveBeenCalledWith({
      message: "Comment no longer exists",
      color: "red",
    });
  });

  it("non-404 error on REOPEN shows 'Failed to re-open comment' and rolls back", async () => {
    vi.mocked(resolveComment).mockRejectedValue({ response: { status: 500 } });
    // Seed a RESOLVED comment (the reopen target).
    const resolved = comment({ resolvedAt: new Date() as any });
    const { queryClient, wrapper } = seededClient(resolved);
    const { result } = renderHook(() => useResolveCommentMutation(), {
      wrapper,
    });

    await result.current
      .mutateAsync({ commentId: "c-1", pageId: PAGE_ID, resolved: false })
      .catch(() => undefined);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(notifications.show).toHaveBeenCalledWith({
      message: "Failed to re-open comment",
      color: "red",
    });
    expect(notifications.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Failed to resolve comment" }),
    );
    // Rolled back: the comment is still present and still resolved.
    expect(items(queryClient)).toHaveLength(1);
    expect(items(queryClient)[0].resolvedAt).toBeTruthy();
  });

  it("reopen via Undo FAILS (non-404) → inline mark is NOT left cleared (doc↔panel stay consistent)", async () => {
    // First resolve succeeds → produces the Undo toast (no mark change on resolve).
    vi.mocked(resolveComment).mockResolvedValueOnce(
      comment({ resolvedAt: new Date() as any }),
    );
    const { queryClient, wrapper } = seededClient(comment());
    const { result } = renderHook(() => useResolveCommentMutation(), {
      wrapper,
    });

    await result.current.mutateAsync({
      commentId: "c-1",
      pageId: PAGE_ID,
      resolved: true,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Now the reopen fired by Undo fails with a 500.
    vi.mocked(resolveComment).mockRejectedValue({ response: { status: 500 } });
    const onClick = undoOnClickFromToast();
    onClick();

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Core F1 guarantee: the mark-clear now lives in the reopen onSuccess, so a
    // FAILED reopen must never flip the inline mark to unresolved — otherwise the
    // doc would show an active highlight the panel still treats as resolved and
    // the collab mark would diverge with nothing committed on the server.
    expect(
      editorMock.current!.commands.setCommentResolved,
    ).not.toHaveBeenCalledWith("c-1", false);
    // Cache rolled back: the comment stays resolved and present.
    expect(items(queryClient)).toHaveLength(1);
    expect(items(queryClient)[0].resolvedAt).toBeTruthy();
  });

  it("reopen success with a null editorRef degrades gracefully (no throw, no-op)", async () => {
    // Read-only view / panel closed: pageEditorAtom is null on the success path.
    editorMock.current = null;
    vi.mocked(resolveComment).mockResolvedValue(comment({ resolvedAt: null }));
    const resolved = comment({ resolvedAt: new Date() as any });
    const { queryClient, wrapper } = seededClient(resolved);
    const { result } = renderHook(() => useResolveCommentMutation(), {
      wrapper,
    });

    await result.current.mutateAsync({
      commentId: "c-1",
      pageId: PAGE_ID,
      resolved: false,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // No crash from the reopen mark-clear; the plain reopen toast is still shown.
    expect(notifications.show).toHaveBeenCalledWith({
      message: "Comment re-opened successfully",
    });
    // Cache updated to reopened (resolvedAt cleared by the server payload).
    expect(items(queryClient)).toHaveLength(1);
    expect(items(queryClient)[0].resolvedAt).toBeFalsy();
  });

  it("non-404 error on RESOLVE shows 'Failed to resolve comment' and rolls back", async () => {
    vi.mocked(resolveComment).mockRejectedValue({ response: { status: 500 } });
    const { queryClient, wrapper } = seededClient(comment());
    const { result } = renderHook(() => useResolveCommentMutation(), {
      wrapper,
    });

    await result.current
      .mutateAsync({ commentId: "c-1", pageId: PAGE_ID, resolved: true })
      .catch(() => undefined);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(notifications.show).toHaveBeenCalledWith({
      message: "Failed to resolve comment",
      color: "red",
    });
    // Rolled back to open (previousCache), still present.
    expect(items(queryClient)).toHaveLength(1);
    expect(items(queryClient)[0].resolvedAt).toBeFalsy();
  });
});
