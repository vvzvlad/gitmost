import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { undoDepth, redoDepth } from "@tiptap/pm/history";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

export interface ToolbarState {
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isStrike: boolean;
  isCode: boolean;
  isSubscript: boolean;
  isSuperscript: boolean;
  isBulletList: boolean;
  isOrderedList: boolean;
  isTaskList: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

// Undo/redo availability, computed WITHOUT `editor.can().undo()/.redo()`.
//
// `editor.can()` runs the command as a dry-run (building a throwaway state +
// transaction) — the most expensive work in this selector, and it ran on every
// keystroke (and every REMOTE keystroke under collaboration). Instead we read
// the history stack depth directly, which is a cheap plugin-state lookup and
// mirrors exactly what the undo/redo commands themselves check:
//
//  - Collaboration (Yjs): the yjs UndoManager's undo/redo stack lengths — the
//    same `undoStack.length === 0` / `redoStack.length === 0` guard the
//    Collaboration extension's undo/redo commands use.
//  - Plain history (templates / non-collab): prosemirror-history's undoDepth /
//    redoDepth, which back the UndoRedo extension.
//
// When neither history backend is installed (the pre-sync static editor —
// mainExtensions only, undoRedo disabled), both fall through to 0 -> false,
// matching the previous `safeCan` behavior.
// Reads the Yjs UndoManager's undo/redo availability from its stack lengths.
//
// `undoStack` / `redoStack` are PRIVATE y-undo / yjs internals, so we touch them
// defensively: a yjs or y-undo upgrade that renames or restructures these fields
// must not silently mis-drive the toolbar buttons (nor throw on `.length` of
// `undefined`). We only trust them when they are actually arrays; otherwise this
// returns null and the caller falls back to a safe default. The pin-test in
// use-toolbar-state.test.ts asserts the current library shape, so an upgrade that
// breaks this contract fails loudly there instead of failing silently in the UI.
export function yHistoryAvailability(
  undoManager: unknown,
): { canUndo: boolean; canRedo: boolean } | null {
  if (!undoManager || typeof undoManager !== "object") return null;
  const { undoStack, redoStack } = undoManager as {
    undoStack?: unknown;
    redoStack?: unknown;
  };
  if (!Array.isArray(undoStack) || !Array.isArray(redoStack)) return null;
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}

function historyAvailability(editor: Editor): {
  canUndo: boolean;
  canRedo: boolean;
} {
  const state = editor.state;

  // Collaboration history (Yjs) takes precedence when present.
  const yState = yUndoPluginKey.getState(state) as
    | { undoManager?: unknown }
    | undefined;
  const yAvail = yHistoryAvailability(yState?.undoManager);
  if (yAvail) return yAvail;

  // Plain prosemirror-history (returns 0 when the history plugin is absent).
  // This is also the safe default when a Yjs UndoManager is present but its
  // private stack shape is no longer recognized (yHistoryAvailability -> null).
  return {
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
  };
}

export function useToolbarState(editor: Editor | null): ToolbarState | null {
  return useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) return null;
      const { canUndo, canRedo } = historyAvailability(ctx.editor);
      return {
        isBold: ctx.editor.isActive("bold"),
        isItalic: ctx.editor.isActive("italic"),
        isUnderline: ctx.editor.isActive("underline"),
        isStrike: ctx.editor.isActive("strike"),
        isCode: ctx.editor.isActive("code"),
        isSubscript: ctx.editor.isActive("subscript"),
        isSuperscript: ctx.editor.isActive("superscript"),
        isBulletList: ctx.editor.isActive("bulletList"),
        isOrderedList: ctx.editor.isActive("orderedList"),
        isTaskList: ctx.editor.isActive("taskList"),
        canUndo,
        canRedo,
      };
    },
  });
}
