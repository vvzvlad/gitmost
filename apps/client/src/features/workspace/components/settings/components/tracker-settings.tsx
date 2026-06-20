import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useAtom } from "jotai";
import { useState } from "react";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import {
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";

/**
 * Admin-only analytics/tracker snippet for public share pages.
 *
 * The value is injected VERBATIM into the <head> of PUBLIC SHARE pages only,
 * in the page's own (same-origin) context. It is the deliberate same-origin
 * surface for analytics snippets (Google Analytics, Yandex.Metrika, etc.).
 * Admin only — the workspace settings write is admin-gated server-side, and the
 * Save button is disabled for non-admins.
 */
export default function TrackerSettings() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const { isAdmin } = useUserRole();

  const [value, setValue] = useState<string>(
    workspace?.settings?.trackerHead ?? "",
  );
  const [isLoading, setIsLoading] = useState(false);

  async function handleSave() {
    setIsLoading(true);
    try {
      const updated = await updateWorkspace({ trackerHead: value });
      setWorkspace({
        ...updated,
        settings: {
          ...updated.settings,
          trackerHead: value,
        },
      });
      notifications.show({ message: t("Updated successfully") });
    } catch (err) {
      console.log(err);
      notifications.show({
        message: t("Failed to update data"),
        color: "red",
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Stack mt="sm">
      <Group justify="space-between" align="center">
        <Text fw={700} size="lg">
          {t("Analytics / tracker")}
        </Text>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          {t("advanced")}
        </Text>
      </Group>

      <Paper withBorder radius="md" p="lg">
        <Text size="xs" c="dimmed" mb="xs">
          {t(
            "Injected verbatim into the <head> of PUBLIC SHARE pages only (same-origin). For analytics snippets (Google Analytics, Yandex.Metrika, etc.). Admin only.",
          )}
        </Text>
        <Textarea
          autosize
          minRows={6}
          maxRows={20}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder={t("<script>...</script>")}
          styles={{ input: { fontFamily: "monospace" } }}
          disabled={!isAdmin || isLoading}
        />
        <Group justify="flex-end" mt="md">
          <Button
            onClick={handleSave}
            loading={isLoading}
            disabled={!isAdmin}
          >
            {t("Save")}
          </Button>
        </Group>
      </Paper>
    </Stack>
  );
}
