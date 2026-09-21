import { Modal } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { IAiMcpServer } from "./mcp-server-types.ts";
import {
  UseCreateMcpServerMutation,
  UseUpdateMcpServerMutation,
  UseTestMcpServerMutation,
} from "./mcp-mutation-hooks.ts";
import McpServerForm from "./mcp-server-form.tsx";

interface McpServerFormModalProps {
  opened: boolean;
  onClose: () => void;
  // The server being edited; undefined means the modal is in "create" mode.
  editing?: IAiMcpServer;
  useCreateMutation: UseCreateMcpServerMutation;
  useUpdateMutation: UseUpdateMcpServerMutation;
  useTestMutation: UseTestMcpServerMutation;
}

/**
 * Add/edit modal for an external MCP server, shared (#686) by the admin and the
 * personal (account) pages. Owns the remount key (`editing?.id ?? "new"`) so the
 * form's internal state re-hydrates per target, and forwards the scope-specific
 * mutation hooks to the shared form.
 */
export default function McpServerFormModal({
  opened,
  onClose,
  editing,
  useCreateMutation,
  useUpdateMutation,
  useTestMutation,
}: McpServerFormModalProps) {
  const { t } = useTranslation();

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={editing ? t("Edit server") : t("Add server")}
      size="lg"
    >
      {/* Remount the form per target so its internal state re-hydrates. */}
      <McpServerForm
        key={editing?.id ?? "new"}
        server={editing}
        onClose={onClose}
        useCreateMutation={useCreateMutation}
        useUpdateMutation={useUpdateMutation}
        useTestMutation={useTestMutation}
      />
    </Modal>
  );
}
