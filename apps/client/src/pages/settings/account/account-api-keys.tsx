import SettingsTitle from "@/components/settings/settings-title.tsx";
import ApiKeysManager from "@/features/api-key/components/api-keys-manager";
import { getAppName } from "@/lib/config.ts";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";

export default function AccountApiKeys() {
  const { t } = useTranslation();

  return (
    <>
      <Helmet>
        <title>
          {t("API keys")} - {getAppName()}
        </title>
      </Helmet>
      <SettingsTitle title={t("API keys")} />

      <ApiKeysManager />
    </>
  );
}
