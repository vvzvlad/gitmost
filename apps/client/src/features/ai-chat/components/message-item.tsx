import { memo } from "react";
import { Box, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { UIMessage } from "@ai-sdk/react";
import ToolCallCard from "@/features/ai-chat/components/tool-call-card.tsx";
import ReasoningBlock from "@/features/ai-chat/components/reasoning-block.tsx";
import { StreamingMarkdownText } from "@/features/ai-chat/components/streaming-markdown-text.tsx";
import ChatErrorAlert from "@/features/ai-chat/components/chat-error-alert.tsx";
import ChatStoppedNotice from "@/features/ai-chat/components/chat-stopped-notice.tsx";
import { ToolUiPart, isToolPart } from "@/features/ai-chat/utils/tool-parts.tsx";
import { assistantMessageHasVisibleContent } from "@/features/ai-chat/utils/message-content.ts";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";
import { resolveAssistantName } from "@/features/ai-chat/utils/assistant-name.ts";
import { reasoningTokensForPart } from "@/features/ai-chat/utils/reasoning-tokens.ts";
import { describeChatError } from "@/features/ai-chat/utils/error-message.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface MessageItemProps {
  message: UIMessage;
  /**
   * Immutable content signature for `message`, computed by the PARENT
   * (MessageList) during its render via `messageSignature(message)`. This is the
   * memo key (see `arePropsEqual`): it MUST be a snapshot captured at render time,
   * NOT recomputed from `message` inside `arePropsEqual`.
   *
   * WHY (load-bearing): the AI SDK streams deltas by mutating the SAME `parts`
   * array/objects in place and handing back a message wrapper that SHARES those
   * mutated parts. So inside `arePropsEqual`, `prev.message` and `next.message`
   * both reflect the CURRENT (latest) parts — `messageSignature(prev.message) ===
   * messageSignature(next.message)` is therefore ALWAYS true, the memo skips every
   * post-mount render, and the assistant row freezes at its initial empty (null)
   * render — i.e. the streamed answer + tool cards never appear (reasoning-first
   * providers start empty, so NOTHING shows). Snapshotting the signature into this
   * immutable string prop in the parent fixes that: `prev.signature` holds the
   * value from the previous render (old content) and `next.signature` the new
   * content, so they differ as the turn streams in and the row re-renders.
   */
  signature: string;
  /**
   * Forwarded to ToolCallCard: whether tool cards render page citation links.
   * Defaults to true (internal chat). The public share passes false.
   */
  showCitations?: boolean;
  /**
   * Forwarded to ToolCallCard: whether tool cards render the one-line summary of
   * a call's arguments (e.g. the search query). Defaults to true (internal
   * chat). The public share passes false so an anonymous reader doesn't see the
   * agent's raw query/argument text.
   */
  showInput?: boolean;
  /**
   * Forwarded to ToolCallCard: whether a failed tool card renders its raw
   * errorText. Defaults to true (internal chat). The public share passes false so
   * internal detail in a tool error is never painted (belt to the server-side
   * byte sanitization).
   */
  showErrors?: boolean;
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
  /**
   * Whether the WHOLE turn is still streaming (MessageList's `isStreaming`).
   * A reasoning part may be left `state: "streaming"` forever when the turn
   * ends without a `reasoning-end` chunk (manual Stop during the thinking
   * phase, or a provider that never emits it) — the AI SDK finalizes reasoning
   * state ONLY on `reasoning-end`, not on `finish-step`/`finish`. So part-level
   * state alone cannot prove liveness; the reasoning part is treated as live
   * only while the whole turn is still streaming. Defaults to false.
   *
   * The parent passes it as "turn is live AND this is the tail row", so a
   * stranded part in an EARLIER row never re-activates when a later turn
   * streams.
   */
  turnStreaming?: boolean;
}

/**
 * One assistant text part rendered as sanitized markdown. Memoized on its inputs
 * so a finalized text part is NOT re-parsed on every streamed delta: during a
 * turn only the actively-growing tail part changes its `text`, so every earlier
 * part hits the memo and skips the expensive canonical parse + DOMPurify pass.
 * Props are primitives, so React.memo's default shallow compare is exactly right
 * (the `text` string is compared by value).
 *
 * Streaming gate (#492) — mirrors ReasoningBlock:
 *  - `streaming` (this is the live, actively-growing tail part of an in-flight
 *    turn): render incrementally via StreamingMarkdownText — the stabilized blocks
 *    go through the canonical pipeline (each parsed ONCE, memoized) and only the
 *    live tail is cheap plain text. This makes the per-tick cost O(new blocks),
 *    not the pre-#492 O(ticks) whole-answer re-parse on every ~20Hz delta.
 *  - finalized (the common case, and the turn-end flip): render the WHOLE text
 *    through ONE canonical pass — byte-identical to the pre-#492 output (visual
 *    parity). The row re-renders on the streaming→done flip because
 *    `messageSignature` tracks each part's `state` (and `turnStreaming` flips at
 *    turn end), so the incremental view always converges to this single render.
 */
