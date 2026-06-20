import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useAtom } from "jotai";
import { useState } from "react";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { Switch, Stack, Paper, Group, Text, List } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";

/**
 * Workspace master toggle that enables/disables the HTML embed block type.
 *
 * The block renders inside a SANDBOXED iframe (no same-origin access), so it
 * cannot touch the viewer's session/cookies/API — it is a feature switch, not a
 * security gate. When ON, ANY member can insert the block. OFF by default; for
 * anonymous public-share reads the server serves already-stripped content when
 * the toggle is OFF. The toggle itself is managed by workspace admins.
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
            "Allow members to insert raw HTML/CSS/JavaScript blocks. The block renders in a sandboxed frame and cannot access the viewer's session, cookies, or API. Off by default.",
          )}
          checked={checked}
          disabled={!isAdmin || isLoading}
          onChange={(event) => handleToggle(event.currentTarget.checked)}
        />

        <List size="xs" c="dimmed" mt="md" spacing={4}>
          <List.Item>
            {t(
              "When enabled, any member can insert an HTML embed block. The toggle just enables or disables the block type workspace-wide.",
            )}
          </List.Item>
          <List.Item>
            {t(
              "Embeds run inside a sandboxed iframe with a separate origin, so they cannot read or modify the page they are embedded in.",
            )}
          </List.Item>
          <List.Item>
            {t(
              "Turning this off hides existing embeds (they render as a disabled placeholder) and stops serving them on public share pages.",
            )}
          </List.Item>
        </List>
      </Paper>
    </Stack>
  );
}
