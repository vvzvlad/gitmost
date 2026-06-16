import { useState, KeyboardEvent } from "react";
import { ActionIcon, Group, Textarea, Tooltip } from "@mantine/core";
import { IconPlayerStopFilled, IconSend } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

interface ChatInputProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

/**
 * Message composer. Enter sends, Shift+Enter inserts a newline. While the agent
 * is streaming, the send button becomes a Stop button (calls `stop()`); the
 * textarea stays usable so the user can draft the next turn.
 */
export default function ChatInput({
  onSend,
  onStop,
  isStreaming,
  disabled,
}: ChatInputProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");

  const send = (): void => {
    const text = value.trim();
    if (!text || isStreaming || disabled) return;
    onSend(text);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <Group gap="xs" align="flex-end" wrap="nowrap">
      <Textarea
        style={{ flex: 1 }}
        placeholder={t("Ask the AI agent…")}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        autosize
        minRows={1}
        maxRows={6}
        disabled={disabled}
      />
      {isStreaming ? (
        <Tooltip label={t("Stop")} withArrow>
          <ActionIcon
            size="lg"
            color="red"
            variant="light"
            onClick={onStop}
            aria-label={t("Stop")}
          >
            <IconPlayerStopFilled size={18} />
          </ActionIcon>
        </Tooltip>
      ) : (
        <Tooltip label={t("Send")} withArrow>
          <ActionIcon
            size="lg"
            variant="filled"
            onClick={send}
            disabled={disabled || value.trim().length === 0}
            aria-label={t("Send")}
          >
            <IconSend size={18} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}
