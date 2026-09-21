import { useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCopy, IconKey, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import { formatLocalized, useDateFnsLocale } from "@/lib/date-locale";
import { timeAgo } from "@/lib/time";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import {
  useApiKeysQuery,
  useCreateApiKeyMutation,
  useRevealApiKeyMutation,
  useRevokeApiKeyMutation,
} from "@/features/api-key/queries/api-key-query";
import { IApiKey } from "@/features/api-key/types/api-key.types";
import {
  isExpired,
  isExpiringSoon,
  lastUsedBucket,
} from "@/features/api-key/utils";
import { CreateApiKeyModal } from "./create-api-key-modal";
import { RevealKeyModal } from "./reveal-key-modal";

export default function ApiKeysManager() {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();
  // Manage-on-API === Owner/Admin server-side, so the admin (workspace-wide)
  // list + "author" column mirror exactly the roles the server serves the
  // whole-workspace response to.
  const { isAdmin } = useUserRole();

  const { data: keys, isLoading, isError } = useApiKeysQuery();
  const createMutation = useCreateApiKeyMutation();
  const revokeMutation = useRevokeApiKeyMutation();
  const revealMutation = useRevealApiKeyMutation();

  const [createOpened, setCreateOpened] = useState(false);
  // SECURITY: only the key METADATA is held here (for the modal title) — never a
  // token. The token is copied straight to the clipboard in handleCopy and is
  // never stored in state, the query cache or localStorage.
  const [revealTarget, setRevealTarget] = useState<IApiKey | null>(null);

  const handleCreate = async (values: {
    name: string;
    expiresAt: string | null;
  }): Promise<boolean> => {
    try {
      await createMutation.mutateAsync(values);
      // The create response carries a token, but it is now retrievable any time
      // via the per-row Copy action (reveal), so we DISCARD it here: purge
      // react-query's copy immediately and never move it into state. The user
      // copies the key from the list via a password step-up.
      createMutation.reset();
      setCreateOpened(false);
      notifications.show({ message: t("API key created") });
      return true;
    } catch {
      notifications.show({
        message: t("Failed to create API key"),
        color: "red",
      });
      return false;
    }
  };

  // Password step-up accepted -> re-mint + copy. The token exists only as a local
  // `const` for the single clipboard write, then react-query's copy is reset().
  // It never enters component state, the query cache or localStorage.
  const handleCopy = async (password: string): Promise<boolean> => {
    const target = revealTarget;
    if (!target) return false;
    try {
      const token = await revealMutation.mutateAsync({
        id: target.id,
        password,
      });
      await copyToClipboard(token);
      revealMutation.reset();
      notifications.show({ message: t("API key copied to clipboard") });
      return true;
    } catch (err) {
      revealMutation.reset();
      // 401 = wrong password (keep the modal open to retry); anything else is a
      // uniform failure (the server does not distinguish key states).
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      notifications.show({
        message:
          status === 401
            ? t("Incorrect password")
            : t("Failed to copy API key"),
        color: "red",
      });
      return false;
    }
  };

  const openRevokeModal = (key: IApiKey) =>
    modals.openConfirmModal({
      title: t("Revoke API key"),
      centered: true,
      children: (
        <Text size="sm">
          {t(
            'Are you sure you want to revoke "{{name}}"? Any client using this key will immediately lose access. This cannot be undone.',
            { name: key.name },
          )}
        </Text>
      ),
      labels: { confirm: t("Revoke"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => revokeMutation.mutate(key.id),
    });

  const formatDate = (iso: string) =>
    formatLocalized(new Date(iso), "MMM dd, yyyy", "PP", locale);

  const renderLastUsed = (lastUsedAt: string | null) => {
    switch (lastUsedBucket(lastUsedAt)) {
      case "never":
        return t("Never used");
      case "recent":
        return t("Within the last hour");
      case "stale":
        // Coarse relative time — last_used_at is throttled to ~1h server-side,
        // so we don't promise finer precision.
        return timeAgo(new Date(lastUsedAt as string));
    }
  };

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }

  const rows = (keys ?? []).map((key) => {
    // Mutually exclusive: an already-expired key is labelled "Expired" (a past
    // expiry) rather than the forward-looking "Expiring soon". isExpiringSoon
    // also matches past expiries, so gate "soon" on !expired.
    const expired = isExpired(key.expiresAt);
    const soon = !expired && isExpiringSoon(key.expiresAt);
    return (
      <Table.Tr key={key.id}>
        <Table.Td>
          <Text fw={500}>{key.name}</Text>
        </Table.Td>
        <Table.Td>{formatDate(key.createdAt)}</Table.Td>
        <Table.Td>
          {key.expiresAt ? (
            <Group gap={6} wrap="nowrap">
              <Text size="sm">{formatDate(key.expiresAt)}</Text>
              {expired && (
                <Tooltip label={t("This key has expired")} withArrow>
                  <Badge
                    color="red"
                    variant="light"
                    size="sm"
                    leftSection={<IconAlertTriangle size={12} />}
                  >
                    {t("Expired")}
                  </Badge>
                </Tooltip>
              )}
              {soon && (
                <Tooltip
                  label={t("This key expires within 30 days")}
                  withArrow
                >
                  <Badge
                    color="orange"
                    variant="light"
                    size="sm"
                    leftSection={<IconAlertTriangle size={12} />}
                  >
                    {t("Expiring soon")}
                  </Badge>
                </Tooltip>
              )}
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              {t("Never")}
            </Text>
          )}
        </Table.Td>
        <Table.Td>
          <Text size="sm" c="dimmed">
            {renderLastUsed(key.lastUsedAt)}
          </Text>
        </Table.Td>
        {isAdmin && (
          <Table.Td>
            <Text size="sm">
              {key.creator?.name ?? key.creator?.email ?? t("Unknown")}
            </Text>
          </Table.Td>
        )}
        <Table.Td style={{ textAlign: "right" }}>
          <Group gap={4} justify="flex-end" wrap="nowrap">
            <Tooltip label={t("Copy API key")} withArrow>
              <ActionIcon
                variant="subtle"
                aria-label={t("Copy {{name}}", { name: key.name })}
                disabled={expired}
                onClick={() => setRevealTarget(key)}
              >
                <IconCopy size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("Revoke")} withArrow>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t("Revoke {{name}}", { name: key.name })}
                onClick={() => openRevokeModal(key)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
    );
  });

  return (
    <>
      <Group justify="space-between" mb="md">
        <Text size="sm" c="dimmed">
          {isAdmin
            ? t("API keys across the workspace.")
            : t("Your personal API keys.")}
        </Text>
        <Button
          leftSection={<IconKey size={16} />}
          onClick={() => setCreateOpened(true)}
        >
          {t("Create API key")}
        </Button>
      </Group>

      {isError ? (
        <Text c="red" size="sm">
          {t("Failed to load API keys.")}
        </Text>
      ) : rows.length === 0 ? (
        <Stack align="center" gap="xs" py="xl">
          <IconKey size={32} opacity={0.4} />
          <Text c="dimmed">{t("No API keys yet")}</Text>
          <Button
            variant="light"
            leftSection={<IconKey size={16} />}
            onClick={() => setCreateOpened(true)}
          >
            {t("Create API key")}
          </Button>
        </Stack>
      ) : (
        <Table.ScrollContainer minWidth={600}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("Name")}</Table.Th>
                <Table.Th>{t("Created")}</Table.Th>
                <Table.Th>{t("Expires")}</Table.Th>
                <Table.Th>{t("Last used")}</Table.Th>
                {isAdmin && <Table.Th>{t("Author")}</Table.Th>}
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>{rows}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <CreateApiKeyModal
        opened={createOpened}
        onClose={() => setCreateOpened(false)}
        onSubmit={handleCreate}
        loading={createMutation.isPending}
      />

      <RevealKeyModal
        keyName={revealTarget?.name ?? null}
        opened={revealTarget !== null}
        onClose={() => setRevealTarget(null)}
        onConfirm={handleCopy}
        loading={revealMutation.isPending}
      />
    </>
  );
}
