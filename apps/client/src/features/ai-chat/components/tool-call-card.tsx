import { Anchor, Group, Loader, Text, ThemeIcon } from "@mantine/core";
import { IconAlertCircle, IconCheck } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  getToolName,
  toolCitations,
  toolLabelKey,
  toolRunState,
  ToolUiPart,
} from "@/features/ai-chat/utils/tool-parts.tsx";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

interface ToolCallCardProps {
  part: ToolUiPart;
  /**
   * Whether to render page citation links. Defaults to true (the internal chat,
   * where the reader is authenticated and the `/p/{id}` links resolve). The
   * public share passes false: an anonymous reader cannot open internal pages,
   * so the links would 404/redirect to login. Suppressing them keeps the card
   * (the action log itself) while dropping the unusable links.
   */
  showCitations?: boolean;
}

/**
 * Compact action-log card for a single agent tool invocation. It shows what the
 * agent DID (the agent writes without confirmation — D2), its run state
 * (running / done / error), and citation link(s) to any referenced page(s).
 */
export default function ToolCallCard({
  part,
  showCitations = true,
}: ToolCallCardProps) {
  const { t } = useTranslation();
  const toolName = getToolName(part);
  const state = toolRunState(part.state);
  const { key, values } = toolLabelKey(toolName);
  const citations = showCitations ? toolCitations(part) : [];

  return (
    <div className={classes.toolCard}>
      <Group gap={6} wrap="nowrap" align="center">
        {state === "running" && <Loader size={14} />}
        {state === "done" && (
          <ThemeIcon size={16} radius="xl" color="green" variant="light">
            <IconCheck size={12} />
          </ThemeIcon>
        )}
        {state === "error" && (
          <ThemeIcon size={16} radius="xl" color="red" variant="light">
            <IconAlertCircle size={12} />
          </ThemeIcon>
        )}
        <Text size="sm" fw={500}>
          {t(key, values)}
        </Text>
      </Group>

      {state === "error" && part.errorText && (
        <Text size="xs" c="red" mt={2}>
          {part.errorText}
        </Text>
      )}

      {citations.length > 0 && (
        <Group gap={6} mt={4} wrap="wrap">
          {citations.map((c) => (
            <Anchor
              key={c.pageId}
              component={Link}
              to={c.href}
              size="xs"
              lineClamp={1}
            >
              {c.title || t("Open page")}
            </Anchor>
          ))}
        </Group>
      )}
    </div>
  );
}
