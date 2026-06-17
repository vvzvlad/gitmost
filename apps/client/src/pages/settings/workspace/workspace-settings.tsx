import SettingsTitle from "@/components/settings/settings-title.tsx";
import WorkspaceNameForm from "@/features/workspace/components/settings/components/workspace-name-form";
import WorkspaceIcon from "@/features/workspace/components/settings/components/workspace-icon.tsx";
import McpSettings from "@/features/workspace/components/settings/components/mcp-settings.tsx";
import AiProviderSettings from "@/features/workspace/components/settings/components/ai-provider-settings.tsx";
import AiChatSettings from "@/features/workspace/components/settings/components/ai-chat-settings.tsx";
import AiMcpServers from "@/features/workspace/components/settings/components/ai-mcp-servers.tsx";
import { useTranslation } from "react-i18next";
import { getAppName } from "@/lib/config.ts";
import { Helmet } from "react-helmet-async";
import { Divider } from "@mantine/core";
import useUserRole from "@/hooks/use-user-role.tsx";

export default function WorkspaceSettings() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  return (
    <>
      <Helmet>
        <title>Workspace Settings - {getAppName()}</title>
      </Helmet>
      <SettingsTitle title={t("General")} />
      <WorkspaceIcon />
      <WorkspaceNameForm />

      <Divider my="lg" />

      <SettingsTitle title={t("AI & MCP")} />
      <McpSettings />

      {isAdmin && (
        <>
          <Divider my="lg" />

          <SettingsTitle title={t("AI / Models")} />
          <AiProviderSettings />

          <Divider my="lg" />

          <SettingsTitle title={t("AI / Chat")} />
          <AiChatSettings />

          <Divider my="lg" />

          <SettingsTitle title={t("AI / External tools (MCP)")} />
          <AiMcpServers />
        </>
      )}
    </>
  );
}
