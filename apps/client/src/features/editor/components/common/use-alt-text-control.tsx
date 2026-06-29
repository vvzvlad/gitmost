import { Editor } from "@tiptap/react";
import { IconAlt } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useImageTextFieldControl } from "@/features/editor/components/common/use-image-text-field-control.tsx";

const ALT_MAX_LENGTH = 300;

function sanitizeAlt(value: string): string {
  return value
    .replace(/[\\\[\]!]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type UseAltTextControlArgs = {
  editor: Editor;
  nodeName: string;
  currentAlt: string;
};

// Thin wrapper over the shared image text-field popover; see
// useImageTextFieldControl. The t("...") literals stay here so they remain
// statically extractable for i18n.
export function useAltTextControl({
  editor,
  nodeName,
  currentAlt,
}: UseAltTextControlArgs) {
  const { t } = useTranslation();
  return useImageTextFieldControl({
    editor,
    nodeName,
    currentValue: currentAlt,
    attrName: "alt",
    sanitize: sanitizeAlt,
    maxLength: ALT_MAX_LENGTH,
    icon: <IconAlt size={18} />,
    label: t("Alt text"),
    description: t("Describe this for accessibility."),
    placeholder: t("Add a description"),
  });
}
