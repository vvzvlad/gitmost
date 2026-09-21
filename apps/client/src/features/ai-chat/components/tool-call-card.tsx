import { Anchor, Group, Loader, Text, ThemeIcon } from "@mantine/core";
import { IconAlertCircle, IconCheck } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  getToolName,
  toolCitations,
  toolInputSummary,
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
  /**
   * Whether to render the one-line summary of the call's arguments (e.g. the
   * search query) under the label. Defaults to true (the internal chat). The
   * public share passes false: an anonymous reader should not see the agent's
   * raw query/argument text. Conservative and reversible — it only suppresses
   * the extra summary line, leaving the card (the action log) intact.
   */
  showInput?: boolean;
  /**
   * Whether to render the tool's raw errorText on a failed call. Defaults to true
   * (the internal chat, where the operator may debug). The public share passes
   * false: a tool error string can carry internal detail (an internal page title,
   * a stack fragment, a provider message). This is the RENDER gate only — the
   * authoritative fix also sanitizes the bytes server-side (see
   * PublicShareChatToolsService.forShare), so a share reader never receives raw
   * error text over the wire, not just never sees it painted (#394).
   */
  showErrors?: boolean;
}

/**
 * Compact action-log card for a single agent tool invocation. It shows what the
 * agent DID (the agent writes without confirmation — D2), its run state
 * (running / done / error), and citation link(s) to any referenced page(s).
 */
export default function ToolCallCard({
  part,
  showCitations = true,
  showInput = true,
  showErrors = true,
}: ToolCallCardProps) {
  const { t } = useTranslation();
  const toolName = getToolName(part);
  const state = toolRunState(part.state);
  const { key, values } = toolLabelKey(toolName);
  const citations = showCitations ? toolCitations(part) : [];
  const inputSummary = showInput ? toolInputSummary(part) : undefined;

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

      {inputSummary && (
        <Text size="xs" c="dimmed" mt={2} lineClamp={2}>
          {inputSummary}
        </Text>
      )}

      {state === "error" && showErrors && part.errorText && (
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
