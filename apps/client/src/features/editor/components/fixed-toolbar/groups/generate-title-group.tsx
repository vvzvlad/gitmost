import { FC } from "react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useGeneratePageTitle } from "@/features/editor/hooks/use-generate-page-title.ts";

interface Props {
  pageId: string;
  color?: string;
  iconSize?: number;
}

/**
 * AI "generate title" button (#199). Reads the live editor content and applies a
 * model-suggested title immediately. Rendered in the page byline, only in edit
 * mode and when the workspace's generative AI flag is on.
 */
export const GenerateTitleGroup: FC<Props> = ({
  pageId,
  color = "gray",
  iconSize = 20,
}) => {
  const { t } = useTranslation();
  const gen = useGeneratePageTitle(pageId);

  return (
    <Tooltip label={t("Generate title with AI")} withArrow openDelay={250}>
      <ActionIcon
        variant="subtle"
        color={color}
        aria-label={t("Generate title with AI")}
        loading={gen.isPending}
        onClick={() => gen.mutate()}
      >
        <IconSparkles size={iconSize} stroke={1.5} />
      </ActionIcon>
    </Tooltip>
  );
};
