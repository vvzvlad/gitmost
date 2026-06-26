import { ReactNode, useEffect, useRef } from "react";
import { Center, ScrollArea, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { UIMessage } from "@ai-sdk/react";
import MessageItem from "@/features/ai-chat/components/message-item.tsx";
import TypingIndicator from "@/features/ai-chat/components/typing-indicator.tsx";
import { isToolPart, toolRunState, ToolUiPart } from "@/features/ai-chat/utils/tool-parts.tsx";
import { assistantMessageHasVisibleContent } from "@/features/ai-chat/utils/message-content.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface MessageListProps {
  messages: UIMessage[];
  isStreaming: boolean;
  /**
   * Content shown when the transcript is empty and no turn is in flight.
   * Defaults to the internal chat's prompt. The public share passes its own
   * documentation-focused copy. This is purely the empty-state text; the
   * streaming/typing/markdown/tool-card paths below are shared verbatim.
   */
  emptyState?: ReactNode;
  /**
   * Forwarded to MessageItem -> ToolCallCard: whether tool cards render page
   * citation links. Defaults to true (internal chat). The public share passes
   * false because an anonymous reader cannot open the linked internal pages.
   */
  showCitations?: boolean;
  /**
   * Forwarded to MessageItem: neutralize internal/relative markdown links in
   * the rendered answers (drop their href so they render as inert text).
   * Defaults to false (internal chat). The public share passes true so internal
   * UUIDs/routes don't leak as clickable links to anonymous readers.
   */
  neutralizeInternalLinks?: boolean;
  /**
   * Display name for the assistant's dimmed row label and typing indicator.
   * Defaults to "AI agent" when absent. The public share passes the configured
   * identity (agent role) name; the internal chat omits it.
   */
  assistantName?: string;
}

// Distance (px) from the bottom within which the viewport still counts as
// "pinned" — absorbs sub-pixel rounding and small content jitter.
const BOTTOM_THRESHOLD = 40;

/**
 * Whether to show the standalone "Thinking…" indicator. It bridges every
 * gap in a turn where the assistant is working but nothing visible is actively
 * being produced yet — so it shows while a turn is in flight AND the latest
 * assistant message's LAST part is not live output:
 *  - the last message is still the user's (assistant hasn't started a row), or
 *  - the assistant row has no parts yet, or
 *  - its last part is an empty/whitespace text part, or a finished ("done")
 *    text part while the turn continues (the model paused after some narration
 *    and is thinking about its next step), or
 *  - its last part is a finished/errored tool (the model is thinking about the
 *    next step between tool calls).
 * It hides only while output is actively rendering: a non-empty streaming text
 * part, or a tool that is still running (ToolCallCard shows its own Loader).
 */
export function showTypingIndicator(messages: UIMessage[], isStreaming: boolean): boolean {
  if (!isStreaming) return false;
  const last = messages[messages.length - 1];
  if (!last) return true; // submitted with nothing rendered yet.
  if (last.role !== "assistant") return true; // assistant row not started.
  const lastPart = last.parts[last.parts.length - 1];
  if (!lastPart) return true; // assistant row exists but has no parts yet.
  // The answer text is actively streaming in -> MessageItem renders it; no dots.
  // Only while it is STILL streaming, though: once a non-empty text part is
  // finalized ("done") but the turn is still in flight, the model has paused
  // after some narration and is working on its next step (e.g. about to call a
  // tool) — nothing is visibly progressing, so the dots must show. A text part
  // without a `state` is treated as still-rendering (kept suppressed); this
  // branch only runs while streaming, where live parts always carry a state.
  if (
    lastPart.type === "text" &&
    lastPart.text.trim().length > 0 &&
    (lastPart as { state?: "streaming" | "done" }).state !== "done"
  ) {
    return false;
  }
  // A tool still in flight shows its own Loader in ToolCallCard -> no dots.
  if (
    isToolPart(lastPart.type) &&
    toolRunState((lastPart as unknown as ToolUiPart).state) === "running"
  ) {
    return false;
  }
  // Otherwise the turn is in flight but nothing is actively producing visible
  // output yet: a finished/errored tool with no follow-up content, or an empty
  // trailing text part. The model is thinking between steps -> show the dots.
  return true;
}

/**
 * Whether the standalone typing indicator should render its own assistant-name
 * label. The indicator OWNS the name while the tail assistant row has no visible
 * content yet (an empty streaming text part, or reasoning/step-start while the
 * model is still thinking): in that gap the assistant MessageItem renders nothing,
 * so the indicator stands in for the nascent bubble (name + dots) at a constant
 * gap. It hides the name only once that row shows visible content, because then
 * MessageItem draws the same name — avoids a duplicate stacked label and the
 * layout jump that switching owners mid-stream used to cause.
 */
export function typingIndicatorShowsName(messages: UIMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return true;
  return !assistantMessageHasVisibleContent(last);
}

/**
 * Scrollable transcript. Auto-scrolls to the newest message as it streams in,
 * but only while the user is pinned to the bottom — if they scrolled up to read
 * earlier messages, streamed deltas no longer yank them back down.
 */
export default function MessageList({
  messages,
  isStreaming,
  emptyState,
  showCitations = true,
  neutralizeInternalLinks = false,
  assistantName,
}: MessageListProps) {
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
        {emptyState ?? (
          <Text size="sm" c="dimmed" ta="center">
            {t("Ask the AI agent anything about your workspace.")}
          </Text>
        )}
      </Center>
    );
  }

  return (
    <ScrollArea className={classes.messages} viewportRef={viewportRef} scrollbarSize={6} type="scroll">
      <Stack gap={0} pr="xs">
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            showCitations={showCitations}
            neutralizeInternalLinks={neutralizeInternalLinks}
            assistantName={assistantName}
          />
        ))}
        {typing && (
          <TypingIndicator
            assistantName={assistantName}
            showName={typingIndicatorShowsName(messages)}
          />
        )}
      </Stack>
    </ScrollArea>
  );
}
