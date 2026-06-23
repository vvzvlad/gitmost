import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { IComment } from "@/features/comment/types/comment.types";

// MantineProvider reads window.matchMedia on mount, which jsdom lacks.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

// The comment mutation hooks reach out to react-query/network — stub them so the
// component renders in isolation. We only assert the AI-badge rendering branch.
vi.mock("@/features/comment/queries/comment-query", () => ({
  useDeleteCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useResolveCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useUpdateCommentMutation: () => ({ mutateAsync: vi.fn() }),
}));

// CommentEditor pulls in the full TipTap editor stack; replace it with a stub.
vi.mock("@/features/comment/components/comment-editor", () => ({
  default: () => <div data-testid="comment-editor" />,
}));

import CommentListItem from "./comment-list-item";

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

function renderItem(comment: IComment) {
  return render(
    <MantineProvider>
      <CommentListItem comment={comment} pageId="page-1" canComment={true} />
    </MantineProvider>,
  );
}

describe("CommentListItem — AI badge", () => {
  it('renders the AI-agent badge when createdSource === "agent"', () => {
    renderItem(baseComment({ createdSource: "agent", aiChatId: null }));
    expect(screen.getByText("AI-agent")).toBeDefined();
    expect(screen.getByText("Service Bot")).toBeDefined();
  });

  it('does NOT render the badge for a normal user comment (createdSource "user")', () => {
    renderItem(baseComment({ createdSource: "user" }));
    expect(screen.queryByText("AI-agent")).toBeNull();
    expect(screen.getByText("Service Bot")).toBeDefined();
  });

  it("renders a non-clickable badge when aiChatId is null (external MCP agent)", () => {
    renderItem(baseComment({ createdSource: "agent", aiChatId: null }));
    expect(screen.getByText("AI-agent")).toBeDefined();
    // No deep-link target → no interactive button role.
    expect(screen.queryByRole("button")).toBeNull();
  });
});
