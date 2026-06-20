import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useAtom } from "jotai";
import { useState } from "react";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { Switch, Stack, Paper, Group, Text, List } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";

/**
 * Admin toggle for the workspace HTML embed feature.
 *
 * SECURITY: when ON, workspace admins/owners can embed raw HTML/CSS/JS that
 * EXECUTES in the wiki page origin for every reader (a deliberate stored-XSS
 * surface, e.g. for analytics trackers). OFF by default. The server strips
 * htmlEmbed nodes on every write where the toggle is OFF or the saver is not an
 * admin, so this switch fully enables/disables the feature workspace-wide.
 */
export default function HtmlEmbedSettings() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const { isAdmin } = useUserRole();

  const [checked, setChecked] = useState<boolean>(
    workspace?.settings?.htmlEmbed ?? false,
  );
  const [isLoading, setIsLoading] = useState(false);

  async function handleToggle(value: boolean) {
    setIsLoading(true);
    const previous = checked;
    setChecked(value); // optimistic update
    try {
      const updated = await updateWorkspace({ htmlEmbed: value });
      // Force settings.htmlEmbed to the new value so the atom is consistent even
      // if the response shape omits it.
      setWorkspace({
        ...updated,
        settings: {
          ...updated.settings,
          htmlEmbed: value,
        },
      });
      notifications.show({ message: t("Updated successfully") });
    } catch (err) {
      console.log(err);
      setChecked(previous); // revert on failure
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
          {t("HTML embed")}
        </Text>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          {t("advanced")}
        </Text>
      </Group>

      <Paper withBorder radius="md" p="lg">
        <Switch
          label={t("Enable HTML embed")}
          description={t(
            "Allow workspace admins to insert raw HTML/CSS/JavaScript that EXECUTES in the wiki page origin for everyone who views the page (a deliberate stored-XSS surface, e.g. for analytics trackers). Off by default.",
          )}
          checked={checked}
          disabled={!isAdmin || isLoading}
          onChange={(event) => handleToggle(event.currentTarget.checked)}
        />

        <List size="xs" c="dimmed" mt="md" spacing={4}>
          <List.Item>
            {t(
              "Only workspace admins/owners can insert HTML embeds. Members never can: the editor option is hidden for them and the server strips the embed on save at every write path.",
            )}
          </List.Item>
          <List.Item>
            {t(
              "If a non-admin edits and saves a page that contains an admin's embed, that save strips the embed (fail-closed). An admin must re-add it.",
            )}
          </List.Item>
          <List.Item>
            {t(
              "Turning this off strips existing embeds on their next save and immediately disables execution (existing embeds render as a disabled placeholder).",
            )}
          </List.Item>
        </List>
      </Paper>
    </Stack>
  );
}
