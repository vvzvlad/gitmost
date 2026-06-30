import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useRef } from "react";
import { MantineProvider } from "@mantine/core";
import { IComment } from "@/features/comment/types/comment.types";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// Stub the comments query so the component renders without react-query/network.
const mockUseCommentsQuery = vi.fn();
vi.mock("@/features/comment/queries/comment-query", () => ({
  useCommentsQuery: (params: { pageId: string }) =>
    mockUseCommentsQuery(params),
}));

import CommentHoverPreview from "./comment-hover-preview";
import { commentContentToText } from "@/features/comment/utils/comment-content-to-text";

const doc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

const comment = (over?: Partial<IComment>): IComment =>
  ({
    id: "c-1",
    content: doc("Hello world"),
    creatorId: "u-1",
    pageId: "page-1",
    workspaceId: "ws-1",
    createdAt: new Date(),
    creator: { id: "u-1", name: "User", avatarUrl: null } as any,
    ...over,
  }) as IComment;

function setComments(items: IComment[]) {
  mockUseCommentsQuery.mockReturnValue({
    data: { items, meta: {} },
    isLoading: false,
    isError: false,
  });
}

// Test harness: owns the container ref, hosts a comment-mark span and the
// preview component, mirroring how page-editor mounts it next to EditorContent.
function Harness({
  spanAttrs = { "data-comment-id": "c-1" },
  pageId = "page-1",
}: {
  spanAttrs?: Record<string, string>;
  pageId?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <MantineProvider>
      <div ref={containerRef}>
        <span data-testid="mark" className="comment-mark" {...spanAttrs}>
          marked text
        </span>
        <CommentHoverPreview pageId={pageId} containerRef={containerRef} />
      </div>
    </MantineProvider>
  );
}

function hoverMark() {
  const span = screen.getByTestId("mark");
  act(() => {
    span.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

function leaveMark() {
  const span = screen.getByTestId("mark");
  act(() => {
    span.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  });
}

describe("commentContentToText", () => {
  it("flattens a multi-node ProseMirror doc to plain text", () => {
    const content = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
      ],
    });
    expect(commentContentToText(content)).toBe("Hello world\nSecond line");
  });

  it("joins nested block structures (lists) on block boundaries", () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "two" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(commentContentToText(content)).toBe("one\ntwo");
  });

  it("accepts an already-parsed object", () => {
    expect(commentContentToText({ type: "doc", content: [] })).toBe("");
  });

  it("returns '' for empty / missing / malformed content", () => {
    expect(commentContentToText("")).toBe("");
    expect(commentContentToText("   ")).toBe("");
    expect(commentContentToText(undefined)).toBe("");
    expect(commentContentToText(null)).toBe("");
    expect(commentContentToText(JSON.stringify({ type: "doc", content: [] }))).toBe(
      "",
    );
  });

  it("falls back to the raw string when content is not JSON", () => {
    expect(commentContentToText("plain text")).toBe("plain text");
  });

  it("preserves a hardBreak inside a paragraph as a newline", () => {
    const content = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line1" },
            { type: "hardBreak" },
            { type: "text", text: "line2" },
          ],
        },
      ],
    });
    expect(commentContentToText(content)).toBe("line1\nline2");
  });
});

describe("CommentHoverPreview — hover behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockUseCommentsQuery.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("shows the comment text after the open delay", () => {
    setComments([comment()]);
    render(<Harness />);

    hoverMark();
    // Before the delay elapses there is no card.
    expect(screen.queryByTestId("comment-hover-preview")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(120);
    });
    const card = screen.getByTestId("comment-hover-preview");
    expect(card.textContent).toBe("Hello world");
    // The card MUST NOT intercept the mark's click (which opens the side panel):
    // pointer-events:none is the single property guaranteeing that — lock it so
    // a regression dropping it from the style object fails here.
    expect(card.style.pointerEvents).toBe("none");
  });

  it("hides on mouseout", () => {
    setComments([comment()]);
    render(<Harness />);

    hoverMark();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.getByTestId("comment-hover-preview").textContent).toBe(
      "Hello world",
    );

    leaveMark();
    expect(screen.queryByTestId("comment-hover-preview")).toBeNull();
  });

  it("does not show a card for a resolved comment (data-resolved)", () => {
    setComments([comment()]);
    render(
      <Harness
        spanAttrs={{ "data-comment-id": "c-1", "data-resolved": "true" }}
      />,
    );

    hoverMark();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("comment-hover-preview")).toBeNull();
  });

  it("does not show a card for a resolved comment (resolvedAt set)", () => {
    setComments([comment({ resolvedAt: new Date() })]);
    render(<Harness />);

    hoverMark();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("comment-hover-preview")).toBeNull();
  });

  it("does not show a card for an unknown comment id", () => {
    setComments([comment()]);
    render(<Harness spanAttrs={{ "data-comment-id": "missing" }} />);

    hoverMark();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("comment-hover-preview")).toBeNull();
  });

  it("does not show a card when the comment text is empty", () => {
    setComments([comment({ content: JSON.stringify({ type: "doc", content: [] }) })]);
    render(<Harness />);

    hoverMark();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("comment-hover-preview")).toBeNull();
  });

  it("hides on scroll", () => {
    setComments([comment()]);
    render(<Harness />);

    hoverMark();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.getByTestId("comment-hover-preview").textContent).toBe(
      "Hello world",
    );

    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByTestId("comment-hover-preview")).toBeNull();
  });

  it("hides on mousedown (clicking the mark to open the panel dismisses the card)", () => {
    setComments([comment()]);
    render(<Harness />);

    hoverMark();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.getByTestId("comment-hover-preview").textContent).toBe(
      "Hello world",
    );

    const span = screen.getByTestId("mark");
    act(() => {
      span.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(screen.queryByTestId("comment-hover-preview")).toBeNull();
  });

  it("does not hide when the pointer moves WITHIN the same span (anti-flicker)", () => {
    setComments([comment()]);
    render(<Harness />);

    hoverMark();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.queryByTestId("comment-hover-preview")).not.toBeNull();

    // mouseout whose relatedTarget is still inside the span must NOT hide.
    const span = screen.getByTestId("mark");
    act(() => {
      span.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: span }),
      );
    });
    expect(screen.queryByTestId("comment-hover-preview")).not.toBeNull();
  });

  it("hides when the page changes", () => {
    setComments([comment()]);
    const { rerender } = render(<Harness pageId="page-1" />);

    hoverMark();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.queryByTestId("comment-hover-preview")).not.toBeNull();

    act(() => {
      rerender(<Harness pageId="page-2" />);
    });
    expect(screen.queryByTestId("comment-hover-preview")).toBeNull();
  });
});
