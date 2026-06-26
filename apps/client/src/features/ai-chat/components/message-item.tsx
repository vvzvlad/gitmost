import { memo } from "react";
import { Box, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { UIMessage } from "@ai-sdk/react";
import ToolCallCard from "@/features/ai-chat/components/tool-call-card.tsx";
import ReasoningBlock from "@/features/ai-chat/components/reasoning-block.tsx";
import ChatErrorAlert from "@/features/ai-chat/components/chat-error-alert.tsx";
import ChatStoppedNotice from "@/features/ai-chat/components/chat-stopped-notice.tsx";
import { ToolUiPart, isToolPart } from "@/features/ai-chat/utils/tool-parts.tsx";
import { assistantMessageHasVisibleContent } from "@/features/ai-chat/utils/message-content.ts";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";
import { resolveAssistantName } from "@/features/ai-chat/utils/assistant-name.ts";
import { reasoningTokensForPart } from "@/features/ai-chat/utils/reasoning-tokens.ts";
import { messageSignature } from "@/features/ai-chat/utils/message-signature.ts";
import { describeChatError } from "@/features/ai-chat/utils/error-message.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface MessageItemProps {
  message: UIMessage;
  /**
   * Forwarded to ToolCallCard: whether tool cards render page citation links.
   * Defaults to true (internal chat). The public share passes false.
   */
  showCitations?: boolean;
  /**
   * Neutralize internal/relative markdown links in the rendered answer (drop
   * their href so they become inert text). Defaults to false (internal chat,
   * links stay clickable). The anonymous public share passes true so internal
   * UUIDs/routes in the assistant's markdown don't leak as clickable links.
   */
  neutralizeInternalLinks?: boolean;
  /**
   * Display name for the dimmed assistant label. Defaults to "AI agent" when
   * absent; the public share passes the configured identity (agent role) name.
   */
  assistantName?: string;
}

/**
 * One assistant text part rendered as sanitized markdown. Memoized on its inputs
 * so a finalized text part is NOT re-parsed on every streamed delta: during a
 * turn only the actively-growing tail part changes its `text`, so every earlier
 * part hits the memo and skips the expensive marked + DOMPurify pass. Props are
 * primitives, so React.memo's default shallow compare is exactly right (the
 * `text` string is compared by value).
 */
