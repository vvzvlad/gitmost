import SettingsTitle from "@/components/settings/settings-title.tsx";
import McpSettings from "@/features/workspace/components/settings/components/mcp-settings.tsx";
import AiProviderSettings from "@/features/workspace/components/settings/components/ai-provider-settings.tsx";
import AiAgentRoles from "@/features/workspace/components/settings/components/ai-agent-roles.tsx";
import { useTranslation } from "react-i18next";
import { getAppName } from "@/lib/config.ts";
import { Helmet } from "react-helmet-async";
import { Divider } from "@mantine/core";
import useUserRole from "@/hooks/use-user-role.tsx";

export default function AiSettings() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  return (
    <>
      <Helmet>
        <title>
          {t("AI")} - {getAppName()}
        </title>
      </Helmet>
      <SettingsTitle title={t("AI")} />
      {isAdmin && <AiProviderSettings />}

      {isAdmin && (
        <>
          <Divider my="lg" />
          <AiAgentRoles />
        </>
      )}

      <Divider my="lg" />

      <McpSettings />
    </>
  );
}
