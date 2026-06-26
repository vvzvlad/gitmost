import { useState } from "react";
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
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import {
  IconPackageImport,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import {
  useAiRolesQuery,
  useDeleteAiRoleMutation,
  useUpdateAiRoleMutation,
} from "@/features/ai-chat/queries/ai-chat-query.ts";
import { IAiRole } from "@/features/ai-chat/types/ai-chat.types.ts";
import AiAgentRoleForm from "./ai-agent-role-form.tsx";
import AiAgentRolesCatalogModal from "./ai-agent-roles-catalog-modal.tsx";

/**
 * Admin section: list / add / edit / delete reusable agent roles. A role
 * replaces the agent's persona (instructions) and may optionally override the
 * model; the safety framework is always still applied. The add/edit form lives
 * in `AiAgentRoleForm`, opened in a modal.
 */
export default function AiAgentRoles() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();

  const { data: roles, isLoading } = useAiRolesQuery(isAdmin);
  const updateMutation = useUpdateAiRoleMutation();
  const deleteMutation = useDeleteAiRoleMutation();

  const [opened, { open, close }] = useDisclosure(false);
  // Separate disclosure for the catalog (import/update) modal.
  const [catalogOpened, { open: openCatalog, close: closeCatalog }] =
    useDisclosure(false);
  // The role being edited; undefined => the modal is in "create" mode.
  const [editing, setEditing] = useState<IAiRole | undefined>(undefined);

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

  function openEdit(role: IAiRole) {
    setEditing(role);
    open();
  }

  function confirmDelete(role: IAiRole) {
    modals.openConfirmModal({
      title: t("Delete role"),
      children: (
        <Text size="sm">
          {t("Are you sure you want to delete this role?")}
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(role.id),
    });
  }

  return (
    <Paper withBorder radius="md" p="lg">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="xs" align="center" wrap="nowrap">
          <Box
            w={9}
            h={9}
            bg="green.6"
            style={{ borderRadius: "50%", flex: "none" }}
          />
          <Text fw={600}>{t("Agent roles")}</Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button
            leftSection={<IconPackageImport size={16} />}
            variant="default"
            size="xs"
            onClick={openCatalog}
          >
            {t("Import from catalog")}
          </Button>
          <Button
            leftSection={<IconPlus size={16} />}
            variant="default"
            size="xs"
            onClick={openCreate}
          >
            {t("Add role")}
          </Button>
        </Group>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>
        {t(
          "Reusable presets that shape the agent's behavior (and optionally its model). Picked when starting a new chat.",
        )}
      </Text>

      {!isLoading && (!roles || roles.length === 0) && (
        <Group gap="sm" mt="sm" align="center">
          <Text size="sm" c="dimmed">
            {t("No roles configured")}
          </Text>
          <Button
            leftSection={<IconPackageImport size={16} />}
            variant="light"
            size="xs"
            onClick={openCatalog}
          >
            {t("Browse the catalog")}
          </Button>
        </Group>
      )}

      <Stack gap="xs" mt="sm">
        {roles?.map((role) => (
          <Group key={role.id} justify="space-between" wrap="nowrap">
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Group gap="xs">
                <Text fw={500} truncate>
                  {role.emoji ? `${role.emoji} ` : ""}
                  {role.name}
                </Text>
                {role.modelConfig?.chatModel && (
                  <Badge size="xs" variant="light">
                    {role.modelConfig.chatModel}
                  </Badge>
                )}
              </Group>
              {role.description && (
                <Text size="xs" c="dimmed" truncate>
                  {role.description}
                </Text>
              )}
            </Stack>

            <Group gap="xs" wrap="nowrap">
              <Switch
                size="sm"
                checked={role.enabled}
                aria-label={t("Enabled")}
                onChange={(event) =>
                  updateMutation.mutate({
                    id: role.id,
                    enabled: event.currentTarget.checked,
                  })
                }
              />
              <ActionIcon
                variant="subtle"
                aria-label={t("Edit")}
                onClick={() => openEdit(role)}
              >
                <IconPencil size={16} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t("Delete")}
                onClick={() => confirmDelete(role)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          </Group>
        ))}
      </Stack>

      <Modal
        opened={opened}
        onClose={close}
        title={editing ? t("Edit role") : t("Add role")}
        size="lg"
      >
        {/* Remount the form per target so its internal state re-hydrates. */}
        <AiAgentRoleForm key={editing?.id ?? "new"} role={editing} onClose={close} />
      </Modal>

      <AiAgentRolesCatalogModal
        opened={catalogOpened}
        onClose={closeCatalog}
        roles={roles ?? []}
      />
    </Paper>
  );
}
