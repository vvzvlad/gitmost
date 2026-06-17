import { Box, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

/**
 * Live "AI agent is typing…" placeholder shown while a turn is in flight but the
 * latest assistant message has no visible content yet (no rendered text/tool
 * parts). It covers the gap between sending and the first streamed token, and is
 * replaced by the real assistant message once content starts arriving.
 *
 * Mirrors the assistant row layout in MessageItem (the dimmed "AI agent" label),
 * so it reads as the assistant's bubble taking shape.
 */
export default function TypingIndicator() {
  const { t } = useTranslation();

  return (
    <Box className={classes.messageRow}>
      <Text size="xs" c="dimmed" mb={4}>
        {t("AI agent")}
      </Text>
      <Group gap={8} align="center">
        <span className={classes.typingDots} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <Text size="sm" c="dimmed">
          {t("AI agent is typing…")}
        </Text>
      </Group>
    </Box>
  );
}
