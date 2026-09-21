import { useCallback } from "react";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { buildRowOrColumnSelection, Orientation } from "../lib/select-row-column";

interface Args {
  editor: Editor;
  orientation: Orientation;
  index: number;
  tableNode: ProseMirrorNode;
  tablePos: number;
}

/**
 * Restore focus to the editor after a table handle/cell menu closes.
 *
 * The grip/chevron menus are Mantine `<Menu>`s with `returnFocus: true`, and
 * their targets live in a floating/portaled layer OUTSIDE the editor's
 * contenteditable. After an action (delete row/column, insert, etc.) the menu
 * closes and Mantine returns focus to that outside target, so ProseMirror's
 * undo keymap never sees Ctrl+Z until the user clicks back into a cell.
 *
 * We defer with `requestAnimationFrame` so this runs AFTER Mantine's
 * returnFocus, and guard against stealing focus if the user intentionally
 * moved to another input/editable (e.g. the page title).
 */
export function refocusEditorAfterMenuClose(editor: Editor) {
  requestAnimationFrame(() => {
    if (editor.isDestroyed) return;
    const active = document.activeElement as HTMLElement | null;
    // Already inside the editor — nothing to do.
    if (active && editor.view.dom.contains(active)) return;
    // Respect a deliberate move to another field/editable.
    const tag = active?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      active?.isContentEditable
    ) {
      return;
    }
    editor.view.focus(); // pure DOM focus, no extra transaction
  });
}

export function useColumnRowMenuLifecycle({
  editor,
  orientation,
  index,
  tableNode,
  tablePos,
}: Args) {
  const onOpen = useCallback(() => {
    const selection = buildRowOrColumnSelection(
      editor.state,
      tableNode,
      tablePos,
      orientation,
      index,
    );
    const tr = editor.state.tr;
    if (selection) tr.setSelection(selection);
    editor.view.dispatch(tr);
    editor.commands.freezeHandles();
  }, [editor, orientation, index, tableNode, tablePos]);

  const onClose = useCallback(() => {
    editor.commands.unfreezeHandles();
    refocusEditorAfterMenuClose(editor);
  }, [editor]);

  return { onOpen, onClose };
}
