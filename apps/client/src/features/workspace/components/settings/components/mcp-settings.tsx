import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useAtom } from "jotai";
import { useState } from "react";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { Switch, TextInput, Stack, ActionIcon, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCopy, IconCheck } from "@tabler/icons-react";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";
import { getAppUrl } from "@/lib/config.ts";
import { CopyButton } from "@/components/common/copy-button.tsx";

export default function McpSettings() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const { isAdmin } = useUserRole();

  const [checked, setChecked] = useState<boolean>(
    workspace?.settings?.ai?.mcp ?? false,
  );
  const [isLoading, setIsLoading] = useState(false);

  const mcpUrl = `${getAppUrl()}/mcp`;

  async function handleToggle(value: boolean) {
    setIsLoading(true);
    const previous = checked;
    setChecked(value); // optimistic update
    try {
      const updated = await updateWorkspace({ mcpEnabled: value });
      // Force settings.ai.mcp to the new value so the atom is consistent
      // even if the response shape omits it.
      setWorkspace({
        ...updated,
        settings: {
          ...updated.settings,
          ai: { ...updated.settings?.ai, mcp: value },
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
      <Switch
        label={t("Model Context Protocol (MCP)")}
        description={t(
          "Enable the MCP server to allow AI assistants and tools to interact with your workspace content.",
        )}
        checked={checked}
        disabled={!isAdmin || isLoading}
        onChange={(event) => handleToggle(event.currentTarget.checked)}
      />

      {checked && (
        <TextInput
          label={t("MCP Server URL")}
          value={mcpUrl}
          readOnly
          variant="filled"
          rightSection={
            <CopyButton value={mcpUrl}>
              {({ copied, copy }) => (
                <Tooltip
                  label={copied ? t("Copied") : t("Copy")}
                  withArrow
                  position="left"
                >
                  <ActionIcon
                    color={copied ? "teal" : "gray"}
                    variant="subtle"
                    onClick={copy}
                  >
                    {copied ? (
                      <IconCheck size={16} />
                    ) : (
                      <IconCopy size={16} />
                    )}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          }
        />
      )}
    </Stack>
  );
}
