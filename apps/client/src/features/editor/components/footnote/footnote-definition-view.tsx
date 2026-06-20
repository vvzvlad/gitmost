import { NodeViewContent, NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { computeFootnoteNumbers } from "@docmost/editor-ext";
import classes from "./footnote.module.css";

/**
 * NodeView for a single footnote definition: a decorative number marker, the
 * editable content (NodeViewContent), and a "↩" back-link to its reference.
 * The number is derived from the document (not stored).
 */
export default function FootnoteDefinitionView(props: NodeViewProps) {
  const { node, editor } = props;
  const { t } = useTranslation();
  const id = node.attrs.id as string;

  const numbers = computeFootnoteNumbers(editor.state.doc);
  const number = numbers.get(id) ?? "?";

  const handleBack = (e: React.MouseEvent) => {
    e.preventDefault();
    editor.commands.scrollToReference(id);
  };

  return (
    <NodeViewWrapper
      data-footnote-def=""
      data-id={id}
      className={classes.definition}
      style={{ ["--footnote-number" as any]: `"${number}"` }}
    >
      <span className={classes.definitionMarker} contentEditable={false}>
        {number}.
      </span>
      <NodeViewContent className={classes.definitionContent} />
      <span
        className={classes.backLink}
        contentEditable={false}
        onClick={handleBack}
        role="button"
        aria-label={t("Back to reference")}
        title={t("Back to reference")}
      >
        ↩
      </span>
    </NodeViewWrapper>
  );
}