const MarkdownPart = memo(function MarkdownPart({
  text,
  neutralizeInternalLinks,
}: {
  text: string;
  neutralizeInternalLinks: boolean;
}) {
  const html = renderChatMarkdown(text, { neutralizeInternalLinks });
  if (html) {
    return (
      <div
        className={classes.markdown}
        // Sanitized by renderChatMarkdown (DOMPurify) before insertion.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  // Fallback when markdown could not render synchronously: raw text.
  return (
    <Text className={classes.markdown} style={{ whiteSpace: "pre-wrap" }}>
      {text}
    </Text>
  );
});

/**
 * Render a single UIMessage by iterating its `parts`:
 *  - `text` parts -> sanitized markdown.
 *  - `tool-*` / `dynamic-tool` parts -> an action-log card (with citations).
 * Other part kinds (reasoning, sources, files, step-start) are ignored for v1.
 * User messages render their text as a right-aligned plain bubble.
 *
 * This component is memoized (see `arePropsEqual` at the bottom) on a cheap
 * per-message content signature: the streaming TAIL message's signature changes
 * on each delta so it still re-renders and streams in, while finalized rows are
 * skipped. Each text part's markdown is itself memoized via `MarkdownPart`, so a
 * long turn no longer re-parses the whole transcript on every token.
 */
function MessageItem({
  message,
  showCitations = true,
  neutralizeInternalLinks = false,
  assistantName,
}: MessageItemProps) {
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

  // An assistant message with nothing visible to render yet (an empty streaming
  // text part, or a reasoning/step-start part while the model is still thinking)
  // renders nothing here. The standalone TypingIndicator stands in for the nascent
  // bubble (name + dots) until real content arrives, so exactly one element owns
  // the agent name during the pre-content gap and the layout never jumps. Persisted
  // errored/aborted turns DO have visible content per the helper (metadata.error /
  // finishReason === "aborted"), so their banners below still render — this early
  // return won't fire for them.
  if (!assistantMessageHasVisibleContent(message)) return null;

  // Authoritative reasoning token count to attribute to a reasoning block, or
  // undefined when the block must estimate on its own. See reasoningTokensForPart
  // for the #151 anti-double-count rule (only a single reasoning part may carry
  // the turn total). The authoritative turn total is still surfaced live in the
  // header badge regardless.
  const reasoningTokens = reasoningTokensForPart(message);

  return (
    <Box className={classes.messageRow}>
      <Text size="xs" c="dimmed" mb={4}>
        {resolveAssistantName(assistantName) ?? t("AI agent")}
      </Text>
      {message.parts.map((part, index) => {
        if (part.type === "reasoning") {
          // Reasoning ("thinking") -> a collapsible block with its own token
          // count. Empty/whitespace reasoning with no authoritative count carries
          // nothing to show, so skip it (avoids an empty 0-token block).
          const text = (part as { text?: string }).text ?? "";
          if (!text.trim() && !(reasoningTokens && reasoningTokens > 0))
            return null;
          return (
            <ReasoningBlock key={index} text={text} tokens={reasoningTokens} />
          );
        }

        if (part.type === "text") {
          // Skip empty/whitespace-only text parts (a streaming message often
          // starts with an empty text part before the first token arrives); the
          // typing indicator covers that gap until real content streams in.
          if (!part.text.trim()) return null;
          return (
            <MarkdownPart
              key={index}
              text={part.text}
              neutralizeInternalLinks={neutralizeInternalLinks}
            />
          );
        }

        if (isToolPart(part.type)) {
          return (
            <ToolCallCard
              key={index}
              part={part as unknown as ToolUiPart}
              showCitations={showCitations}
            />
          );
        }

        return null;
      })}
      {/* A persisted turn error (server stored it in metadata.error). Rendered
          here so it survives a thread remount and shows in reopened history. */}
      {(() => {
        const errorText = (message.metadata as { error?: string } | undefined)?.error;
        if (!errorText) return null;
        // Same classified-error banner as the live chat: a heading naming the
        // cause plus a one-line detail.
        const errorView = describeChatError(errorText, t);
        return (
          <ChatErrorAlert
            title={errorView.title}
            detail={errorView.detail}
            mt={4}
          />
        );
      })()}
      {/* A persisted turn that was aborted (manual Stop or a dropped connection)
          with no error banner. The server cannot tell a manual Stop from a
          connection drop (both persist as finishReason 'aborted'), so reopened
          history uses a combined wording. */}
      {(() => {
        const meta = message.metadata as
          | { error?: string; finishReason?: string }
          | undefined;
        if (meta?.error || meta?.finishReason !== "aborted") return null;
        return (
          <ChatStoppedNotice
            text={t("Response stopped (manually or the connection dropped).")}
            mt={4}
          />
        );
      })()}
    </Box>
  );
}

/** Skip re-rendering a message whose visible content is unchanged. The streaming
 *  TAIL message gets a fresh object whose signature changes each delta, so it
 *  still re-renders and streams in; every FINALIZED message is skipped, turning a
 *  per-token whole-transcript re-render into a tail-only one. */
export function arePropsEqual(
  prev: MessageItemProps,
  next: MessageItemProps,
): boolean {
  if (
    prev.showCitations !== next.showCitations ||
    prev.neutralizeInternalLinks !== next.neutralizeInternalLinks ||
    prev.assistantName !== next.assistantName
  ) {
    return false;
  }
  // Fast path: identical message object (finalized rows keep their identity
  // across deltas) — skip without building signatures.
  if (prev.message === next.message) return true;
  return messageSignature(prev.message) === messageSignature(next.message);
}

export default memo(MessageItem, arePropsEqual);
