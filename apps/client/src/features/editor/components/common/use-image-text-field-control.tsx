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
import { useTranslation } from "react-i18next";

// Shared logic+UI for the image bubble-menu text-field popovers (alt text,
// caption, ...). Each field is the same popover — an ActionIcon that opens a
// titled Paper with a counted Textarea and Cancel/Save — differing only in the
// node attribute it writes, its sanitizer, length cap, icon and labels. The
// label/description/placeholder are passed already translated so the literal
// t("...") calls stay in the thin wrappers and remain extractable; the shared
// Cancel/Save strings are translated here.
type UseImageTextFieldControlArgs = {
  editor: Editor;
  nodeName: string;
  currentValue: string;
  attrName: string;
  sanitize: (value: string) => string;
  maxLength: number;
  icon: React.ReactNode;
  label: string;
  description: string;
  placeholder: string;
};

export function useImageTextFieldControl({
  editor,
  nodeName,
  currentValue,
  attrName,
  sanitize,
  maxLength,
  icon,
  label,
  description,
  placeholder,
}: UseImageTextFieldControlArgs) {
  const { t } = useTranslation();
  const [showInput, setShowInput] = useState(false);
  const [draft, setDraft] = useState("");

  const open = useCallback(() => {
    setDraft(currentValue || "");
    setShowInput(true);
  }, [currentValue]);

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
      .updateAttributes(nodeName, { [attrName]: sanitize(draft) || undefined })
      .run();
    setShowInput(false);
  }, [editor, nodeName, attrName, sanitize, draft]);

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
    <Tooltip position="top" label={label} withinPortal={false}>
      <ActionIcon onClick={open} size="lg" aria-label={label} variant="subtle">
        {icon}
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
        {label}
      </Text>
      <Text size="xs" c="dimmed" mb="xs">
        {description}
      </Text>
      <Textarea
        size="xs"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        autoFocus
        autosize
        minRows={2}
        maxRows={5}
        maxLength={maxLength}
      />
      <Group justify="space-between" align="center" mt="xs" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {draft.length}/{maxLength}
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
