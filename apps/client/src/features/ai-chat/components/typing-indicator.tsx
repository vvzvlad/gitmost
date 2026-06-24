import { Box, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { resolveAssistantName } from "@/features/ai-chat/utils/assistant-name.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface TypingIndicatorProps {
  /**
   * Display name for the dimmed label and the "… is typing…" line. Defaults to
   * "AI agent" when absent; the public share passes the configured identity
   * (agent role) name.
   */
  assistantName?: string;
  /**
   * Whether to render the dimmed assistant-name label. Defaults to true
   * (standalone behavior preserved). Set false between agent steps where the
   * assistant row above already shows the same name, to avoid a duplicate label.
   */
  showName?: boolean;
}

/**
 * Live "… is typing…" placeholder shown while a turn is in flight but the latest
 * assistant message has no visible content yet (no rendered text/tool parts). It
 * covers the gap between sending and the first streamed token, and is replaced by
 * the real assistant message once content starts arriving.
 *
 * Mirrors the assistant row layout in MessageItem (the dimmed label), so it reads
 * as the assistant's bubble taking shape. The dimmed label uses the configured
 * identity name when provided (otherwise the generic "AI agent"); below it the
 * animated dots stand in for the nascent bubble until content arrives.
 */
export default function TypingIndicator({ assistantName, showName = true }: TypingIndicatorProps) {
  const { t } = useTranslation();
  const name = resolveAssistantName(assistantName);

  return (
    <Box className={classes.messageRow}>
      {showName !== false && (
        // Extra bottom gap (vs MessageItem's mb={4}) gives the small bouncing
        // dots room below the name label; without it they crowd the label. Only
        // applies when the name is shown — the nameless case spaces fine on its own.
        <Text size="xs" c="dimmed" mb={8}>
          {name ?? t("AI agent")}
        </Text>
      )}
      <Group gap={8} align="center">
        <span className={classes.typingDots} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </Group>
    </Box>
  );
}
