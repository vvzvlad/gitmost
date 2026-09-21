import { useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconInfoCircle, IconPlus } from "@tabler/icons-react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { getAppName } from "@/lib/config.ts";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { useWorkspaceEntitlementsQuery } from "@/features/workspace/queries/workspace-query.ts";
import {
  useAccountMcpServersQuery,
  useCreateAccountMcpServerMutation,
  useDeleteAccountMcpServerMutation,
  useTestAccountMcpServerMutation,
  useUpdateAccountMcpServerMutation,
} from "@/features/account-mcp/queries/account-mcp-server-query.ts";
import type { IAiMcpServer } from "@/features/ai-mcp/mcp-server-types.ts";
import AiMcpServerRow from "@/features/ai-mcp/mcp-server-row.tsx";
import McpServerFormModal from "@/features/ai-mcp/mcp-server-form-modal.tsx";

/**
 * Account settings page (#686): manage the user's OWN personal external MCP
 * servers, added to the agent alongside the workspace-wide (admin) ones. Mirrors
 * `account-api-keys.tsx` and reuses the shared MCP row/modal (`features/ai-mcp`)
 * with the personal `/account/mcp-servers*` hooks. When the instance kill-switch
 * (`MCP_PERSONAL_SERVERS_ENABLED`) is off, a friendly disabled state is shown
 * instead of letting the CRUD calls 403 (the server enforces it independently).
 */
export default function AccountMcpServers() {
  const { t } = useTranslation();

  const { data: entitlements, isLoading: isEntitlementsLoading } =
    useWorkspaceEntitlementsQuery();
  const enabled = entitlements?.mcpPersonalServersEnabled ?? false;

  // Only fetch the list when the feature is on (avoids a guaranteed 403).
  const { data: servers, isLoading } = useAccountMcpServersQuery(enabled);
  const updateMutation = useUpdateAccountMcpServerMutation();
  const deleteMutation = useDeleteAccountMcpServerMutation();

  const [opened, { open, close }] = useDisclosure(false);
  // The server being edited; undefined means the modal is in "create" mode.
  const [editing, setEditing] = useState<IAiMcpServer | undefined>(undefined);

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
    <>
      <Helmet>
        <title>
          {t("My MCP servers")} - {getAppName()}
        </title>
      </Helmet>
      <SettingsTitle title={t("My MCP servers")} />

      {/* Gate on the kill-switch: render the manager only when enabled, the
          disabled state (not a raw 403) once we know it is off, and nothing
          while the entitlements query is still loading (avoids a flash). */}
      {!enabled ? (
        !isEntitlementsLoading && (
          <Alert
            variant="light"
            color="gray"
            icon={<IconInfoCircle size={16} />}
            title={t("Personal MCP servers are disabled")}
          >
            {t(
              "Personal external MCP servers are turned off on this instance. Contact your administrator to enable them.",
            )}
          </Alert>
        )
      ) : (
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
              <Text fw={600}>{t("My external tools")}</Text>
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
            {t(
              "Personal servers the agent calls out to, added to the workspace ones on your chats only.",
            )}
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
                useTestMutation={useTestAccountMcpServerMutation}
                onEdit={openEdit}
                onDelete={confirmDelete}
                onToggleEnabled={(isEnabled) =>
                  updateMutation.mutate({ id: server.id, enabled: isEnabled })
                }
              />
            ))}
          </Stack>

          <McpServerFormModal
            opened={opened}
            onClose={close}
            editing={editing}
            useCreateMutation={useCreateAccountMcpServerMutation}
            useUpdateMutation={useUpdateAccountMcpServerMutation}
            useTestMutation={useTestAccountMcpServerMutation}
          />
        </Paper>
      )}
    </>
  );
}
