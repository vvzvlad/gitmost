import React, { useCallback, useEffect, useState } from "react";
import { Editor } from "@tiptap/react";
import {
  ActionIcon,
  Button,
  Group,
  Paper,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { IconTextCaption } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

const CAPTION_MAX_LENGTH = 500;

// Caption is plain visible text (not a markdown link target like alt), so it is
// sanitized more softly than alt: collapse runs of whitespace/newlines into a
// single space and trim, keeping the limit generous.
export function sanitizeCaption(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX_LENGTH);
}

type UseCaptionControlArgs = {
  editor: Editor;
  nodeName: string;
  currentCaption: string;
};

export function useCaptionControl({
  editor,
  nodeName,
  currentCaption,
}: UseCaptionControlArgs) {
  const { t } = useTranslation();
  const [showInput, setShowInput] = useState(false);
  const [draft, setDraft] = useState("");

  const open = useCallback(() => {
    setDraft(currentCaption || "");
    setShowInput(true);
  }, [currentCaption]);

  useEffect(() => {
    const handler = () => {
      if (!editor.isActive(nodeName)) {
        setShowInput(false);
      }
    };
    editor.on("selectionUpdate", handler);
    return () => {
      editor.off("selectionUpdate", handler);
    };
  }, [editor, nodeName]);

  const cancel = useCallback(() => {
    setShowInput(false);
  }, []);

  const save = useCallback(() => {
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .updateAttributes(nodeName, {
        caption: sanitizeCaption(draft) || undefined,
      })
      .run();
    setShowInput(false);
  }, [editor, nodeName, draft]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [save, cancel],
  );

  const button = (
    <Tooltip position="top" label={t("Caption")} withinPortal={false}>
      <ActionIcon
        onClick={open}
        size="lg"
        aria-label={t("Caption")}
        variant="subtle"
      >
        <IconTextCaption size={18} />
      </ActionIcon>
    </Tooltip>
  );

  const panel = showInput ? (
    <Paper
      withBorder
      shadow="md"
      radius={6}
      p="sm"
      w={320}
      style={{ position: "relative", zIndex: 100 }}
    >
      <Text size="sm" fw={600} mb={2}>
        {t("Caption")}
      </Text>
      <Text size="xs" c="dimmed" mb="xs">
        {t("Shown below the image.")}
      </Text>
      <Textarea
        size="xs"
        placeholder={t("Add a caption")}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        autoFocus
        autosize
        minRows={2}
        maxRows={5}
        maxLength={CAPTION_MAX_LENGTH}
      />
      <Group justify="space-between" align="center" mt="xs" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {draft.length}/{CAPTION_MAX_LENGTH}
        </Text>
        <Group gap="xs">
          <Button size="compact-xs" variant="default" onClick={cancel}>
            {t("Cancel")}
          </Button>
          <Button size="compact-xs" onClick={save}>
            {t("Save")}
          </Button>
        </Group>
      </Group>
    </Paper>
  ) : null;

  return { button, panel, isEditing: showInput };
}
