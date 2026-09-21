import { useState } from "react";
import { Badge, Box, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import {
  useAiMcpServersQuery,
  useCreateAiMcpServerMutation,
  useDeleteAiMcpServerMutation,
  useTestAiMcpServerMutation,
  useUpdateAiMcpServerMutation,
} from "@/features/workspace/queries/ai-mcp-server-query.ts";
import { IAiMcpServer } from "@/features/workspace/services/ai-mcp-server-service.ts";
import AiMcpServerRow from "@/features/ai-mcp/mcp-server-row.tsx";
import McpServerFormModal from "@/features/ai-mcp/mcp-server-form-modal.tsx";

/**
 * Admin section: list / add / edit / delete external MCP servers the agent may
 * use (web search, etc.) for the WHOLE workspace. The reusable row and add/edit
 * modal (incl. the per-server Test) live in the shared `features/ai-mcp` module
 * (#686) and are driven by the admin `/workspace/ai-mcp-servers*` mutations
 * passed in as hooks; the personal (account) page reuses the same components
 * with its own `/account/mcp-servers*` hooks. Auth headers are write-only and
 * never shown (only `hasHeaders` is known client-side).
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
            useTestMutation={useTestAiMcpServerMutation}
            onEdit={openEdit}
            onDelete={confirmDelete}
            onToggleEnabled={(enabled) =>
              updateMutation.mutate({ id: server.id, enabled })
            }
          />
        ))}
      </Stack>

      <McpServerFormModal
        opened={opened}
        onClose={close}
        editing={editing}
        useCreateMutation={useCreateAiMcpServerMutation}
        useUpdateMutation={useUpdateAiMcpServerMutation}
        useTestMutation={useTestAiMcpServerMutation}
      />
    </Paper>
  );
}
