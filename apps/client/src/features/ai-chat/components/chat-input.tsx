import { KeyboardEvent } from "react";
import { ActionIcon, Group, Textarea, Tooltip } from "@mantine/core";
import { IconPlayerStopFilled, IconSend } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useAtom, useAtomValue } from "jotai";
import { aiChatDraftAtom } from "@/features/ai-chat/atoms/ai-chat-atom.ts";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
import { MicButton } from "@/features/dictation/components/mic-button";

interface ChatInputProps {
  onSend: (text: string) => void;
  /** Called instead of `onSend` while a turn is streaming: the text is queued
   *  and sent automatically once the current turn finishes. */
  onQueue: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

/**
 * Message composer. Enter submits, Shift+Enter inserts a newline. While the
 * agent is streaming, submitting QUEUES the message (via `onQueue`) instead of
 * dropping it — it is sent automatically once the current turn finishes; the
 * Stop button (calls `stop()`) is also shown. The textarea stays usable so the
 * user can draft / queue the next turn while the agent is busy.
 */
export default function ChatInput({
  onSend,
  onQueue,
  onStop,
  isStreaming,
  disabled,
}: ChatInputProps) {
  const { t } = useTranslation();
  const [value, setValue] = useAtom(aiChatDraftAtom);
  const workspace = useAtomValue(workspaceAtom);
  const isDictationEnabled = workspace?.settings?.ai?.dictation === true;
  // Streaming (silence-cut) dictation is opt-in per workspace; absent/false
  // keeps the stable batch path.
  const streamingDictation =
    workspace?.settings?.ai?.dictationStreaming === true;

  const submit = (): void => {
    const text = value.trim();
    if (!text || disabled) return;
    if (isStreaming) onQueue(text);
    else onSend(text);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
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
        // Focus the composer whenever this input mounts. ChatThread is remounted
        // via `key` on every chat appearance (window open, "New chat", chat
        // switch), so a fresh chat lands with the cursor ready in the field.
        autoFocus
      />
      {isDictationEnabled && (
        <MicButton
          size="lg"
          streaming={streamingDictation}
          disabled={isStreaming || disabled}
          onText={(text) => setValue((v) => (v ? `${v} ${text}` : text))}
        />
      )}
      {isStreaming ? (
        <Group gap="xs" wrap="nowrap">
          {value.trim().length > 0 && (
            <Tooltip label={t("Send when the agent finishes")} withArrow>
              <ActionIcon
                size="lg"
                variant="filled"
                onClick={submit}
                aria-label={t("Queue message")}
              >
                <IconSend size={18} />
              </ActionIcon>
            </Tooltip>
          )}
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
        </Group>
      ) : (
        <Tooltip label={t("Send")} withArrow>
          <ActionIcon
            size="lg"
            variant="filled"
            onClick={submit}
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
