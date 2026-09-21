import { memo, useMemo, useState } from "react";
import { Box, Collapse, Group, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { estimateTokens } from "@/features/ai-chat/utils/count-stream-tokens.ts";
import { collapseBlankLines } from "@/features/ai-chat/utils/collapse-blank-lines.ts";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";
import { StreamingPlainText } from "@/features/ai-chat/components/streaming-plain-text.tsx";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface ReasoningBlockProps {
  /** The streamed/persisted reasoning (thinking) text. May be empty when the
   *  provider reports only a reasoning token COUNT without the text. */
  text: string;
  /** Authoritative reasoning token count from `usage.reasoningTokens`, when the
   *  step/turn has finished. When absent (or 0) the count is estimated from the
   *  text length so it ticks live as the reasoning streams in. */
  tokens?: number;
  /** True while the reasoning part is still streaming (part `state ===
   *  "streaming"`). False means finalized: persisted history or `state ===
   *  "done"`. Gates the markdown parse — see the invariant on the memo below. */
  streaming?: boolean;
}

/**
 * Collapsible "Thinking" block for an assistant `reasoning` part. Mirrors Claude
 * Code's surfacing of the model's thinking: a header that shows the thinking
 * token count (authoritative when the step has reported usage, else a live
 * estimate from the streamed text) and an expandable body with the reasoning
 * prose. Collapsed by default so it never crowds out the answer.
 *
 * Providers that don't stream reasoning TEXT still render this block from the
 * authoritative count alone (header only, empty body) so the cost is visible.
 */
function ReasoningBlock({ text, tokens, streaming = false }: ReasoningBlockProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Authoritative count wins; otherwise estimate live from the streamed text.
  const count = tokens && tokens > 0 ? tokens : estimateTokens(text);
  const trimmed = text.trim();
  // Markdown parse invariant (per throttled ~20Hz stream delta the text GROWS):
  //  1. Collapsed -> never parse (#302): the html is only shown inside
  //     <Collapse in={open}>, so parsing for a hidden body would be an O(n²)
  //     marked + DOMPurify storm.
  //  2. Expanded + STREAMING -> no parse and no innerHTML swaps either: the body
  //     renders as chunked plain text (StreamingPlainText) with a memoized
  //     stable prefix, so each delta updates only the tail chunk's text node.
  //     This closes the O(n²) hole #302 left open ("expanded while streaming")
  //     that froze the whole tab in Safari when watching the thinking stream.
  //  3. Finalized + expanded -> exactly one parse: `trimmed` and `streaming`
  //     are stable after the part is done, so this memo runs once per expand.
  const html = useMemo(
    () =>
      open && trimmed && !streaming
        ? renderChatMarkdown(collapseBlankLines(trimmed), {})
        : "",
    [open, trimmed, streaming],
  );

  return (
    <Box className={classes.reasoningBlock} mb={6}>
      <UnstyledButton
        onClick={() => setOpen((o) => !o)}
        // No body to expand when the provider reported only a token count.
        disabled={!trimmed}
        aria-expanded={open}
      >
        <Group gap={6} wrap="nowrap" align="center">
          <IconChevronDown
            size={12}
            style={{
              transform: open ? "none" : "rotate(-90deg)",
              transition: "transform 150ms ease",
              opacity: trimmed ? 1 : 0.4,
            }}
          />
          <Text size="xs" c="dimmed">
            {count > 0
              ? t("Thinking · {{count}} tokens", { count })
              : t("Thinking")}
          </Text>
        </Group>
      </UnstyledButton>

      {trimmed && (
        <Collapse in={open}>
          {html ? (
            <div
              className={classes.reasoningText}
              // Sanitized by renderChatMarkdown (DOMPurify) before insertion.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            // Still streaming (or markdown yielded nothing): chunked plain text.
            // The wrapper carries the reasoningText styling; each chunk sets its
            // own pre-wrap inline (NOT on this div — see ai-chat.module.css).
            <div className={classes.reasoningText}>
              <StreamingPlainText text={trimmed} />
            </div>
          )}
        </Collapse>
      )}
    </Box>
  );
}

// Memoized: re-renders only when `text`/`tokens`/`streaming` change (primitive
// props, default shallow compare), so a parent re-render during streaming of OTHER
// content does not re-run the markdown parse for an already-finalized reasoning block.
export default memo(ReasoningBlock);
