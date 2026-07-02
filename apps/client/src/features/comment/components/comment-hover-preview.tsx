import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Paper, Text } from "@mantine/core";
import { useCommentsQuery } from "@/features/comment/queries/comment-query";
import { IComment } from "@/features/comment/types/comment.types";
import { commentContentToText } from "@/features/comment/utils/comment-content-to-text";

interface CommentHoverPreviewProps {
  pageId: string;
  containerRef: React.RefObject<HTMLElement>;
}

// Delay before the card appears, to avoid flicker when the pointer quickly
// passes over comment marks (kept generous so it does not pop up on a passing
// glance).
const OPEN_DELAY_MS = 350;
const CARD_MAX_WIDTH = 360;
const CARD_MAX_HEIGHT = 300;
const GAP = 6;
// Reserve roughly this much room below the span; flip above when it doesn't fit.
// Match CARD_MAX_HEIGHT so the flip-above decision reserves the real worst-case
// height — otherwise a tall thread placed below near the viewport bottom passes
// the "fits below" check and then overflows off-screen (clipped, no scroll).
const ESTIMATED_CARD_HEIGHT = 300;

// One rendered line of the thread: the author and the comment's plain text,
// pre-computed at hover time so render stays cheap. Shown as "Author: text".
interface ThreadRow {
  id: string;
  name: string;
  text: string;
}

interface HoverState {
  thread: ThreadRow[];
  rect: { top: number; bottom: number; left: number };
}

function isResolved(comment: IComment): boolean {
  return comment.resolvedAt != null || comment.resolvedById != null;
}

// Build the thread for a root (parent) comment: the root first, followed by its
// replies sorted by createdAt ascending. Reads every comment from the map.
function buildThread(
  commentMap: Map<string, IComment>,
  root: IComment,
): ThreadRow[] {
  const replies: IComment[] = [];
  commentMap.forEach((comment) => {
    if (comment.parentCommentId === root.id) replies.push(comment);
  });
  replies.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return [root, ...replies].map((comment) => ({
    id: comment.id,
    name: comment.creator?.name ?? "",
    text: commentContentToText(comment.content),
  }));
}

/**
 * Shows a small floating card when the user hovers a `.comment-mark` span in the
 * main editor: the parent comment plus all its replies, one per line as
 * "Author: text" (plain — no avatars or timestamps). Read-only:
 * `pointer-events: none` so it never intercepts the mark's click (which opens
 * the side panel via ACTIVE_COMMENT_EVENT). Resolved/unknown marks show nothing.
 */
