import { Button, Group, Text } from "@mantine/core";
import type { ReactNode } from "react";

type MoveToTrashNotificationProps = {
  message: string;
  undoLabel: string;
  onUndo: () => void;
};

// Builds the body of the "page moved to trash" toast: the status text plus an
// inline Undo action that restores the page from trash. Returned as a ReactNode
// so it can be passed as the `message` of a Mantine notification from a
// non-TSX module (page-query.ts).
export function moveToTrashNotificationMessage({
  message,
  undoLabel,
  onUndo,
}: MoveToTrashNotificationProps): ReactNode {
  return (
    <Group justify="space-between" wrap="nowrap" gap="md">
      <Text size="sm">{message}</Text>
      <Button variant="subtle" size="compact-sm" onClick={onUndo}>
        {undoLabel}
      </Button>
    </Group>
  );
}
