import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { IComment } from "@/features/comment/types/comment.types";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// The comment mutation hooks reach out to react-query/network — stub them so the
// component renders in isolation. We only assert the AI-badge rendering branch.
const applyMutateAsync = vi.fn();
const dismissMutateAsync = vi.fn();
const updateMutateAsync = vi.fn();
vi.mock("@/features/comment/queries/comment-query", () => ({
  useDeleteCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useResolveCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useUpdateCommentMutation: () => ({ mutateAsync: updateMutateAsync }),
  useApplySuggestionMutation: () => ({
    mutateAsync: applyMutateAsync,
    isPending: false,
  }),
  useDismissSuggestionMutation: () => ({
    mutateAsync: dismissMutateAsync,
    isPending: false,
  }),
}));

// The document the mocked editor emits via onUpdate when the edit form is open.
// Duplicated inside the mock factory (below) to keep the factory self-contained.
const EDITED_DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "edited via editor" }] },
  ],
};

// CommentEditor pulls in the full TipTap editor stack; replace it with a stub.
// In edit mode the stub exposes buttons that fire the real onUpdate/onSave props
// so the edit->save/cancel flow can be driven without a live editor.
vi.mock("@/features/comment/components/comment-editor", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "edited via editor" }] },
    ],
  };
  return {
    default: ({ onUpdate, onSave }: any) => (
      <div data-testid="comment-editor">
        <button
          type="button"
          data-testid="editor-emit-update"
          onClick={() => onUpdate?.(doc)}
        />
        <button
          type="button"
          data-testid="editor-emit-save"
          onClick={() => onSave?.()}
        />
      </div>
    ),
  };
});

// CommentContentView (used for the read-only body) imports the mention view,
// which pulls page-query -> main.tsx (createRoot). Stub the queries so the item
// renders in isolation without the app entry side-effect.
vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useSharePageQuery: () => ({ data: undefined }),
}));

import CommentListItem from "./comment-list-item";
import {
  canShowApply,
  canShowDismiss,
} from "@/features/comment/utils/suggestion";

const baseComment = (over?: Partial<IComment>): IComment =>
  ({
    id: "c-1",
    content: JSON.stringify({ type: "doc", content: [] }),
    creatorId: "user-1",
    pageId: "page-1",
    workspaceId: "ws-1",
    createdAt: new Date(),
    creator: { id: "user-1", name: "Service Bot", avatarUrl: null } as any,
    ...over,
  }) as IComment;

function renderItem(
  comment: IComment,
  canEdit = true,
  canComment = true,
  userSpaceRole?: string,
) {
  return render(
    <MantineProvider>
      <CommentListItem
        comment={comment}
        pageId="page-1"
        canComment={canComment}
        canEdit={canEdit}
        userSpaceRole={userSpaceRole}
      />
    </MantineProvider>,
  );
}

describe("CommentListItem — agent avatar stack", () => {
  it('flips the hierarchy for an agent comment: agent primary, launcher shown once', () => {
    // Internal-chat shape with DISTINCT names so absence-of-duplication is
    // assertable: creator is the human "Alice", the acting agent is "Researcher".
    renderItem(
      baseComment({
        creator: { id: "user-1", name: "Alice", avatarUrl: null } as any,
        createdSource: "agent",
        aiChatId: "chat-1",
        agent: { name: "Researcher", emoji: "🔬", avatarUrl: null },
        launcher: { name: "Alice", avatarUrl: null },
      }),
    );
    // The AGENT is the primary label (the flipped hierarchy).
    expect(screen.getByText("Researcher")).toBeDefined();
    // The human launcher name shows exactly once — it is no longer duplicated as
    // a separate creator name (that duplication is the bug this fixes).
    expect(screen.getAllByText("Alice").length).toBe(1);
  });

  it('external MCP agent comment (no launcher): shows the agent name, no separator', () => {
    // aiChatId null => external MCP: the agent IS the account, no human behind.
    renderItem(
      baseComment({
        creator: { id: "bot-1", name: "MCP Bot", avatarUrl: null } as any,
        createdSource: "agent",
        aiChatId: null,
        agent: { name: "MCP Bot", avatarUrl: null },
        launcher: null,
      }),
    );
    expect(screen.getByText("MCP Bot")).toBeDefined();
    // No launcher => no dimmed "·" separator in the header.
    expect(screen.queryByText("·")).toBeNull();
  });

  it('does NOT render the stack for a normal user comment (createdSource "user")', () => {
    const { container } = renderItem(baseComment({ createdSource: "user" }));
    // No agent glyph (sparkles) is present for a plain human comment.
    expect(container.querySelector(".tabler-icon-sparkles")).toBeNull();
    expect(screen.getByText("Service Bot")).toBeDefined();
  });

  // The stack's own behaviors (glyph priority, launcher-behind, deep-link click)
  // are covered directly in agent-avatar-stack.test.tsx; this integration suite
  // only guards the insertion gate (agent → stack, user → no stack).
});

