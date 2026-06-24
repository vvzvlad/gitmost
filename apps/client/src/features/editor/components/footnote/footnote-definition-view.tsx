import { NodeViewContent, NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { getFootnoteNumber } from "@docmost/editor-ext";
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

  // Read the cached number from the numbering plugin (computed once per doc
  // change) rather than recomputing the whole map on every render.
  const number = getFootnoteNumber(editor.state, id) ?? "?";

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
      {/* #146: contentDOM MUST be the first child — a non-editable marker before
          it makes click hit-testing snap the caret above. Content first; the
          marker + back-link follow in DOM and are placed left/right via CSS
          flex `order`. The second #146 mitigation lives in
          editor-paste-handler.tsx (reflowAfterPaste). */}
      <NodeViewContent className={classes.definitionContent} />
      <span
        className={classes.definitionMarker}
        contentEditable={false}
        aria-hidden="true"
      >
        {number}.
      </span>
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
