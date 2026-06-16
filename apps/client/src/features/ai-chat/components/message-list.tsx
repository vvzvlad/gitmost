import { useEffect, useRef } from "react";
import { Center, ScrollArea, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { UIMessage } from "@ai-sdk/react";
import MessageItem from "@/features/ai-chat/components/message-item.tsx";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface MessageListProps {
  messages: UIMessage[];
  isStreaming: boolean;
}

/**
 * Scrollable transcript. Auto-scrolls to the newest message as it streams in
 * (re-runs whenever the message count or the streaming flag changes).
 */
export default function MessageList({ messages, isStreaming }: MessageListProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, isStreaming, messages]);

  if (messages.length === 0) {
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
      </Stack>
    </ScrollArea>
  );
}
