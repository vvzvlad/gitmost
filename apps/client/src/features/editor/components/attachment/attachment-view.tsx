import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import {
  Group,
  Text,
  Paper,
  ActionIcon,
  Loader,
  Tooltip,
  ThemeIcon,
  Button,
} from "@mantine/core";
import { getFileUrl } from "@/lib/config.ts";
import {
  IconDownload,
  IconFileTypePdf,
  IconFileTypeDocx,
  IconPaperclip,
  IconExternalLink,
} from "@tabler/icons-react";
import { formatBytes } from "@/lib";
import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import classes from "./attachment-view.module.css";

export default function AttachmentView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { editor, node, getPos } = props;
  const { url, name, size, mime, attachmentId, placeholder } = node.attrs;

  const isPdf =
    mime === "application/pdf" || name?.toLowerCase().endsWith(".pdf");

  const isWord = name?.toLowerCase().endsWith(".docx");
  const FileIcon = isPdf
    ? IconFileTypePdf
    : isWord
      ? IconFileTypeDocx
      : IconPaperclip;
  const fileUrl = url ? getFileUrl(url) : undefined;

  const handleEmbedAsPdf = useCallback(() => {
    const pos = getPos();
    if (pos === undefined || !url) return;

    const nodeSize = node.nodeSize;

    editor
      .chain()
      .insertContentAt(
        { from: pos, to: pos + nodeSize },
        {
          type: "pdf",
          attrs: {
            src: url,
            name,
            attachmentId,
            size,
          },
        },
      )
      .run();
  }, [editor, getPos, node, url, name, attachmentId]);

  return (
    <NodeViewWrapper>
      <Paper withBorder className={classes.file} data-drag-handle>
        <Group wrap="nowrap" gap="sm">
          <ThemeIcon
            variant="light"
            color={isPdf ? "red" : "ocean"}
            size={40}
            radius="md"
            className={classes.fileIcon}
          >
            {!url && placeholder ? (
              <Loader size={20} />
            ) : (
              <FileIcon size={24} />
            )}
          </ThemeIcon>
          <div className={classes.details}>
            <Text component="span" className={classes.name} title={name}>
              {!url && placeholder ? t("Uploading {{name}}", { name }) : name}
            </Text>
            <Text size="xs" c="dimmed">
              {formatBytes(size)}
            </Text>
          </div>
          {fileUrl && (
            <Group
              gap={4}
              wrap="nowrap"
              className={classes.actions}
              contentEditable={false}
            >
              {isPdf && editor.isEditable && (
                <Tooltip label={t("Embed as PDF")} withinPortal={false}>
                  <ActionIcon
                    variant="subtle"
                    aria-label={t("Embed as PDF")}
                    onClick={handleEmbedAsPdf}
                  >
                    <IconFileTypePdf size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label={t("Open in new tab")} withinPortal={false}>
                <Button
                  component="a"
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="subtle"
                  aria-label={t("Open in new tab")}
                  leftSection={<IconExternalLink size={17} />}
                  size="compact-sm"
                  className={classes.fileAction}
                >
                  <span className={classes.actionLabel}>{t("Open file")}</span>
                </Button>
              </Tooltip>
              <Tooltip label={t("Download attachment")} withinPortal={false}>
                <Button
                  component="a"
                  href={fileUrl}
                  download={name}
                  variant="subtle"
                  aria-label={t("Download attachment")}
                  leftSection={<IconDownload size={17} />}
                  size="compact-sm"
                  className={classes.fileAction}
                >
                  <span className={classes.actionLabel}>{t("Download")}</span>
                </Button>
              </Tooltip>
            </Group>
          )}
        </Group>
      </Paper>
    </NodeViewWrapper>
  );
}