export default function CommentHoverPreview({
  pageId,
  containerRef,
}: CommentHoverPreviewProps) {
  const { data } = useCommentsQuery({ pageId });

  // Map of commentId -> comment. The map indexes every comment (parents and
  // replies) so a thread can be assembled from a single source.
  const commentMap = useMemo(() => {
    const map = new Map<string, IComment>();
    data?.items?.forEach((comment) => map.set(comment.id, comment));
    return map;
  }, [data]);

  // Read the latest map from the delegated listeners without re-attaching them
  // every time the comments query refreshes.
  const commentMapRef = useRef(commentMap);
  useEffect(() => {
    commentMapRef.current = commentMap;
  }, [commentMap]);

  const [hover, setHover] = useState<HoverState | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSpanRef = useRef<HTMLElement | null>(null);

  const clearOpenTimer = () => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };

  const hide = () => {
    clearOpenTimer();
    activeSpanRef.current = null;
    setHover(null);
  };

  // Hide and reset when the page changes (the comment set belongs to a page):
  // the cleanup runs on every pageId change before the effect re-runs.
  useEffect(() => {
    return () => hide();
  }, [pageId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseOver = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const span = target?.closest<HTMLElement>(
        ".comment-mark[data-comment-id]",
      );
      if (!span) return;

      const commentId = span.getAttribute("data-comment-id");
      if (!commentId) return;

      const comment = commentMapRef.current.get(commentId);
      // Unknown (not loaded yet) or resolved -> no tooltip. Resolved marks also
      // carry data-resolved="true"; check both the data attribute and the model.
      if (
        !comment ||
        span.hasAttribute("data-resolved") ||
        isResolved(comment)
      ) {
        return;
      }

      // Already tracking this span: nothing to do (avoids re-building the thread
      // on every intra-span mousemove).
      if (span === activeSpanRef.current) return;

      const thread = buildThread(commentMapRef.current, comment);
      // Show the card only when SOME comment has text. Gating on thread length
      // could open an empty card (a text-less root whose only reply is also
      // text-less), since the render filters out empty-text rows.
      const hasContent = thread.some((row) => row.text.length > 0);
      if (!hasContent) return;

      activeSpanRef.current = span;

      clearOpenTimer();
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        if (activeSpanRef.current !== span || !span.isConnected) return;
        const rect = span.getBoundingClientRect();
        setHover({
          thread,
          rect: { top: rect.top, bottom: rect.bottom, left: rect.left },
        });
      }, OPEN_DELAY_MS);
    };

    const handleMouseOut = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const span = target?.closest<HTMLElement>(
        ".comment-mark[data-comment-id]",
      );
      if (!span) return;

      // Ignore moves that stay within the same comment-mark span.
      const related = event.relatedTarget as HTMLElement | null;
      if (related && span.contains(related)) return;

      if (span === activeSpanRef.current) hide();
    };

    // Scroll uses capture so it also catches scrolling inside nested containers.
    const handleScroll = () => hide();
    const handleResize = () => hide();
    // Dismiss on press: clicking a mark opens the side panel, and the card
    // would otherwise linger (no mouseout fires while the pointer stays put).
    const handleMouseDown = () => hide();

    container.addEventListener("mouseover", handleMouseOver);
    container.addEventListener("mouseout", handleMouseOut);
    container.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);

    return () => {
      container.removeEventListener("mouseover", handleMouseOver);
      container.removeEventListener("mouseout", handleMouseOut);
      container.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      clearOpenTimer();
    };
  }, [containerRef]);

  if (!hover) return null;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  // Flip above when there isn't enough room below the span.
  const placeAbove =
    hover.rect.bottom + ESTIMATED_CARD_HEIGHT > viewportHeight &&
    hover.rect.top > ESTIMATED_CARD_HEIGHT;

  const left = Math.max(
    8,
    Math.min(hover.rect.left, viewportWidth - CARD_MAX_WIDTH - 8),
  );

  const positionStyle: React.CSSProperties = placeAbove
    ? { bottom: viewportHeight - hover.rect.top + GAP }
    : { top: hover.rect.bottom + GAP };

  return createPortal(
    <Paper
      withBorder
      shadow="md"
      radius="sm"
      role="tooltip"
      data-testid="comment-hover-preview"
      style={{
        position: "fixed",
        left,
        ...positionStyle,
        zIndex: 1000,
        maxWidth: CARD_MAX_WIDTH,
        // The card is pointer-events:none, so it can't scroll; clamp long
        // threads instead (most threads are short).
        maxHeight: CARD_MAX_HEIGHT,
        overflow: "hidden",
        padding: "8px 10px",
        fontSize: "13px",
        lineHeight: 1.4,
        // Never intercept clicks targeting the comment-mark span beneath.
        pointerEvents: "none",
        wordBreak: "break-word",
      }}
    >
      {hover.thread
        // A comment with no plain text (e.g. an image-only reply) adds nothing
        // to a text preview — skip its line.
        .filter((row) => row.text.length > 0)
        .map((row) => (
          <Text
            key={row.id}
            size="xs"
            mt={4}
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {/* "Author: text" — one line per comment, parent then replies. */}
            <Text span fw={600}>
              {row.name}:
            </Text>{" "}
            {row.text}
          </Text>
        ))}
    </Paper>,
    document.body,
  );
}
