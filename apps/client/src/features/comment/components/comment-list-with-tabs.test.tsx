import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { IComment } from "@/features/comment/types/comment.types";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// CommentEditor pulls in the full TipTap editor stack; replace it with a stub so
// the lazy reply editor's mount transition can be observed without the editor.
vi.mock("@/features/comment/components/comment-editor", () => ({
  default: () => <div data-testid="comment-editor" />,
}));

// page-query -> main.tsx (createRoot) is a module side effect; stub the queries
// pulled in transitively so importing the module is side-effect free.
vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useSharePageQuery: () => ({ data: undefined }),
}));
// space-query -> main.tsx (createRoot) is another module side effect; stub it.
vi.mock("@/features/space/queries/space-query.ts", () => ({
  useGetSpaceBySlugQuery: () => ({ data: undefined }),
}));

import {
  buildChildrenByParent,
  CommentEditorWithActions,
  sortResolvedByResolvedAt,
} from "./comment-list-with-tabs";

const c = (id: string, parentCommentId: string | null = null): IComment =>
  ({ id, parentCommentId }) as IComment;

const resolvedAtComment = (id: string, resolvedAt: unknown): IComment =>
  ({ id, resolvedAt }) as unknown as IComment;

describe("buildChildrenByParent (childrenByParent grouping)", () => {
  it("returns an empty map for undefined or empty input", () => {
    expect(buildChildrenByParent(undefined).size).toBe(0);
    expect(buildChildrenByParent([]).size).toBe(0);
  });

  it("does not index a top-level comment (parentCommentId null)", () => {
    const map = buildChildrenByParent([c("p1", null)]);
    expect(map.size).toBe(0);
    expect(map.has("p1")).toBe(false);
  });

  it("groups replies under the correct parent, including reply-to-reply nesting", () => {
    const p1 = c("p1", null);
    const r1 = c("r1", "p1");
    const r2 = c("r2", "r1"); // a reply to a reply
    const map = buildChildrenByParent([p1, r1, r2]);
    expect(map.get("p1")).toEqual([r1]);
    expect(map.get("r1")).toEqual([r2]);
    // The top-level comment itself is never a key.
    expect(map.has("p1") && map.get("p1")?.length).toBe(1);
  });

  it("still groups a reply whose parent is not present in items", () => {
    const orphan = c("o1", "missing-parent");
    const map = buildChildrenByParent([orphan]);
    expect(map.get("missing-parent")).toEqual([orphan]);
  });

  it("preserves insertion order among sibling replies", () => {
    const map = buildChildrenByParent([
      c("a", "p1"),
      c("b", "p1"),
      c("d", "p1"),
    ]);
    expect(map.get("p1")?.map((x) => x.id)).toEqual(["a", "b", "d"]);
  });
});

describe("sortResolvedByResolvedAt (Resolved tab order, #542)", () => {
  it("orders by resolvedAt DESC — newest resolve first — with ISO-STRING values", () => {
    // At runtime resolvedAt is an ISO string (axios JSON / WS subscription), so
    // the sort must coerce with new Date(...) before .getTime().
    const older = resolvedAtComment("older", "2026-07-10T10:00:00.000Z");
    const newest = resolvedAtComment("newest", "2026-07-12T10:00:00.000Z");
    const middle = resolvedAtComment("middle", "2026-07-11T10:00:00.000Z");

    const out = sortResolvedByResolvedAt([older, newest, middle]);
    expect(out.map((x) => x.id)).toEqual(["newest", "middle", "older"]);
  });

  it("also handles Date instances (optimistic onMutate window)", () => {
    const older = resolvedAtComment("older", new Date("2026-01-01T00:00:00Z"));
    const newer = resolvedAtComment("newer", new Date("2026-06-01T00:00:00Z"));
    expect(sortResolvedByResolvedAt([older, newer]).map((x) => x.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("does not mutate the input array", () => {
    const a = resolvedAtComment("a", "2026-01-01T00:00:00.000Z");
    const b = resolvedAtComment("b", "2026-02-01T00:00:00.000Z");
    const input = [a, b];
    sortResolvedByResolvedAt(input);
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("keeps stable order for equal resolvedAt timestamps", () => {
    const ts = "2026-03-03T03:03:03.000Z";
    const x = resolvedAtComment("x", ts);
    const y = resolvedAtComment("y", ts);
    const z = resolvedAtComment("z", ts);
    expect(sortResolvedByResolvedAt([x, y, z]).map((c) => c.id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });
});

function renderReplyEditor() {
  return render(
    <MantineProvider>
      <CommentEditorWithActions commentId="c-1" onSave={vi.fn()} />
    </MantineProvider>,
  );
}

describe("CommentEditorWithActions — lazy reply editor activation", () => {
  it("shows only the stub initially (no editor instance mounted)", () => {
    renderReplyEditor();
    expect(screen.getByRole("button")).toBeDefined();
    expect(screen.queryByTestId("comment-editor")).toBeNull();
  });

  it("mounts the real editor when the stub is clicked and keeps it mounted", () => {
    renderReplyEditor();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("comment-editor")).toBeDefined();
    // The stub button is replaced by the editor subtree.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("mounts the editor when the stub receives focus", () => {
    renderReplyEditor();
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByTestId("comment-editor")).toBeDefined();
  });

  it("mounts the editor on Enter keydown of the stub", () => {
    renderReplyEditor();
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    expect(screen.getByTestId("comment-editor")).toBeDefined();
  });
});
