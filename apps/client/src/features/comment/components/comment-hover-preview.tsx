import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Paper } from "@mantine/core";
import { useCommentsQuery } from "@/features/comment/queries/comment-query";
import { IComment } from "@/features/comment/types/comment.types";
import { commentContentToText } from "@/features/comment/utils/comment-content-to-text";

interface CommentHoverPreviewProps {
  pageId: string;
  containerRef: React.RefObject<HTMLElement>;
}

// Delay before the card appears, to avoid flicker when the pointer quickly
// passes over comment marks.
const OPEN_DELAY_MS = 120;
const CARD_MAX_WIDTH = 320;
const GAP = 6;
// Reserve roughly this much room below the span; flip above when it doesn't fit.
const ESTIMATED_CARD_HEIGHT = 160;

interface HoverState {
  text: string;
  rect: { top: number; bottom: number; left: number };
}

function isResolved(comment: IComment): boolean {
  return comment.resolvedAt != null || comment.resolvedById != null;
}

/**
 * Shows a small floating card with the plain text of the parent comment when
 * the user hovers a `.comment-mark` span in the main editor. Read-only:
 * `pointer-events: none` so it never intercepts the mark's click (which opens
 * the side panel via ACTIVE_COMMENT_EVENT). Resolved/unknown marks show nothing.
 */
export default function CommentHoverPreview({
  pageId,
  containerRef,
}: CommentHoverPreviewProps) {
  const { data } = useCommentsQuery({ pageId });

  // Map of commentId -> comment. Only parent comments anchor marks, but indexing
  // every comment by id is harmless and keeps the lookup a single Map access.
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

      // Already tracking this span: nothing to do (avoids re-parsing the
      // comment content on every intra-span mousemove).
      if (span === activeSpanRef.current) return;

      const text = commentContentToText(comment.content);
      if (!text) return;

      activeSpanRef.current = span;

      clearOpenTimer();
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        if (activeSpanRef.current !== span || !span.isConnected) return;
        const rect = span.getBoundingClientRect();
        setHover({
          text,
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
        maxHeight: ESTIMATED_CARD_HEIGHT,
        overflow: "hidden",
        padding: "6px 10px",
        fontSize: "13px",
        lineHeight: 1.4,
        // Never intercept clicks targeting the comment-mark span beneath.
        pointerEvents: "none",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        display: "-webkit-box",
        WebkitLineClamp: 6,
        WebkitBoxOrient: "vertical",
      }}
    >
      {hover.text}
    </Paper>,
    document.body,
  );
}
