import { EditorState, TextSelection, Transaction } from "@tiptap/pm/state";

// U+0301 COMBINING ACUTE ACCENT — a plain Unicode combining char inserted
// right after a vowel to render a Russian-style stress accent over it.
// It is stored as literal text (not a TipTap mark), so it survives HTML/
// Markdown export, full-text search and public share with zero server or
// converter changes.
export const STRESS_ACCENT = "́";

// True when a stress accent already sits immediately after the selection end
// (the single char following the selection). Used both for the toolbar
// active state and to decide the toggle direction.
export function hasStressAfterSelection(state: EditorState): boolean {
  const { to } = state.selection;
  const docSize = state.doc.content.size;
  // Clamp to the doc size so a selection at the very end never reads past it.
  const afterChar = state.doc.textBetween(to, Math.min(to + 1, docSize));
  return afterChar === STRESS_ACCENT;
}

// Build a single transaction that toggles the stress accent after the
// selection. One transaction => one undo step (Ctrl+Z reverts the toggle).
export function toggleStressAccent(state: EditorState): Transaction {
  const { from, to } = state.selection;
  const tr = state.tr;

  if (hasStressAfterSelection(state)) {
    // Toggle off: drop the accent that immediately follows the letter.
    tr.delete(to, to + 1);
  } else {
    // Toggle on: insertText inherits the marks at `to`, so the accent lands
    // in the same text node as the letter and renders over it even when the
    // letter is bold / italic / colored.
    tr.insertText(STRESS_ACCENT, to);
  }

  // Restore the original selection so the accented letter stays highlighted
  // and a re-click toggles the accent back off.
  tr.setSelection(TextSelection.create(tr.doc, from, to));
  return tr;
}
