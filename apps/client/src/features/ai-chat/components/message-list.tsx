import { useEffect, useRef } from "react";
import { Center, ScrollArea, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { UIMessage } from "@ai-sdk/react";
import MessageItem from "@/features/ai-chat/components/message-item.tsx";
import TypingIndicator from "@/features/ai-chat/components/typing-indicator.tsx";
import { isToolPart } from "@/features/ai-chat/utils/tool-parts.tsx";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface MessageListProps {
  messages: UIMessage[];
  isStreaming: boolean;
}

// Distance (px) from the bottom within which the viewport still counts as
// "pinned" — absorbs sub-pixel rounding and small content jitter.
const BOTTOM_THRESHOLD = 40;

/**
 * Whether to show the standalone "AI agent is typing…" indicator. It bridges the
 * gap between sending and the first streamed content, so it shows only while a
 * turn is in flight AND the latest assistant message has nothing visible yet:
 *  - the last message is still the user's (assistant hasn't started a row), or
 *  - the last (assistant) message has no non-empty text and no tool part.
 * Once any text/tool part arrives, MessageItem renders it and this hides.
 */
function showTypingIndicator(messages: UIMessage[], isStreaming: boolean): boolean {
  if (!isStreaming) return false;
  const last = messages[messages.length - 1];
  if (!last) return true; // submitted with nothing rendered yet.
  if (last.role !== "assistant") return true; // assistant row not started.
  const hasVisible = last.parts.some(
    (p) =>
      (p.type === "text" && p.text.trim().length > 0) || isToolPart(p.type),
  );
  return !hasVisible;
}

/**
 * Scrollable transcript. Auto-scrolls to the newest message as it streams in,
 * but only while the user is pinned to the bottom — if they scrolled up to read
 * earlier messages, streamed deltas no longer yank them back down.
 */
export default function MessageList({ messages, isStreaming }: MessageListProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  // Whether the viewport is currently pinned to the bottom. Starts true so the
  // first render scrolls down; flips to false as soon as the user scrolls up,
  // which suppresses the streaming auto-scroll until they return to the bottom.
  const pinnedToBottomRef = useRef(true);
  // Guards the auto-scroll effect's own scrollTop write from being misread as a
  // user scroll by the listener below. Armed only when we actually move the
  // viewport, so it always pairs with exactly one resulting scroll event.
  const programmaticScrollRef = useRef(false);
  const typing = showTypingIndicator(messages, isStreaming);
  // The ScrollArea is only mounted once there is something to show; track that so
  // the scroll listener below re-attaches when the viewport first appears. Without
  // this dependency, a brand-new chat that starts empty would never wire up the
  // listener (the empty-state branch renders no ScrollArea, so viewportRef is null
  // on first mount and the [] effect never re-runs).
  const hasScrollArea = messages.length > 0 || typing;

  // Track the user's scroll position so streaming updates only follow the newest
  // content while the user is at the bottom. Mantine's ScrollArea exposes the
  // inner viewport via viewportRef; listen to its scroll events directly.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      // Ignore the single scroll event our own auto-scroll write triggers, so it
      // can't be misread as the user leaving the bottom.
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      pinnedToBottomRef.current = distanceFromBottom <= BOTTOM_THRESHOLD;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasScrollArea]);

  // Auto-scroll to the newest content as it streams in, but ONLY while pinned to
  // the bottom. If the user scrolled up to read earlier messages, leave their
  // position untouched so streamed deltas don't yank them back down. A freshly
  // sent user message always re-pins, so sending always brings the view down.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (last?.role === "user") pinnedToBottomRef.current = true;
    if (!pinnedToBottomRef.current) return;
    const target = el.scrollHeight - el.clientHeight;
    // Only write (and arm the guard) when we'd actually move; assigning the same
    // value fires no scroll event and would otherwise leave the guard armed and
    // swallow the user's next real scroll.
    if (el.scrollTop < target) {
      programmaticScrollRef.current = true;
      el.scrollTop = target;
    }
  }, [messages.length, isStreaming, messages, typing]);

  if (messages.length === 0 && !typing) {
    return (
      <Center className={classes.messages}>
        <Text size="sm" c="dimmed" ta="center">
          {t("Ask the AI agent anything about your workspace.")}
        </Text>
      </Center>
    );
  }

  return (
    <ScrollArea className={classes.messages} viewportRef={viewportRef} scrollbarSize={6} type="scroll">
      <Stack gap={0} pr="xs">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
        {typing && <TypingIndicator />}
      </Stack>
    </ScrollArea>
  );
}
