import { Alert, Group, Text, type AlertProps } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

/**
 * A classified AI chat error banner: a warning icon + bold heading on the first
 * row, with the detail text spanning the full width below. Rendered for BOTH the
 * live stream error (ChatThread) and a persisted assistant error (MessageItem),
 * so this markup lives in one place. The detail is full-width (no hanging indent
 * under the heading) so it wraps less and leaves no stranded icon / empty gap.
 * The heading reuses Mantine's adaptive red "light" colour so it stays correct
 * in dark mode. Layout-only props (mb/mt/...) are forwarded to the Alert root.
 */
interface ChatErrorAlertProps extends Omit<AlertProps, "title" | "children"> {
  title: string;
  detail: string;
}

export default function ChatErrorAlert({
  title,
  detail,
  style,
  ...alertProps
}: ChatErrorAlertProps) {
  // Mantine's own "light" alert colour, adaptive across light/dark schemes.
  const accent = "var(--mantine-color-red-light-color)";
  return (
    // flexShrink: 0 keeps the banner fully visible. Mantine's Alert root is
    // `overflow: hidden`, so as a flex child of the chat panel it can otherwise
    // be compressed below its content height and clip the detail text; the
    // scrollable message list absorbs the height pressure instead.
    <Alert
      {...alertProps}
      variant="light"
      color="red"
      p="xs"
      style={[{ flexShrink: 0 }, style]}
    >
      <Group gap={8} wrap="nowrap" align="center" mb={4}>
        <IconAlertTriangle size={18} style={{ flex: "none", color: accent }} />
        <Text fw={700} size="sm" lh={1.2} style={{ color: accent }}>
          {title}
        </Text>
      </Group>
      <Text size="sm" lh={1.4}>
        {detail}
      </Text>
    </Alert>
  );
}
