import { Box, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { UIMessage } from "@ai-sdk/react";
import ToolCallCard from "@/features/ai-chat/components/tool-call-card.tsx";
import { ToolUiPart } from "@/features/ai-chat/utils/tool-parts.tsx";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface MessageItemProps {
  message: UIMessage;
}

/** True for AI SDK tool parts (static `tool-*` or `dynamic-tool`). */
function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

/**
 * Render a single UIMessage by iterating its `parts`:
 *  - `text` parts -> sanitized markdown.
 *  - `tool-*` / `dynamic-tool` parts -> an action-log card (with citations).
 * Other part kinds (reasoning, sources, files, step-start) are ignored for v1.
 * User messages render their text as a right-aligned plain bubble.
 *
 * This component is intentionally NOT memoized: `useChat` replaces the streaming
 * assistant message with a freshly cloned object on every streamed delta, so the
 * `message` prop identity (and its `parts`) changes each tick. Re-rendering the
 * text parts on each delta is what makes the answer stream in progressively.
 */
export default function MessageItem({ message }: MessageItemProps) {
  const { t } = useTranslation();
  const isUser = message.role === "user";

  if (isUser) {
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    return (
      <Box className={classes.messageRow} style={{ display: "flex", justifyContent: "flex-end" }}>
        <Box className={classes.userBubble} maw="85%">
          {text}
        </Box>
      </Box>
    );
  }

  return (
    <Box className={classes.messageRow}>
      <Text size="xs" c="dimmed" mb={4}>
        {t("AI agent")}
      </Text>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          // Skip empty/whitespace-only text parts (a streaming message often
          // starts with an empty text part before the first token arrives); the
          // typing indicator covers that gap until real content streams in.
          if (!part.text.trim()) return null;
          const html = renderChatMarkdown(part.text);
          if (html) {
            return (
              <div
                key={index}
                className={classes.markdown}
                // Sanitized by renderChatMarkdown (DOMPurify) before insertion.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          }
          // Fallback when markdown could not render synchronously: raw text.
          return (
            <Text key={index} className={classes.markdown} style={{ whiteSpace: "pre-wrap" }}>
              {part.text}
            </Text>
          );
        }

        if (isToolPart(part.type)) {
          return <ToolCallCard key={index} part={part as unknown as ToolUiPart} />;
        }

        return null;
      })}
    </Box>
  );
}
