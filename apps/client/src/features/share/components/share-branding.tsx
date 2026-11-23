import { Affix, Button } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { getAppName } from "@/lib/config";

export default function ShareBranding() {
  const { t } = useTranslation();
  return (
    // Pinned to the bottom-RIGHT corner. The AI assistant FAB
    // (share-ai-widget.tsx) is stacked ABOVE this with a higher `bottom`
    // offset, so the two Affix elements never overlap.
    <Affix position={{ bottom: 20, right: 20 }}>
      <Button
        variant="default"
        component="a"
        target="_blank"
        rel="noopener noreferrer"
        href="https://github.com/Dozor-dev-coder/DozoR-WIKI"
      >
        {t("Powered by {{appName}}", { appName: getAppName() })}
      </Button>
    </Affix>
  );
}
