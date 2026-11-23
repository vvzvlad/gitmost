import {
  Group,
  Center,
  Text,
  ActionIcon,
  Tooltip,
  getDefaultZIndex,
} from "@mantine/core";
import { Spotlight } from "@mantine/spotlight";
import { Link } from "react-router-dom";
import { IconFile, IconDownload } from "@tabler/icons-react";
import { buildPageUrl } from "@/features/page/page.utils";
import { getPageIcon } from "@/lib";
import {
  IAttachmentSearch,
  IPageSearch,
} from "@/features/search/types/search.types";
import DOMPurify from "dompurify";
import { useTranslation } from "react-i18next";

interface SearchResultItemProps {
  result: IPageSearch | IAttachmentSearch;
  isAttachmentResult: boolean;
}

export function SearchResultItem({
  result,
  isAttachmentResult,
}: SearchResultItemProps) {
  const { t } = useTranslation();

  if (isAttachmentResult) {
    const attachmentResult = result as IAttachmentSearch;

    const downloadUrl = `/api/files/${attachmentResult.id}/${encodeURIComponent(attachmentResult.fileName)}`;

    return (
      <Group wrap="nowrap" gap="xs" pr="sm">
        <Spotlight.Action
          component={Link}
          // @ts-ignore
          to={buildPageUrl(
            attachmentResult.space.slug,
            attachmentResult.page.slugId,
            attachmentResult.page.title ?? undefined,
          )}
          style={{ flex: 1, minWidth: 0, userSelect: "none" }}
        >
          <Group wrap="nowrap" w="100%">
            <Center>
              <IconFile size={16} />
            </Center>

            <div style={{ flex: 1, minWidth: 0 }}>
              <Text truncate>{attachmentResult.fileName}</Text>
              <Text size="xs" c="dimmed" truncate>
                {attachmentResult.space.name} •{" "}
                {attachmentResult.page.title || t("Untitled")}
              </Text>
              {attachmentResult.snippet && (
                <Text c="dimmed" size="xs" lineClamp={2}>
                  {attachmentResult.snippet}
                </Text>
              )}
            </div>
          </Group>
        </Spotlight.Action>
        <Tooltip
          label={t("Download attachment")}
          zIndex={getDefaultZIndex("max")}
          withArrow
        >
          <ActionIcon
            component="a"
            href={downloadUrl}
            target="_blank"
            rel="noopener"
            variant="subtle"
            color="gray"
            aria-label={t("Download attachment")}
          >
            <IconDownload size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>
    );
  } else {
    const pageResult = result as IPageSearch;
    const path = [
      ...(pageResult.space ? [pageResult.space.name] : []),
      ...(pageResult.path ?? []).map((title) => title || t("Untitled")),
    ].join(" / ");
    return (
      <Spotlight.Action
        component={Link}
        //@ts-ignore
        to={buildPageUrl(
          pageResult.space.slug,
          pageResult.slugId,
          pageResult.title,
        )}
        style={{ userSelect: "none" }}
      >
        <Group wrap="nowrap" w="100%">
          <Center>{getPageIcon(pageResult?.icon)}</Center>

          <div style={{ flex: 1 }}>
            <Text>{pageResult.title}</Text>

            {path && (
              <Text size="xs" c="dimmed" lineClamp={1} title={path}>
                {path}
              </Text>
            )}

            {pageResult?.highlight && (
              <Text
                opacity={0.6}
                size="xs"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(pageResult.highlight, {
                    ALLOWED_TAGS: ["mark", "em", "strong", "b"],
                    ALLOWED_ATTR: [],
                  }),
                }}
              />
            )}
          </div>
        </Group>
      </Spotlight.Action>
    );
  }
}
