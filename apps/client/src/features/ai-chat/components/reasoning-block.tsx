import { useState } from "react";
import { Box, Collapse, Group, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { estimateTokens } from "@/features/ai-chat/utils/count-stream-tokens.ts";
import { renderChatMarkdown } from "@/features/ai-chat/utils/markdown.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface ReasoningBlockProps {
  /** The streamed/persisted reasoning (thinking) text. May be empty when the
   *  provider reports only a reasoning token COUNT without the text. */
  text: string;
  /** Authoritative reasoning token count from `usage.reasoningTokens`, when the
   *  step/turn has finished. When absent (or 0) the count is estimated from the
   *  text length so it ticks live as the reasoning streams in. */
  tokens?: number;
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
export default function ReasoningBlock({ text, tokens }: ReasoningBlockProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Authoritative count wins; otherwise estimate live from the streamed text.
  const count = tokens && tokens > 0 ? tokens : estimateTokens(text);
  const trimmed = text.trim();
  const html = trimmed ? renderChatMarkdown(trimmed, {}) : "";

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
            <Text
              className={classes.reasoningText}
              style={{ whiteSpace: "pre-wrap" }}
            >
              {trimmed}
            </Text>
          )}
        </Collapse>
      )}
    </Box>
  );
}
