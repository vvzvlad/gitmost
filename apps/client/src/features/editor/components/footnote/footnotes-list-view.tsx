import { NodeViewContent, NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import classes from "./footnote.module.css";

/**
 * NodeView for the bottom footnotes container: the editable list of definitions
 * (NodeViewContent) plus a visual separator + localized heading.
 *
 * #146: the editable NodeViewContent MUST be the FIRST child in the DOM. A
 * non-editable block rendered before it (the old separator + heading) makes the
 * browser's click hit-testing (posAtCoords → caretRangeFromPoint) miss the
 * contentDOM and snap the caret to the previous node (several lines above, into
 * the body). So content goes first; the heading is rendered AFTER it and lifted
 * back above visually with CSS flex `order` (the separator border lives on the
 * flex container itself).
 *
 * The second #146 mitigation lives in editor-paste-handler.tsx (reflowAfterPaste).
 */
export default function FootnotesListView(_props: NodeViewProps) {
  const { t } = useTranslation();

  return (
    // role/aria-label preserve the section label for AT: the visible heading
    // below is now aria-hidden, so without these the "Footnotes" label would be
    // lost to a screen reader (WCAG 1.3.2 — DOM order has heading after content).
    <NodeViewWrapper
      className={classes.list}
      role="group"
      aria-label={t("Footnotes")}
    >
      <NodeViewContent />
      <div
        className={classes.listHeading}
        contentEditable={false}
        aria-hidden="true"
      >
        {t("Footnotes")}
      </div>
    </NodeViewWrapper>
  );
}
