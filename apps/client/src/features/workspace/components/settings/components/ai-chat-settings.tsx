import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useAtom } from "jotai";
import { useState } from "react";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { Switch, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";

export default function AiChatSettings() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const { isAdmin } = useUserRole();

  const [checked, setChecked] = useState<boolean>(
    workspace?.settings?.ai?.chat ?? false,
  );
  const [isLoading, setIsLoading] = useState(false);

  async function handleToggle(value: boolean) {
    setIsLoading(true);
    const previous = checked;
    setChecked(value); // optimistic update
    try {
      const updated = await updateWorkspace({ aiChat: value });
      // Force settings.ai.chat to the new value so the atom is consistent
      // even if the response shape omits it.
      setWorkspace({
        ...updated,
        settings: {
          ...updated.settings,
          ai: { ...updated.settings?.ai, chat: value },
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
        label={t("AI chat")}
        description={t(
          "Enable the AI chat assistant so users can have multi-turn conversations with AI about your workspace content.",
        )}
        checked={checked}
        disabled={!isAdmin || isLoading}
        onChange={(event) => handleToggle(event.currentTarget.checked)}
      />
    </Stack>
  );
}