describe("canShowApply predicate", () => {
  const c = (over?: Partial<IComment>): IComment =>
    ({ suggestedText: "x", ...over }) as IComment;

  it("true when suggestion present, editable, not applied/resolved, top-level", () => {
    expect(canShowApply(c(), true)).toBe(true);
  });
  it("false without edit permission", () => {
    expect(canShowApply(c(), false)).toBe(false);
  });
  it("false when no suggestion", () => {
    expect(canShowApply(c({ suggestedText: null }), true)).toBe(false);
  });
  it("false when already applied", () => {
    expect(canShowApply(c({ suggestionAppliedAt: new Date() }), true)).toBe(
      false,
    );
  });
  it("false when resolved", () => {
    expect(canShowApply(c({ resolvedAt: new Date() }), true)).toBe(false);
  });
  it("false for a reply comment", () => {
    expect(canShowApply(c({ parentCommentId: "p" }), true)).toBe(false);
  });
});

describe("canShowDismiss predicate", () => {
  const c = (over?: Partial<IComment>): IComment =>
    ({ suggestedText: "x", ...over }) as IComment;

  it("true when suggestion present, can comment, owner/admin, not applied/resolved, top-level", () => {
    expect(canShowDismiss(c(), true, true)).toBe(true);
  });
  it("false without comment permission", () => {
    expect(canShowDismiss(c(), false, true)).toBe(false);
  });
  it("false when not owner and not admin (#338 F5)", () => {
    expect(canShowDismiss(c(), true, false)).toBe(false);
  });
  it("false when no suggestion", () => {
    expect(canShowDismiss(c({ suggestedText: null }), true, true)).toBe(false);
  });
  it("false when already applied", () => {
    expect(canShowDismiss(c({ suggestionAppliedAt: new Date() }), true, true)).toBe(
      false,
    );
  });
  it("false when resolved", () => {
    expect(canShowDismiss(c({ resolvedAt: new Date() }), true, true)).toBe(false);
  });
  it("false for a reply comment", () => {
    expect(canShowDismiss(c({ parentCommentId: "p" }), true, true)).toBe(false);
  });
});

describe("CommentListItem — edit -> save/cancel flow (#340 F3)", () => {
  const body = (t: string) =>
    JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
    });

  // The edit menu item is gated on the viewer owning the comment
  // (currentUser.id === creatorId). currentUserAtom is atomWithStorage-backed,
  // so seed localStorage to make the viewer the owner (creatorId "user-1").
  beforeEach(() => {
    updateMutateAsync.mockClear();
    localStorage.setItem(
      "currentUser",
      JSON.stringify({ user: { id: "user-1", name: "Owner" } }),
    );
  });
  afterEach(() => {
    localStorage.clear();
  });

  async function openEditor() {
    // Open the comment menu, then click "Edit comment" to toggle into edit mode.
    fireEvent.click(screen.getByLabelText("Comment menu"));
    fireEvent.click(await screen.findByText("Edit comment"));
    // Edit form (mocked editor + actions) is now mounted.
    await screen.findByTestId("comment-editor");
  }

  it("saves the edited content and, on cache update, shows the new body", async () => {
    const { rerender } = renderItem(
      baseComment({ content: body("original body") }),
    );
    // Static body first.
    expect(screen.getByText("original body")).toBeDefined();

    await openEditor();

    // Editor emits an update (populates editContentRef), then Save is clicked.
    fireEvent.click(screen.getByTestId("editor-emit-update"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // mutateAsync is called with the stringified edited doc.
    expect(updateMutateAsync).toHaveBeenCalledWith({
      commentId: "c-1",
      content: JSON.stringify(EDITED_DOC),
    });

    // On success the form closes (isEditing -> false); the static body renders
    // from the comment.content prop again.
    await waitFor(() =>
      expect(screen.queryByTestId("comment-editor")).toBeNull(),
    );

    // Simulate the cache invalidation swapping in a new comment object with the
    // updated content — the static body reflects it.
    rerender(
      <MantineProvider>
        <CommentListItem
          comment={baseComment({ content: body("updated body after save") })}
          pageId="page-1"
          canComment={true}
          canEdit={true}
        />
      </MantineProvider>,
    );
    expect(screen.getByText("updated body after save")).toBeDefined();
    expect(screen.queryByText("original body")).toBeNull();
  });

  it("cancel restores the static body and does not call the update mutation", async () => {
    renderItem(baseComment({ content: body("original body") }));
    await openEditor();

    // Type something (editContentRef set), then cancel.
    fireEvent.click(screen.getByTestId("editor-emit-update"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Editor unmounts, static body restored, no save happened.
    await waitFor(() =>
      expect(screen.queryByTestId("comment-editor")).toBeNull(),
    );
    expect(screen.getByText("original body")).toBeDefined();
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it("saving without editing sends the existing content (editContentRef cleared after cancel)", async () => {
    renderItem(baseComment({ content: body("original body") }));

    // Cancel path clears editContentRef...
    await openEditor();
    fireEvent.click(screen.getByTestId("editor-emit-update"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByTestId("comment-editor")).toBeNull(),
    );

    // ...so re-opening and saving WITHOUT an update falls back to comment.content.
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutateAsync).toHaveBeenCalledWith({
      commentId: "c-1",
      content: JSON.stringify(body("original body")),
    });
  });
});

describe("CommentListItem — read-only body renders statically", () => {
  it("renders the comment body as static text without a TipTap editor", () => {
    renderItem(
      baseComment({
        content: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Hello static world" }],
            },
          ],
        }),
      }),
    );
    // Body text is present...
    expect(screen.getByText("Hello static world")).toBeDefined();
    // ...and it did NOT go through the (mocked) CommentEditor instance.
    expect(screen.queryByTestId("comment-editor")).toBeNull();
  });
});
