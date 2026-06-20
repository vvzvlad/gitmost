import { useEffect, useRef, useState, useCallback } from "react";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";
import {
  FOOTNOTE_DEFINITION_NAME,
  getFootnoteNumber,
} from "@docmost/editor-ext";
import { ActionIcon } from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";
import classes from "./footnote.module.css";

/**
 * Read the plain text of the footnote definition with `id` directly from the
 * editor state. No sub-editor: the popover is read-only.
 */
function getDefinitionText(editor: NodeViewProps["editor"], id: string): string {
  let text = "";
  editor.state.doc.descendants((node) => {
    if (
      node.type.name === FOOTNOTE_DEFINITION_NAME &&
      node.attrs.id === id
    ) {
      text = node.textContent;
      return false;
    }
    return undefined;
  });
  return text;
}

export default function FootnoteReferenceView(props: NodeViewProps) {
  const { node, editor, selected } = props;
  const { t } = useTranslation();
  const id = node.attrs.id as string;

  const anchorRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  // Number is derived (not stored). Read it from the numbering plugin's cached
  // map (computed once per doc change) instead of walking the whole document on
  // every render — recomputing per NodeView per render was O(n^2) per keystroke.
  const number = getFootnoteNumber(editor.state, id) ?? "?";
  const defText = open ? getDefinitionText(editor, id) : "";

  const position = useCallback(() => {
    const anchor = anchorRef.current;
    const popup = popoverRef.current;
    if (!anchor || !popup) return;
    computePosition(anchor, popup, {
      placement: "top",
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      popup.style.left = `${x}px`;
      popup.style.top = `${y}px`;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const popup = popoverRef.current;
    if (!anchor || !popup) return;

    const cleanup = autoUpdate(anchor, popup, position);

    const onPointerDown = (e: PointerEvent) => {
      if (
        popup.contains(e.target as Node) ||
        anchor.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);

    return () => {
      cleanup();
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, position]);

  const handleGoTo = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    editor.commands.scrollToFootnote(id);
  };

  return (
    <NodeViewWrapper as="span" style={{ display: "inline" }}>
      <sup
        ref={(el) => (anchorRef.current = el)}
        data-footnote-ref=""
        data-id={id}
        className={`${classes.reference} ${selected ? classes.selected : ""}`}
        onMouseEnter={() => setOpen(true)}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        // The decoration sets --footnote-number; provide a fallback inline.
        style={{ ["--footnote-number" as any]: `"${number}"` }}
        aria-label={t("Footnote {{number}}", { number })}
        role="button"
      />
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className={classes.popover}
            role="tooltip"
            onMouseLeave={() => setOpen(false)}
          >
            <div className={classes.popoverHeader}>
              <span className={classes.popoverNumber}>
                {t("Footnote {{number}}", { number })}
              </span>
              <ActionIcon
                variant="subtle"
                size="sm"
                color="gray"
                onClick={handleGoTo}
                aria-label={t("Go to footnote")}
              >
                <IconArrowDown size={16} />
              </ActionIcon>
            </div>
            <div className={classes.popoverBody}>
              {defText || t("Empty footnote")}
            </div>
          </div>,
          document.body,
        )}
    </NodeViewWrapper>
  );
}
