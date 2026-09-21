import type { EditorState } from "@tiptap/pm/state";

export interface EditorSelectionContext {
  text: string;
  truncated?: boolean;
  blockIds?: string[];
  before?: string;
  after?: string;
}

// Client-side caps. The server re-caps every field independently (defence in
// depth — the payload is attacker-controllable), so these only keep the wire
// small for the common case.
const TEXT_CAP = 2000;
const CONTEXT_CHARS = 160;
const MAX_BLOCK_IDS = 20;

// Pure: takes an EditorState so it is unit-testable with a headless editor.
// Snapshots the user's current selection into the wire shape carried inside
// openPage — plain text + the ids of the blocks it covers + a little surrounding
// context. Returns null when nothing meaningful is selected.
//
// Deliberately does NOT emit the ProseMirror positions (from/to): they rot the
// instant the document changes and the server tools address content by block id
// + text (getNode / editPageText find-replace), never by position.
export function getEditorSelectionContext(
  state: EditorState,
): EditorSelectionContext | null {
  const { selection, doc } = state;
  // An empty selection (incl. the default caret-at-start of a fresh editor) is
  // never a "this"/"here" — bail before reading any text.
  if (selection.empty) return null;

  const { from, to } = selection;

  let text = doc.textBetween(from, to, "\n");
  let truncated = false;
  if (text.length > TEXT_CAP) {
    text = text.slice(0, TEXT_CAP);
    truncated = true;
  }
  // A selection spanning only non-text nodes (e.g. an image) trims to empty ->
  // treat as no selection.
  if (text.trim().length === 0) return null;

  // Ids of every block the selection covers, deduped and capped. These bridge
  // the plain-text selection to the server tools (getNode / editPageText).
  const blockIds: string[] = [];
  doc.nodesBetween(from, to, (node) => {
    const id = node.isBlock ? node.attrs?.id : undefined;
    if (typeof id === "string" && id.length > 0 && !blockIds.includes(id)) {
      blockIds.push(id);
    }
  });

  // ~160 chars of plain text on each side, clamped to the document bounds, so
  // editPageText can disambiguate a duplicate of the selected text.
  const before = doc.textBetween(Math.max(0, from - CONTEXT_CHARS), from, "\n");
  const after = doc.textBetween(
    to,
    Math.min(doc.content.size, to + CONTEXT_CHARS),
    "\n",
  );

  const result: EditorSelectionContext = { text };
  if (truncated) result.truncated = true;
  if (blockIds.length > 0) result.blockIds = blockIds.slice(0, MAX_BLOCK_IDS);
  if (before.length > 0) result.before = before;
  if (after.length > 0) result.after = after;
  return result;
}
