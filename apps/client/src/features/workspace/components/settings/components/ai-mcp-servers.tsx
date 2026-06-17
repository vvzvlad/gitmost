import { useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import {
  useAiMcpServersQuery,
  useDeleteAiMcpServerMutation,
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
    <Stack mt="sm">
      <Group justify="flex-start">
        <Button
          leftSection={<IconPlus size={16} />}
          variant="default"
          onClick={openCreate}
        >
          {t("Add server")}
        </Button>
      </Group>

      {!isLoading && (!servers || servers.length === 0) && (
        <Text size="sm" c="dimmed">
          {t("No external servers configured")}
        </Text>
      )}

      <Stack gap="xs">
        {servers?.map((server) => (
          <Paper key={server.id} withBorder p="sm" radius="sm">
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
                <Text size="xs" c="dimmed" truncate>
                  {server.url}
                </Text>
              </Stack>

              <Group gap="xs" wrap="nowrap">
                <Switch
                  size="sm"
                  checked={server.enabled}
                  aria-label={t("Enabled")}
                  onChange={(event) =>
                    updateMutation.mutate({
                      id: server.id,
                      enabled: event.currentTarget.checked,
                    })
                  }
                />
                <ActionIcon
                  variant="subtle"
                  aria-label={t("Edit")}
                  onClick={() => openEdit(server)}
                >
                  <IconPencil size={16} />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={t("Delete")}
                  onClick={() => confirmDelete(server)}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Group>
          </Paper>
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
    </Stack>
  );
}
