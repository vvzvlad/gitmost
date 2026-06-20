import { NodeViewContent, NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import classes from "./footnote.module.css";

/**
 * NodeView for the bottom footnotes container. Renders a visual separator and a
 * localized heading, then the editable list of definitions via NodeViewContent.
 */
export default function FootnotesListView(_props: NodeViewProps) {
  const { t } = useTranslation();

  return (
    <NodeViewWrapper>
      <div className={classes.list} contentEditable={false}>
        <div className={classes.listHeading}>{t("Footnotes")}</div>
      </div>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}
