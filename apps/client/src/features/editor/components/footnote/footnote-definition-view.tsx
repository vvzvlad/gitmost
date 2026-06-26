import { NodeViewContent, NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { getFootnoteNumber, getFootnoteRefCount } from "@docmost/editor-ext";
import classes from "./footnote.module.css";

/**
 * A 0-based backlink index -> its lowercase letter label (0 -> "a", 25 -> "z",
 * 26 -> "aa", ...), matching the Pandoc/Wikipedia "↩ a b c" convention.
 */
export function backlinkLabel(index: number): string {
  let out = "";
  let x = index;
  while (x >= 0) {
    out = String.fromCharCode(97 + (x % 26)) + out;
    x = Math.floor(x / 26) - 1;
  }
  return out;
}

/**
 * NodeView for a single footnote definition: a decorative number marker, the
 * editable content (NodeViewContent), and a "↩" back-link to its reference.
 * The number is derived from the document (not stored).
 *
 * After #166 a footnote can be referenced more than once (one number, one
 * definition, N forward links). When it is, the back-link becomes a row of
 * per-occurrence links — ↩ a b c … — each scrolling to its own reference (#168);
 * a single-reference footnote keeps the plain ↩.
 */
export default function FootnoteDefinitionView(props: NodeViewProps) {
  const { node, editor } = props;
  const { t } = useTranslation();
  const id = node.attrs.id as string;

  // Read the cached number/ref-count from the numbering plugin (computed once
  // per doc change) rather than recomputing the whole map on every render.
  const number = getFootnoteNumber(editor.state, id) ?? "?";
  const refCount = getFootnoteRefCount(editor.state, id);

  const jumpTo = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    editor.commands.scrollToReference(id, index);
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
      {refCount > 1 ? (
        // Multiple references -> ↩ followed by one lettered link per occurrence.
        <span
          className={classes.backLinks}
          contentEditable={false}
          role="group"
          aria-label={t("Back to references")}
        >
          <span className={classes.backLinkArrow} aria-hidden="true">
            ↩
          </span>
          {Array.from({ length: refCount }, (_, i) => (
            <span
              key={i}
              className={classes.backLink}
              onClick={(e) => jumpTo(e, i)}
              role="button"
              aria-label={t("Back to reference {{label}}", {
                label: backlinkLabel(i),
              })}
              title={t("Back to reference {{label}}", {
                label: backlinkLabel(i),
              })}
            >
              {backlinkLabel(i)}
            </span>
          ))}
        </span>
      ) : (
        // Single reference -> the plain ↩ (unchanged behavior).
        <span
          className={classes.backLink}
          contentEditable={false}
          onClick={(e) => jumpTo(e, 0)}
          role="button"
          aria-label={t("Back to reference")}
          title={t("Back to reference")}
        >
          ↩
        </span>
      )}
    </NodeViewWrapper>
  );
}
