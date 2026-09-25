import { useState } from "react";
import { useWorkspaceSetting } from "@/features/workspace/hooks/use-workspace-setting.ts";
import { Switch, Stack, Paper, Group, Text, List } from "@mantine/core";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";

/**
 * Workspace toggle for the quick-action icons on a sidebar page-tree row (copy
 * link + move to trash). Purely a UI-density preference: both actions stay
 * available in the row's "⋮" menu regardless of this toggle, so turning it off
 * removes clutter, not capability. The toggle itself is managed by workspace
 * admins.
 *
 * ON by default: the icons already ship, so an ABSENT key must keep them
 * visible — the value is read as `treeQuickActions !== false`, never `=== true`.
 */
export default function TreeQuickActionsSettings() {
  const { t } = useTranslation();
  const { workspace, isLoading, save } = useWorkspaceSetting("treeQuickActions");
  const { isAdmin } = useUserRole();

  // ABSENT => ON (default), so compare against `false` rather than testing for
  // an explicit `true`.
  const [checked, setChecked] = useState<boolean>(
    workspace?.settings?.treeQuickActions !== false,
  );

  async function handleToggle(value: boolean) {
    const previous = checked;
    setChecked(value); // optimistic update
    const ok = await save(value);
    if (!ok) setChecked(previous); // revert on failure
  }

  return (
    <Stack mt="sm">
      <Group justify="space-between" align="center">
        <Text fw={700} size="lg">
          {t("Sidebar quick actions")}
        </Text>
      </Group>

      <Paper withBorder radius="md" p="lg">
        <Switch
          label={t("Show quick action icons in the page tree")}
          description={t(
            "Show the copy link and move to trash icons on hover over a page row in the sidebar. On by default.",
          )}
          checked={checked}
          disabled={!isAdmin || isLoading}
          onChange={(event) => handleToggle(event.currentTarget.checked)}
        />

        <List size="xs" c="dimmed" mt="md" spacing={4}>
          <List.Item>
            {t(
              "The icons appear on the right side of a page row in the sidebar when you hover over it.",
            )}
          </List.Item>
          <List.Item>
            {t(
              "Turning this off only hides the icons — copy link and move to trash stay available in the row's menu.",
            )}
          </List.Item>
        </List>
      </Paper>
    </Stack>
  );
}
