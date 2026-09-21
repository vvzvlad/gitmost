import { InputRule } from "@tiptap/core";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Typography } from "@tiptap/extension-typography";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

// Region restored by the latest undo — while it is intact, typography
// input rules overlapping it must not fire again.
interface UndoGuardRange {
  from: number;
  to: number;
}

// Exported for tests: the plugin key lets a test read the armed guard state,
// and the two pure helpers below are unit-tested directly.
export const undoGuardKey = new PluginKey<UndoGuardRange | null>(
  "typographyUndoGuard",
);

// prosemirror-history does not export its plugin key, so template-editor
// undo/redo is detected via the stable stringified key. Only one
// PluginKey("history") exists in the dependency tree, so "history$" is stable.
const HISTORY_META = "history$";

const isUndoRedoTransaction = (tr: Transaction): boolean => {
  if (tr.getMeta(HISTORY_META)) {
    return true;
  }
  // Read yjs undo/redo meta via the real ySyncPluginKey object (imported, not
  // a fragile stringified key), which y-tiptap sets on Y.UndoManager changes.
  const ySyncMeta = tr.getMeta(ySyncPluginKey) as
    | { isUndoRedoOperation?: boolean }
    | undefined;
  return !!ySyncMeta?.isUndoRedoOperation;
};

interface DocChange {
  from: number;
  oldTo: number;
  newTo: number;
}

// Compute the minimal changed region between two docs. yjs undo/redo (and any
// remote change) arrives as a whole-document replace step, so the transaction
// step maps are useless — diff the docs to recover the real minimal change.
// Returns null when the docs are identical.
export const findChangedRange = (
  oldState: EditorState,
  newState: EditorState,
): DocChange | null => {
  const start = oldState.doc.content.findDiffStart(newState.doc.content);
  const end = oldState.doc.content.findDiffEnd(newState.doc.content);
  if (start == null || end == null) {
    return null;
  }
  let { a: oldTo, b: newTo } = end;
  // findDiffEnd can report an end BEFORE the diff start when the changed text
  // abuts repeated content (insertion -> oldTo<start, deletion -> newTo<start).
  // Push both ends forward by the same delta so the range stays non-degenerate
  // (from <= oldTo and from <= newTo), matching ProseMirror's own diff bounds.
  const minTo = Math.min(oldTo, newTo);
  if (minTo < start) {
    const delta = start - minTo;
    oldTo += delta;
    newTo += delta;
  }
  return { from: start, oldTo, newTo };
};

// Map an armed guard range across a single document change described by a diff.
// Returns null when the change touches the guarded text itself (the restored
// substitution was edited, so the guard must be released).
export const mapRangeThroughChange = (
  range: UndoGuardRange,
  change: DocChange,
): UndoGuardRange | null => {
  // Strict intersection: an edit exactly at a guard boundary (e.g. the user
  // typing the suppressed space right after the restored text, or deleting it)
  // must NOT drop the guard.
  if (change.from < range.to && change.oldTo > range.from) {
    return null;
  }
  // Change fully before the guard: shift the guard by the length delta.
  if (change.oldTo <= range.from) {
    const delta = change.newTo - change.oldTo;
    return { from: range.from + delta, to: range.to + delta };
  }
  // Change fully after the guard: positions are unaffected.
  return range;
};

// Detect history/remote transactions that may arrive as a whole-document
// replace step: prosemirror-history undo/redo, or any yjs remote-origin change
// (isChangeOrigin is the canonical predicate already used across the app).
const isHistoryOrRemoteTransaction = (tr: Transaction): boolean =>
  !!tr.getMeta(HISTORY_META) || isChangeOrigin(tr);

export const CustomTypography = Typography.extend({
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: undoGuardKey,
        state: {
          init: () => null,
          apply(tr, prev, oldState, newState): UndoGuardRange | null {
            if (tr.docChanged && isHistoryOrRemoteTransaction(tr)) {
              const change = findChangedRange(oldState, newState);
              if (change == null) {
                // Attribute-only or otherwise content-neutral change: keep the
                // guard.
                return prev;
              }
              // Arm the guard only when the LOCAL user's undo/redo REPLACED text
              // (deleted + inserted) — the signature of reverting an input-rule
              // substitution. Pure insertions/deletions and remote peer edits
              // must not arm it.
              if (
                isUndoRedoTransaction(tr) &&
                change.oldTo > change.from &&
                change.newTo > change.from
              ) {
                return { from: change.from, to: change.newTo };
              }
              // Non-arming history/remote change: map the existing guard through
              // the real diff instead of the (whole-document) step map.
              if (!prev) {
                return null;
              }
              return mapRangeThroughChange(prev, change);
            }
            if (!prev) {
              return null;
            }
            if (!tr.docChanged) {
              return prev;
            }
            // Ordinary local edit: minimal step maps are accurate and cheap.
            let range: UndoGuardRange | null = prev;
            for (const stepMap of tr.mapping.maps) {
              const { from: rangeFrom, to: rangeTo } = range;
              let touched = false;
              stepMap.forEach((fromA, toA) => {
                if (fromA < rangeTo && toA > rangeFrom) {
                  touched = true;
                }
              });
              if (touched) {
                range = null;
                break;
              }
              range = {
                from: stepMap.map(rangeFrom, 1),
                to: stepMap.map(rangeTo, -1),
              };
            }
            return range && range.to > range.from ? range : null;
          },
        },
      }),
    ];
  },

  addInputRules() {
    // Wrap every typography rule: skip it when its match overlaps the text
    // just restored by undo, so an undone substitution is not re-applied.
    return (this.parent?.() ?? []).map(
      (rule) =>
        new InputRule({
          find: rule.find,
          undoable: rule.undoable,
          handler: (props) => {
            const guard = undoGuardKey.getState(props.state);
            if (
              guard &&
              props.range.from < guard.to &&
              props.range.to > guard.from
            ) {
              // Returning null skips this rule and lets the typed character
              // be inserted as plain text.
              return null;
            }
            return rule.handler(props);
          },
        }),
    );
  },
});