const MarkdownPart = memo(function MarkdownPart({
  text,
  neutralizeInternalLinks,
  streaming,
}: {
  text: string;
  neutralizeInternalLinks: boolean;
  streaming: boolean;
}) {
  if (streaming) {
    return (
      <StreamingMarkdownText
        text={text}
        neutralizeInternalLinks={neutralizeInternalLinks}
      />
    );
  }
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
  showInput = true,
  showErrors = true,
  neutralizeInternalLinks = false,
  assistantName,
  turnStreaming = false,
}: MessageItemProps) {
  // `signature` is intentionally not read in the body — it exists solely as the
  // memo key (see arePropsEqual). The render reads `message` directly.
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
        // Tool parts (`tool-*` / `dynamic-tool`) are template-literal kinds, so
        // they cannot be a `switch` case; the runtime guard handles them, and the
        // switch below covers every CLOSED (literal-typed) part kind with a
        // compile-time exhaustiveness check in its default.
        if (isToolPart(part.type)) {
          return (
            <ToolCallCard
              key={index}
              part={part as unknown as ToolUiPart}
              showCitations={showCitations}
              showInput={showInput}
              showErrors={showErrors}
            />
          );
        }

        switch (part.type) {
          case "reasoning": {
            // Reasoning ("thinking") -> a collapsible block with its own token
            // count. Empty/whitespace reasoning with no authoritative count
            // carries nothing to show, so skip it (avoids an empty 0-token block).
            const text = part.text ?? "";
            if (!text.trim() && !(reasoningTokens && reasoningTokens > 0))
              return null;
            // Absent state (persisted rows) and "done" both mean finalized.
            // `messageSignature` already includes each part's `state`, so the
            // streaming→done flip changes the row signature and re-renders this
            // row — which is what lets ReasoningBlock switch from chunked plain
            // text to its one-time markdown parse (see reasoning-block.tsx).
            // ALSO require the turn to be live: a part stranded at
            // `state:"streaming"` after the turn ended (no `reasoning-end` — see
            // the `turnStreaming` prop doc) must still finalize and parse.
            const streaming = turnStreaming && part.state === "streaming";
            return (
              <ReasoningBlock
                key={index}
                text={text}
                tokens={reasoningTokens}
                streaming={streaming}
              />
            );
          }

          case "text": {
            // Skip empty/whitespace-only text parts (a streaming message often
            // starts with an empty text part before the first token arrives); the
            // typing indicator covers that gap until real content streams in.
            if (!part.text.trim()) return null;
            // The live, actively-growing tail part of the in-flight turn renders
            // incrementally (see MarkdownPart); a finalized part (persisted, or
            // the turn-end flip) renders the whole text through one canonical
            // pass. Same liveness rule as the reasoning branch above.
            const streaming = turnStreaming && part.state === "streaming";
            return (
              <MarkdownPart
                key={index}
                text={part.text}
                neutralizeInternalLinks={neutralizeInternalLinks}
                streaming={streaming}
              />
            );
          }

          case "source-url":
          case "source-document":
          case "file":
          case "step-start":
            // Not surfaced in the chat bubble (v1) — same as the pre-#492 default.
            return null;

          default: {
            // Compile-time exhaustiveness over the CLOSED union members: every
            // literal-typed part kind is handled above, so the only kinds that
            // can reach here are the OPEN template-literal ones (`tool-*` — caught
            // by the guard at runtime — and `data-*`) plus `dynamic-tool`. Adding
            // a NEW closed part kind to UIMessagePart makes this assignment fail
            // to compile, forcing it to be handled instead of silently ignored
            // (this replaces the pre-#492 fall-through `return null` + WARNING).
            const _exhaustive:
              | `tool-${string}`
              | "dynamic-tool"
              | `data-${string}` = part.type;
            void _exhaustive;
            return null;
          }
        }
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
 *  TAIL message gets a fresh `signature` snapshot each delta (computed by the
 *  parent), so it still re-renders and streams in; every FINALIZED message keeps
 *  the same signature and is skipped, turning a per-token whole-transcript
 *  re-render into a tail-only one.
 *
 *  CRITICAL: compare the `signature` PROP (an immutable snapshot the parent took
 *  at its own render), NEVER `messageSignature(prev.message)` vs
 *  `messageSignature(next.message)`. The AI SDK mutates the shared `parts` in
 *  place, so both `prev.message` and `next.message` reflect the latest content
 *  here — recomputing the signature from them yields equal strings every time and
 *  freezes the row at its initial empty render (the bug this guards against). See
 *  the `signature` prop doc. Likewise there is NO `prev.message === next.message`
 *  fast path: same-reference-but-mutated must still re-render when the snapshot
 *  signature changed. */
export function arePropsEqual(
  prev: MessageItemProps,
  next: MessageItemProps,
): boolean {
  return (
    prev.signature === next.signature &&
    prev.showCitations === next.showCitations &&
    prev.showInput === next.showInput &&
    prev.showErrors === next.showErrors &&
    prev.neutralizeInternalLinks === next.neutralizeInternalLinks &&
    prev.assistantName === next.assistantName &&
    // The turn-end flip re-renders every row once (cheap, terminal event) —
    // that is what converts a stranded `state:"streaming"` reasoning part to
    // its one-time markdown parse (see the `turnStreaming` prop doc).
    prev.turnStreaming === next.turnStreaming
  );
}

export default memo(MessageItem, arePropsEqual);
