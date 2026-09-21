import { useState } from "react";
import { useAtom } from "jotai";
import {
  Button,
  Group,
  NumberInput,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { IWorkspace } from "@/features/workspace/types/workspace.types.ts";

// Mirrors DEFAULT_TEMPORARY_NOTE_HOURS on the server. Shown when the workspace
// has no explicit value configured yet.
const DEFAULT_TEMPORARY_NOTE_HOURS = 24;

/**
 * Workspace-level editor for the temporary-note lifetime, in HOURS. The deadline
 * is frozen per-note at creation, so changing this only affects notes created
 * afterwards. `temporaryNoteHours` is a top-level workspace column (like
 * trashRetentionDays), not a nested setting.
 */
export default function TemporaryNoteSettings() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const { isAdmin } = useUserRole();
  const [isLoading, setIsLoading] = useState(false);
  const [value, setValue] = useState<number>(
    workspace?.temporaryNoteHours ?? DEFAULT_TEMPORARY_NOTE_HOURS,
  );

  async function handleSave() {
    if (!value || value < 1) return;
    setIsLoading(true);
    try {
      const updated = await updateWorkspace({
        temporaryNoteHours: value,
      } as Partial<IWorkspace>);
      setWorkspace({ ...updated, temporaryNoteHours: value });
      notifications.show({ message: t("Updated successfully") });
    } catch (err) {
      notifications.show({
        message:
          (err as any)?.response?.data?.message ?? t("Failed to update data"),
        color: "red",
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Stack mt="sm">
      <Text fw={700} size="lg">
        {t("Temporary notes")}
      </Text>

      <Paper withBorder radius="md" p="lg">
        <Text size="xs" c="dimmed" mb="xs">
          {t(
            "A temporary note is automatically moved to trash after this many hours unless it is made permanent. The deadline is fixed when the note is created.",
          )}
        </Text>
        <NumberInput
          label={t("Temporary note lifetime (hours)")}
          min={1}
          allowDecimal={false}
          value={value}
          onChange={(v) => setValue(typeof v === "number" ? v : Number(v))}
          disabled={!isAdmin || isLoading}
          w={220}
        />
        <Group justify="flex-end" mt="md">
          <Button onClick={handleSave} loading={isLoading} disabled={!isAdmin}>
            {t("Save")}
          </Button>
        </Group>
      </Paper>
    </Stack>
  );
}
