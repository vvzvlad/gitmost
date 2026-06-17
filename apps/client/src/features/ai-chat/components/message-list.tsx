import { useEffect, useRef } from "react";
import { Center, ScrollArea, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { UIMessage } from "@ai-sdk/react";
import MessageItem from "@/features/ai-chat/components/message-item.tsx";
import TypingIndicator from "@/features/ai-chat/components/typing-indicator.tsx";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface MessageListProps {
  messages: UIMessage[];
  isStreaming: boolean;
}

/** True for AI SDK tool parts (static `tool-*` or `dynamic-tool`). */
function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

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
 * Scrollable transcript. Auto-scrolls to the newest message as it streams in
 * (re-runs whenever the message count, the streaming flag, or the messages array
 * identity changes — the latter updates on every streamed delta).
 */
export default function MessageList({ messages, isStreaming }: MessageListProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const typing = showTypingIndicator(messages, isStreaming);

  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
