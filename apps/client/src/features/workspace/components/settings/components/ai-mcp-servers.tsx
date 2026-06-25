import { useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import {
  IconCheck,
  IconPencil,
  IconPlugConnected,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import {
  useAiMcpServersQuery,
  useDeleteAiMcpServerMutation,
  useTestAiMcpServerMutation,
  useUpdateAiMcpServerMutation,
} from "@/features/workspace/queries/ai-mcp-server-query.ts";
import { IAiMcpServer } from "@/features/workspace/services/ai-mcp-server-service.ts";
import AiMcpServerForm from "./ai-mcp-server-form.tsx";

/**
 * Admin section: list / add / edit / delete external MCP servers the agent may
 * use (web search, etc.). The add/edit form (incl. the per-server Test) lives in
 * `AiMcpServerForm`, opened in a modal. Auth headers are write-only and never
 * shown (only `hasHeaders` is known client-side).
 */
export default function AiMcpServers() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();

  // Only admins may read/manage external servers; the server enforces this too.
  const { data: servers, isLoading } = useAiMcpServersQuery(isAdmin);
  const updateMutation = useUpdateAiMcpServerMutation();
  const deleteMutation = useDeleteAiMcpServerMutation();

  const [opened, { open, close }] = useDisclosure(false);
  // The server being edited; undefined means the modal is in "create" mode.
  const [editing, setEditing] = useState<IAiMcpServer | undefined>(undefined);

  if (!isAdmin) {
    return (
      <Text size="sm" c="dimmed">
        {t("Only workspace admins can manage AI provider settings.")}
      </Text>
    );
  }

  function openCreate() {
    setEditing(undefined);
    open();
  }

  function openEdit(server: IAiMcpServer) {
    setEditing(server);
    open();
  }

  function confirmDelete(server: IAiMcpServer) {
    modals.openConfirmModal({
      title: t("Delete server"),
      children: (
        <Text size="sm">
          {t("Are you sure you want to delete this MCP server?")}
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(server.id),
    });
  }

  return (
    <Paper withBorder radius="md" p="lg">
      {/* Header: status dot + title + "MCP client" badge + Add server */}
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="xs" align="center" wrap="nowrap">
          <Box
            w={9}
            h={9}
            bg="green.6"
            style={{ borderRadius: "50%", flex: "none" }}
          />
          <Text fw={600}>{t("External tools")}</Text>
          <Badge size="sm" variant="light" color="gray">
            {t("Gitmost as MCP client")}
          </Badge>
        </Group>
        <Button
          leftSection={<IconPlus size={16} />}
          variant="default"
          size="xs"
          onClick={openCreate}
        >
          {t("Add server")}
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>
        {t("Servers the agent calls out to.")}
      </Text>

      {!isLoading && (!servers || servers.length === 0) && (
        <Text size="sm" c="dimmed" mt="sm">
          {t("No external servers configured")}
        </Text>
      )}

      <Stack gap="xs" mt="sm">
        {servers?.map((server) => (
          <AiMcpServerRow
            key={server.id}
            server={server}
            onEdit={openEdit}
            onDelete={confirmDelete}
            onToggleEnabled={(enabled) =>
              updateMutation.mutate({ id: server.id, enabled })
            }
          />
        ))}
      </Stack>

      <Modal
        opened={opened}
        onClose={close}
        title={editing ? t("Edit server") : t("Add server")}
        size="lg"
      >
        {/* Remount the form per target so its internal state re-hydrates. */}
        <AiMcpServerForm
          key={editing?.id ?? "new"}
          server={editing}
          onClose={close}
        />
      </Modal>
    </Paper>
  );
}

interface AiMcpServerRowProps {
  server: IAiMcpServer;
  onEdit: (server: IAiMcpServer) => void;
  onDelete: (server: IAiMcpServer) => void;
  onToggleEnabled: (enabled: boolean) => void;
}

/**
 * A single external MCP server row: name/badge/url on the left and the
 * Test / Switch / Edit / Delete controls on the right. Each row owns its own
 * `useTestAiMcpServerMutation()` so the inline Test result and loading state are
 * independent per row (a shared mutation would make `isPending` global and make
 * every row flicker).
 */
function AiMcpServerRow({
  server,
  onEdit,
  onDelete,
  onToggleEnabled,
}: AiMcpServerRowProps) {
  const { t } = useTranslation();
  const testMutation = useTestAiMcpServerMutation();
  const result = testMutation.data;

  // The row is keyed by `server.id`, so editing the connection-relevant fields
  // (url/transport/headers) does NOT remount it — an old success/failure result
  // would otherwise stick. Clear the result when those fields change.
  useEffect(() => {
    testMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.url, server.transport, server.hasHeaders]);

  // Tooltip text describes the cause/details; disabled while there is no result.
  let tooltipLabel = "";
  if (result?.ok) {
    tooltipLabel =
      result.tools.length > 0
        ? result.tools.join(", ")
        : t("No tools available");
  } else if (result && result.ok === false) {
    tooltipLabel = result.error;
  }

  // Pick the button presentation from the current test state. Color is never the
  // only signal — the label changes too (a11y / colorblind-friendly).
  let buttonColor: string | undefined;
  let buttonVariant = "default";
  let buttonIcon = <IconPlugConnected size={16} />;
  let buttonLabel = t("Test");
  if (result?.ok) {
    buttonColor = "green";
    buttonVariant = "light";
    buttonIcon = <IconCheck size={16} />;
    buttonLabel = t("OK · {{n}}", { n: result.tools.length });
  } else if (result && result.ok === false) {
    buttonColor = "red";
    buttonVariant = "light";
    buttonIcon = <IconX size={16} />;
    buttonLabel = t("Failed");
  }

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
          disabled={!result}
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
