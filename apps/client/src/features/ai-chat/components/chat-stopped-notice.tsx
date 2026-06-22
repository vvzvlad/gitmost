import { Alert, Group, Text, type AlertProps } from "@mantine/core";
import { IconPlayerStopFilled } from "@tabler/icons-react";

/**
 * A neutral "turn was interrupted" notice (NOT an error). Rendered for an
 * aborted turn — a manual Stop or a dropped connection — both live (ChatThread)
 * and in reopened history (MessageItem). Deliberately gray/subtle so it reads as
 * an informational marker, distinct from the red ChatErrorAlert. Layout-only
 * props (mt/mb/...) are forwarded to the Alert root.
 */
interface ChatStoppedNoticeProps extends Omit<AlertProps, "title" | "children"> {
  text: string;
}

export default function ChatStoppedNotice({
  text,
  style,
  ...alertProps
}: ChatStoppedNoticeProps) {
  return (
    <Alert
      {...alertProps}
      variant="light"
      color="gray"
      p="xs"
      // flexShrink: 0 mirrors ChatErrorAlert so the notice is not compressed as a
      // flex child of the chat panel.
      style={[{ flexShrink: 0 }, style]}
    >
      <Group gap={8} wrap="nowrap" align="center">
        <IconPlayerStopFilled
          size={16}
          style={{ flex: "none", color: "var(--mantine-color-dimmed)" }}
        />
        <Text size="sm" lh={1.3} c="dimmed">
          {text}
        </Text>
      </Group>
    </Alert>
  );
}
