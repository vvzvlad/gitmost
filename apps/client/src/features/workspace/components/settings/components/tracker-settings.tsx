import { useState } from "react";
import { useWorkspaceSetting } from "@/features/workspace/hooks/use-workspace-setting.ts";
import {
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
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
  const { workspace, isLoading, save } = useWorkspaceSetting("trackerHead");
  const { isAdmin } = useUserRole();

  const [value, setValue] = useState<string>(
    workspace?.settings?.trackerHead ?? "",
  );

  async function handleSave() {
    await save(value);
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
          aria-label={t("Analytics / tracker")}
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
