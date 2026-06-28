import { Editor } from "@tiptap/react";
import { IconTextCaption } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useImageTextFieldControl } from "@/features/editor/components/common/use-image-text-field-control.tsx";

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

// Thin wrapper over the shared image text-field popover; see
// useImageTextFieldControl. The t("...") literals stay here so they remain
// statically extractable for i18n.
export function useCaptionControl({
  editor,
  nodeName,
  currentCaption,
}: UseCaptionControlArgs) {
  const { t } = useTranslation();
  return useImageTextFieldControl({
    editor,
    nodeName,
    currentValue: currentCaption,
    attrName: "caption",
    sanitize: sanitizeCaption,
    maxLength: CAPTION_MAX_LENGTH,
    icon: <IconTextCaption size={18} />,
    label: t("Caption"),
    description: t("Shown below the image."),
    placeholder: t("Add a caption"),
  });
}
