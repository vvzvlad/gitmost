import { useEffect } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconCheck,
  IconPencil,
  IconPlugConnected,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { IAiMcpServer } from "./mcp-server-types.ts";
import { UseTestMcpServerMutation } from "./mcp-mutation-hooks.ts";
import { mcpTestButtonView } from "./mcp-test-view.ts";

interface AiMcpServerRowProps {
  server: IAiMcpServer;
  // Scope-specific test-mutation hook (admin `/workspace/ai-mcp-servers/test`
  // or personal `/account/mcp-servers/test`). Instantiated PER ROW inside the
  // component so each row's inline result/loading is independent.
  useTestMutation: UseTestMcpServerMutation;
  onEdit: (server: IAiMcpServer) => void;
  onDelete: (server: IAiMcpServer) => void;
  onToggleEnabled: (enabled: boolean) => void;
}

/**
 * A single external MCP server row, shared (#686) by the admin and the personal
 * (account) pages: name/badge/url on the left and the Test / Switch / Edit /
 * Delete controls on the right. Each row owns its own test mutation (passed in
 * as a hook) so the inline Test result and loading state are independent per row
 * (a shared mutation would make `isPending` global and make every row flicker).
 * The delete confirmation and the enabled toggle are lifted to the parent via
 * `onDelete` / `onToggleEnabled` so the scope-specific mutations stay in the page.
 */
export default function AiMcpServerRow({
  server,
  useTestMutation,
  onEdit,
  onDelete,
  onToggleEnabled,
}: AiMcpServerRowProps) {
  const { t } = useTranslation();
  const testMutation = useTestMutation();
  const result = testMutation.data;

  // The row is keyed by `server.id`, so editing the connection-relevant fields
  // (url/transport/headers) does NOT remount it — an old success/failure result
  // would otherwise stick. Clear the result when those fields change.
  useEffect(() => {
    testMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.url, server.transport, server.hasHeaders]);

  // Single derivation of the button/tooltip presentation from the test tristate
  // (idle / ok / failed), so the two can never drift apart. Tooltip is "" while
  // there is no result; the icon is mapped from `view.state` below. When the
  // request itself rejects (401/403/500/network) there is no `data` payload, so
  // we feed the mutation error in too — otherwise the row would silently revert
  // to "Test" instead of showing a red "Failed".
  const view = mcpTestButtonView(
    result,
    t,
    testMutation.isError ? testMutation.error : undefined,
  );
  const tooltipLabel = view.tooltip;
  const buttonColor = view.color;
  const buttonVariant = view.variant;
  const buttonLabel = view.label;
  const buttonIcon =
    view.state === "ok" ? (
      <IconCheck size={16} />
    ) : view.state === "failed" ? (
      <IconX size={16} />
    ) : (
      <IconPlugConnected size={16} />
    );

  return (
    <Group justify="space-between" wrap="nowrap">
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Group gap="xs">
          <Text fw={500} truncate>
            {server.name}
          </Text>
          <Badge size="xs" variant="light">
            {server.transport.toUpperCase()}
          </Badge>
        </Group>
        <Text
          size="xs"
          c="dimmed"
          truncate
          style={{ fontFamily: "ui-monospace, Menlo, monospace" }}
        >
          {server.url}
        </Text>
      </Stack>

      <Group gap="xs" wrap="nowrap">
        {/* Always clickable: testing a disabled server before enabling it is useful. */}
        <Tooltip
          label={tooltipLabel}
          disabled={view.state === "idle"}
          multiline
          maw={320}
          withinPortal
        >
          <Button
            size="xs"
            miw={88}
            color={buttonColor}
            variant={buttonVariant}
            leftSection={testMutation.isPending ? undefined : buttonIcon}
            loading={testMutation.isPending}
            onClick={() => testMutation.mutate(server.id)}
          >
            {buttonLabel}
          </Button>
        </Tooltip>
        <Switch
          size="sm"
          checked={server.enabled}
          aria-label={t("Enabled")}
          onChange={(event) => onToggleEnabled(event.currentTarget.checked)}
        />
        <ActionIcon
          variant="subtle"
          aria-label={t("Edit")}
          onClick={() => onEdit(server)}
        >
          <IconPencil size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="red"
          aria-label={t("Delete")}
          onClick={() => onDelete(server)}
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Group>
    </Group>
  );
}
