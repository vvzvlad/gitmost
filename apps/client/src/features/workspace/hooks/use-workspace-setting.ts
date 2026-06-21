import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useAtom } from "jotai";
import { useCallback, useState } from "react";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { IWorkspace } from "@/features/workspace/types/workspace.types.ts";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";

/**
 * Workspace setting keys that this hook can persist. Each key is both a
 * write-only field on the update payload and a read field under
 * `workspace.settings`, so the value type is derived from the settings shape.
 */
type WorkspaceSettingKey = "htmlEmbed" | "trackerHead";
type WorkspaceSettingValue<K extends WorkspaceSettingKey> =
  NonNullable<IWorkspace["settings"][K]>;

/**
 * Shared "save a workspace setting" plumbing extracted from the individual
 * settings components. Owns the `isLoading` state and the persist-then-merge
 * flow (call `updateWorkspace`, merge the response back into the workspace atom
 * while forcing `settings[key]` to the saved value, and surface a success/error
 * notification). Callers keep their own interaction model (optimistic toggle,
 * edit-then-save, etc.) on top of this.
 */
export function useWorkspaceSetting<K extends WorkspaceSettingKey>(key: K) {
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);

  const save = useCallback(
    async (value: WorkspaceSettingValue<K>): Promise<boolean> => {
      setIsLoading(true);
      try {
        const updated = await updateWorkspace({
          [key]: value,
        } as Partial<IWorkspace>);
        // Force settings[key] to the new value so the atom is consistent even
        // if the response shape omits it.
        setWorkspace({
          ...updated,
          settings: {
            ...updated.settings,
            [key]: value,
          },
        });
        notifications.show({ message: t("Updated successfully") });
        return true;
      } catch (err) {
        console.error(`Failed to update workspace setting "${key}"`, err);
        notifications.show({
          message:
            (err as any)?.response?.data?.message ?? t("Failed to update data"),
          color: "red",
        });
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [key, setWorkspace, t],
  );

  return { workspace, isLoading, save };
}
